import { Worker } from "node:worker_threads";
import fs from "node:fs/promises";
import path from "node:path";

class StorageManager {
    constructor() {
        this.workers = new Map();          // provider -> { worker, activeOrgs: Set, idleTimer: Timeout, pendingTaskIds: Set }
        this.pendingTasks = new Map();     // taskId -> { resolve, reject, timeoutTimer, provider }
        this.fetchingBundles = new Map();  // provider -> Promise<string>
        this.taskCounter = 0;
        this.cdnBaseUrl = process.env.COCREATE_CDN_URL || "https://cdn.cocreate.app/adapters";
        this.cacheDir = path.resolve(process.cwd(), ".storage-cache");
        this.IDLE_GRACE_PERIOD = 5 * 60 * 1000; // 5 minutes
        this.TASK_TIMEOUT = 30 * 1000;          // 30 seconds safety timeout

        this.providerMap = new Map([
            // --- MongoDB Wire Protocol Compatible ---
            ["cosmosdb", "mongodb"],
            ["documentdb", "mongodb"],
            ["ferretdb", "mongodb"],
            ["oracledb", "mongodb"],

            // --- PostgreSQL Wire Protocol Compatible ---
            ["amazon-redshift", "postgresql"],
            ["redshift", "postgresql"],
            ["cockroachdb", "postgresql"],
            ["cockroach", "postgresql"],
            ["timescaledb", "postgresql"],
            ["timescale", "postgresql"],
            ["yugabytedb", "postgresql"],
            ["yugabyte", "postgresql"],
            ["auroradb-pg", "postgresql"],

            // --- MySQL Wire Protocol / Vitess Compatible ---
            ["planetscale", "mysql"],
            ["tidb", "mysql"],
            ["mariadb", "mysql"],
            ["auroradb", "mysql"],

            // --- SQLite / LibSQL Engine Compatible ---
            ["turso", "sqlite"],
            ["libsql", "sqlite"],
            ["rqlite", "sqlite"],
            ["dqlite", "sqlite"]
        ]);
    }

    /**
     * Sanitizes and resolves provider identifiers.
     * Prevents path-traversal attacks.
     */
    resolveProvider(provider) {
        if (!provider || typeof provider !== "string") {
            throw new Error("Invalid provider argument");
        }
        
        // 1. Sanitize input to allow only alphanumeric characters, hyphens, and underscores
        const sanitized = provider.toLowerCase().trim().replace(/[^a-z0-9_-]/g, "");
        if (!sanitized) {
            throw new Error("Invalid provider name format");
        }

        // 2. Resolve mapped dialect or return sanitized name
        return this.providerMap.get(sanitized) || sanitized;
    }

    /**
     * Resolves local bundle path. Deduplicates concurrent fetch calls.
     */
    async getOrFetchBundlePath(provider) {
        const targetProvider = this.resolveProvider(provider);
        await fs.mkdir(this.cacheDir, { recursive: true });
        const localPath = path.join(this.cacheDir, `${targetProvider}.bundle.js`);

        try {
            await fs.access(localPath);
            return localPath;
        } catch {
            // Deduplicate concurrent download promises
            if (this.fetchingBundles.has(targetProvider)) {
                return await this.fetchingBundles.get(targetProvider);
            }

            const downloadPromise = (async () => {
                try {
                    console.log(`[@cocreate/crud-server] Downloading missing driver for "${targetProvider}"...`);
                    const response = await fetch(`${this.cdnBaseUrl}/${targetProvider}.bundle.js`);

                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status} - ${response.statusText}`);
                    }

                    const code = await response.text();
                    await fs.writeFile(localPath, code, "utf8");
                    console.log(`[@cocreate/crud-server] Cached driver bundle for "${targetProvider}"`);
                    return localPath;
                } finally {
                    this.fetchingBundles.delete(targetProvider);
                }
            })();

            this.fetchingBundles.set(targetProvider, downloadPromise);
            return await downloadPromise;
        }
    }

    /**
     * Spawns or retrieves a Worker thread with complete error lifecycle handling.
     */
    async getWorker(provider, organization_id) {
        const targetProvider = this.resolveProvider(provider);
        let entry = this.workers.get(targetProvider);

        if (!entry) {
            const bundlePath = await this.getOrFetchBundlePath(targetProvider);
            const worker = new Worker(bundlePath);
            const pendingTaskIds = new Set();

            worker.on("message", (msg) => {
                const { id, status, result, error } = msg;

                if (this.pendingTasks.has(id)) {
                    const task = this.pendingTasks.get(id);
                    clearTimeout(task.timeoutTimer);
                    this.pendingTasks.delete(id);
                    pendingTaskIds.delete(id);

                    if (status) {
                        task.resolve(result);
                    } else {
                        task.reject(new Error(error || "Worker execution failed"));
                    }
                }
            });

            const handleWorkerFailure = (err) => {
                console.error(`[@cocreate/crud-server] Worker crash [Provider: ${targetProvider}]:`, err);
                
                // Fail all pending tasks for this crashed worker immediately
                for (const taskId of pendingTaskIds) {
                    if (this.pendingTasks.has(taskId)) {
                        const task = this.pendingTasks.get(taskId);
                        clearTimeout(task.timeoutTimer);
                        task.reject(new Error(`Worker for "${targetProvider}" crashed: ${err?.message || err}`));
                        this.pendingTasks.delete(taskId);
                    }
                }
                pendingTaskIds.clear();
                this.workers.delete(targetProvider);
            };

            worker.on("error", handleWorkerFailure);
            worker.on("exit", (code) => {
                if (code !== 0) {
                    handleWorkerFailure(new Error(`Worker exited with code ${code}`));
                } else {
                    this.workers.delete(targetProvider);
                }
            });

            entry = {
                worker,
                activeOrgs: new Set(),
                idleTimer: null,
                pendingTaskIds
            };

            this.workers.set(targetProvider, entry);
        }

        if (organization_id) {
            entry.activeOrgs.add(organization_id);
        }

        if (entry.idleTimer) {
            clearTimeout(entry.idleTimer);
            entry.idleTimer = null;
        }

        return entry.worker;
    }

    /**
     * Dispatches a CRUD request to worker with safety timeout.
     */
    async send(provider, data) {
        const targetProvider = this.resolveProvider(provider);
        const worker = await this.getWorker(targetProvider, data.organization_id);
        const taskId = ++this.taskCounter;
        const entry = this.workers.get(targetProvider);

        return new Promise((resolve, reject) => {
            const timeoutTimer = setTimeout(() => {
                if (this.pendingTasks.has(taskId)) {
                    this.pendingTasks.delete(taskId);
                    if (entry) entry.pendingTaskIds.delete(taskId);
                    reject(new Error(`Database query timeout after ${this.TASK_TIMEOUT / 1000}s [Provider: ${targetProvider}]`));
                }
            }, this.TASK_TIMEOUT);

            this.pendingTasks.set(taskId, { resolve, reject, timeoutTimer, provider: targetProvider });
            if (entry) entry.pendingTaskIds.add(taskId);

            worker.postMessage({ id: taskId, action: "EXECUTE", data });
        });
    }

    removeOrganization(organization_id) {
        for (const [provider, entry] of this.workers.entries()) {
            if (entry.activeOrgs.has(organization_id)) {
                entry.activeOrgs.delete(organization_id);

                entry.worker.postMessage({
                    action: "TEARDOWN_ORG",
                    data: { organization_id }
                });

                if (entry.activeOrgs.size === 0 && !entry.idleTimer) {
                    entry.idleTimer = setTimeout(() => {
                        console.log(`[@cocreate/crud-server] Grace period expired for "${provider}". Terminating worker thread...`);
                        entry.worker.terminate();
                        this.workers.delete(provider);
                    }, this.IDLE_GRACE_PERIOD);
                }
            }
        }
    }
}

export default new StorageManager();