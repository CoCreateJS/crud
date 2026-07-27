/********************************************************************************
 * Copyright (C) 2026 CoCreate and Contributors.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 ********************************************************************************/

import path from "node:path";
import fs from "node:fs";
import { Worker } from "node:worker_threads";
import Config from "@cocreate/config";

const STORAGE_DIR = path.resolve(process.cwd(), ".storages");

/**
 * Identifier of the Primary Database worker/driver.
 * Designated as the very first database driver initialized by the system.
 * It will NEVER be terminated or garbage-collected during organization teardown.
 */
let primaryDatabaseKey = null;

/**
 * Shared database worker pool for active driver isolates.
 * Map<driverKey, Worker>
 */
const activeWorkers = new Map();

/**
 * Active organization reference counts per database driver.
 * Map<driverKey, Set<organizationId>>
 */
const driverOrgRegistry = new Map();

/**
 * Global map of in-flight query requests.
 * Map<requestId, { resolve, reject, timer, organizationId, driverKey }>
 */
const pendingRequests = new Map();

/**
 * Cached server config document resolved via Config.query.
 */
let cachedServerConfig = null;

/**
 * Default execution timeout for database query worker execution (in milliseconds).
 */
const DEFAULT_QUERY_TIMEOUT_MS = 30000;

/**
 * Universal inline worker script code template.
 * Wraps ANY pure database adapter (disk file or on-demand string) in parentPort IPC logic.
 */
const UNIVERSAL_WORKER_HARNESS_CODE = `
const { parentPort, workerData } = require("node:worker_threads");
const path = require("node:path");

let driverModule = null;

async function initDriver() {
    try {
        if (workerData.driverPath) {
            driverModule = require(path.resolve(workerData.driverPath));
        } else if (workerData.scriptString) {
            const evalFactory = new Function("exports", "module", "require", "__filename", "__dirname", workerData.scriptString);
            const moduleObj = { exports: {} };
            evalFactory(moduleObj.exports, moduleObj, require, "dynamic_driver.js", __dirname);
            driverModule = moduleObj.exports;
        }

        if (typeof driverModule === "function") {
            driverModule = new driverModule();
        } else if (driverModule && driverModule.default) {
            driverModule = typeof driverModule.default === "function" ? new driverModule.default() : driverModule.default;
        }

        if (!driverModule) {
            throw new Error("Failed to initialize driver module inside worker isolate.");
        }
    } catch (err) {
        console.error("[WorkerHarness] Failed to initialize driver:", err);
    }
}

const initPromise = initDriver();

parentPort.on("message", async (msg) => {
    if (!msg || !msg.id) return;

    try {
        await initPromise;

        // 1. Organization Deletion Lifecycle Handling
        if (msg.action === "orgDeleted" || msg.action === "TEARDOWN_ORG") {
            let deleteResult = null;
            if (driverModule && typeof driverModule.orgDeleted === "function") {
                deleteResult = await driverModule.orgDeleted(msg.data);
            } else if (driverModule && typeof driverModule.send === "function") {
                deleteResult = await driverModule.send({ action: "orgDeleted", ...msg.data });
            }

            const orgId = msg.data?.organization_id;
            if (orgId && typeof process !== "undefined" && process.emit) {
                process.emit("orgDeleted", orgId);
                process.emit("orgDeletedComplete", orgId);
            }

            parentPort.postMessage({ id: msg.id, status: true, action: "orgDeletedCompleted", result: deleteResult || { tornDown: true } });
            return;
        }

        // 2. Query Operation Execution
        let result;
        if (driverModule && typeof driverModule.send === "function") {
            result = await driverModule.send(msg.data);
        } else if (driverModule && typeof driverModule.execute === "function") {
            result = await driverModule.execute(msg.data);
        } else if (typeof driverModule === "function") {
            result = await driverModule(msg.data);
        } else {
            throw new Error("Driver module does not implement a callable 'send' or 'execute' method.");
        }

        parentPort.postMessage({ id: msg.id, status: true, result });
    } catch (err) {
        parentPort.postMessage({ id: msg.id, status: false, error: err.message || String(err) });
    }
});
`;

/**
 * Helper to register an organization's active connection to a specific driver.
 * Sets the first registered driver as the system's Primary Database if not already set.
 */
function registerOrgDriverMapping(driverKey, organizationId) {
    if (!primaryDatabaseKey) {
        primaryDatabaseKey = driverKey;
        console.log(`[StorageManager] Primary Database designated as: "${primaryDatabaseKey}"`);
    }

    if (!driverOrgRegistry.has(driverKey)) {
        driverOrgRegistry.set(driverKey, new Set());
    }
    driverOrgRegistry.get(driverKey).add(organizationId);
}

/**
 * Process event listener for organization deletion or disconnect events.
 * - Teardowns tenant connections inside shared worker isolates and awaits completion.
 * - Cancels in-flight requests for the organization.
 * - Terminates idle worker isolates when no active organizations remain (except primary DB).
 */
async function handleOrgDeleted(payload) {
    const organizationId = typeof payload === "string" ? payload : payload?.organization_id || payload?.id;
    if (!organizationId) return;

    console.log(`[StorageManager] Processing organization deletion lifecycle for Org "${organizationId}"...`);

    // 1. Dispatch TEARDOWN_ORG / orgDeleted to active database worker isolates and await completion
    const teardownPromises = [];
    for (const [driverKey, worker] of activeWorkers.entries()) {
        const orgSet = driverOrgRegistry.get(driverKey);
        if (orgSet && orgSet.has(organizationId)) {
            teardownPromises.push(
                sendToWorker(worker, driverKey, organizationId, { organization_id: organizationId }, "orgDeleted", 10000)
                    .then(() => {
                        console.log(`[StorageManager] Database deletion completed for driver "${driverKey}" on Org "${organizationId}".`);
                    })
                    .catch((err) => {
                        console.error(`[StorageManager] Error during worker teardown for driver "${driverKey}":`, err.message);
                    })
            );
        }
    }

    await Promise.allSettled(teardownPromises);

    // 2. Reject lingering in-flight requests for this organization
    for (const [reqId, deferred] of pendingRequests.entries()) {
        if (deferred.organizationId === organizationId) {
            clearTimeout(deferred.timer);
            deferred.reject(new Error(`Organization "${organizationId}" deleted while query was in flight.`));
            pendingRequests.delete(reqId);
        }
    }

    // 3. Remove organization from driver registry and teardown idle non-primary workers
    for (const [driverKey, orgSet] of driverOrgRegistry.entries()) {
        orgSet.delete(organizationId);

        if (orgSet.size === 0) {
            if (driverKey !== primaryDatabaseKey) {
                console.log(`[StorageManager] Removing worker isolate for "${driverKey}" (0 active orgs remaining, non-primary).`);
                if (activeWorkers.has(driverKey)) {
                    const workerToTerminate = activeWorkers.get(driverKey);
                    try {
                        await workerToTerminate.terminate();
                    } catch (err) {
                        console.warn(`[StorageManager] Error terminating idle worker for "${driverKey}":`, err.message);
                    }
                    activeWorkers.delete(driverKey);
                }
                driverOrgRegistry.delete(driverKey);
            } else {
                console.log(`[StorageManager] Preserving primary database driver worker isolate "${driverKey}" (first registered).`);
            }
        }
    }
}

// Register process event listeners for organization deletion
process.on("orgDeleted", handleOrgDeleted);
process.on("organizationDeleted", handleOrgDeleted);

/**
 * Fetches a database driver script from host endpoint.
 * Emits usage telemetry event for ingress tracking.
 *
 * @param {string} host - Endpoint host address
 * @param {string} scriptPath - Script path route
 * @param {string} organizationId - Target organization ID
 * @returns {Promise<string>} Driver JavaScript code
 */
async function fetchDriverScript(host, scriptPath, organizationId) {
    let baseUrl = host.trim();
    if (!/^https?:\/\//i.test(baseUrl)) {
        baseUrl = `https://${baseUrl}`;
    }

    const fullUrl = new URL(scriptPath, baseUrl).href;
    console.log(`[StorageManager] Fetching driver script on demand from host: ${fullUrl}`);

    const response = await fetch(fullUrl, {
        headers: { "User-Agent": "CoCreate-Driver-Loader/1.0" }
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch driver script from ${fullUrl} (Status: ${response.status} ${response.statusText})`);
    }

    const scriptText = await response.text();

    // Emit telemetry event for driver file fetch (ingress)
    process.emit("usage", {
        type: "ingress",
        data: scriptText,
        organization_id: organizationId
    });

    return scriptText;
}

/**
 * Spawns or retrieves an active Worker thread isolate for a database driver.
 *
 * @param {string} driverKey - Driver provider key
 * @param {Object} options - Worker setup options ({ driverPath, scriptString })
 * @returns {Worker} Active Worker thread instance
 */
function getOrCreateWorker(driverKey, options = {}) {
    if (activeWorkers.has(driverKey)) {
        return activeWorkers.get(driverKey);
    }

    console.log(`[StorageManager] Spawning worker isolate for driver "${driverKey}"`);

    const worker = new Worker(UNIVERSAL_WORKER_HARNESS_CODE, {
        eval: true,
        workerData: {
            driverKey,
            driverPath: options.driverPath || null,
            scriptString: options.scriptString || null
        },
        resourceLimits: options.scriptString ? { maxOldGenerationSizeMb: 128 } : undefined
    });

    // Handle incoming messages from worker
    worker.on("message", (message) => {
        if (!message || !message.id) return;

        const deferred = pendingRequests.get(message.id);
        if (!deferred) return;

        clearTimeout(deferred.timer);
        pendingRequests.delete(message.id);

        if (message.status) {
            deferred.resolve(message.result);
        } else {
            deferred.reject(new Error(message.error || "Unknown worker execution failure."));
        }
    });

    // Handle worker thread errors
    worker.on("error", (err) => {
        console.error(`[StorageManager] Worker thread crash for driver "${driverKey}":`, err);

        for (const [reqId, deferred] of pendingRequests.entries()) {
            if (deferred.driverKey === driverKey) {
                clearTimeout(deferred.timer);
                deferred.reject(new Error(`Database worker isolate crashed: ${err.message}`));
                pendingRequests.delete(reqId);
            }
        }

        activeWorkers.delete(driverKey);
    });

    // Handle worker thread exits
    worker.on("exit", (code) => {
        if (code !== 0) {
            console.warn(`[StorageManager] Worker isolate for "${driverKey}" exited unexpectedly with code ${code}.`);
        }

        for (const [reqId, deferred] of pendingRequests.entries()) {
            if (deferred.driverKey === driverKey) {
                clearTimeout(deferred.timer);
                deferred.reject(new Error(`Database worker isolate exited unexpectedly.`));
                pendingRequests.delete(reqId);
            }
        }

        activeWorkers.delete(driverKey);
    });

    activeWorkers.set(driverKey, worker);
    return worker;
}

/**
 * Sends a query payload message to a worker isolate thread and awaits completion.
 */
function sendToWorker(worker, driverKey, organizationId, payloadData, action = "EXECUTE", timeoutMs = DEFAULT_QUERY_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

        const timer = setTimeout(() => {
            if (pendingRequests.has(requestId)) {
                pendingRequests.delete(requestId);
                reject(new Error(`Storage query timeout exceeded (${timeoutMs}ms) for driver operation.`));
            }
        }, timeoutMs);

        pendingRequests.set(requestId, {
            resolve,
            reject,
            timer,
            organizationId,
            driverKey
        });

        worker.postMessage({
            id: requestId,
            action,
            data: payloadData
        });
    });
}

/**
 * Resolves or spawns a database driver strategy for a given query payload.
 *
 * Resolution Order:
 * 1. Payload `storageConfig.driverPath` (or `storage.driverPath`) explicit override.
 *    -> If provided, skips `.storage/` lookup and skips `Config.query`.
 * 2. Active Worker thread isolate check for the driver.
 * 3. Inspect `.storage/${provider}.js` on local disk.
 *    -> If found, loads driver isolate from `.storage/${provider}.js`.
 * 4. Fallback to `Config.query({ type: "storage", organization_id })`.
 *    -> Resolves remote host/path, fetches driver script, persists to `.storage/${provider}.js`, and spawns worker.
 */
async function resolveDriver(data) {
    const storageConfig = data.storageConfig || data.storage || {};
    const driverKey = (storageConfig.provider || storageConfig.driver || "").trim().toLowerCase();
    const organizationId = data.organization_id;

    if (!driverKey) {
        throw new Error("Missing required 'provider' parameter in storage request configuration.");
    }

    if (!organizationId) {
        throw new Error("Missing required 'organization_id' parameter in storage request payload.");
    }

    // Register active mapping for tenant organization
    registerOrgDriverMapping(driverKey, organizationId);

    let worker;

    // =========================================================================
    // STEP 1: Explicit Driver Path Override inside request storage object
    // =========================================================================
    const explicitDriverPath = storageConfig.driverPath || data.driverPath;
    if (explicitDriverPath) {
        console.log(`[StorageManager] Custom driverPath provided in request payload for "${driverKey}": ${explicitDriverPath}`);
        worker = getOrCreateWorker(driverKey, { driverPath: explicitDriverPath });
        return { worker, driverKey, organizationId };
    }

    // =========================================================================
    // STEP 2: Active Worker Thread Isolate Check
    // =========================================================================
    if (activeWorkers.has(driverKey)) {
        worker = activeWorkers.get(driverKey);
        return { worker, driverKey, organizationId };
    }

    // =========================================================================
    // STEP 3: Local .storage/{provider}.js Directory Disk Inspection
    // =========================================================================
    const driverFileName = `${driverKey}.js`;
    const localStoragePath = path.join(STORAGE_DIR, driverFileName);

    if (fs.existsSync(localStoragePath)) {
        console.log(`[StorageManager] Found driver "${driverKey}" in .storage directory: ${localStoragePath}`);
        worker = getOrCreateWorker(driverKey, { driverPath: localStoragePath });
        return { worker, driverKey, organizationId };
    }

    // =========================================================================
    // STEP 4: Query Config.query & Persist Fetched Driver to .storage/
    // =========================================================================
    console.log(`[StorageManager] Driver "${driverKey}" not in .storage/. Resolving via Config.query...`);

    if (!cachedServerConfig) {
        cachedServerConfig = await Config.query({
            type: "storage",
            organization_id: organizationId
        });
    }

    const driverConfig = cachedServerConfig.drivers?.[driverKey] || cachedServerConfig[driverKey] || {};
    const scriptPath = driverConfig.path || driverConfig.driverPath || driverKey;
    const host = driverConfig.host || cachedServerConfig.host || data.host;

    if (!host) {
        throw new Error(`Unable to resolve host endpoint for provider "${driverKey}". Driver file not present in .storage/ and host not defined in servers_config.`);
    }

    const scriptString = await fetchDriverScript(host, scriptPath, organizationId);

    // Persist fetched driver script to .storage/{driverKey}.js for subsequent boots
    try {
        if (!fs.existsSync(STORAGE_DIR)) {
            fs.mkdirSync(STORAGE_DIR, { recursive: true });
        }
        fs.writeFileSync(localStoragePath, scriptString, "utf8");
        console.log(`[StorageManager] Persisted fetched driver "${driverKey}" to local storage: ${localStoragePath}`);
        worker = getOrCreateWorker(driverKey, { driverPath: localStoragePath });
    } catch (writeErr) {
        console.warn(`[StorageManager] Could not write driver "${driverKey}" to .storage/ disk. Falling back to RAM isolate:`, writeErr.message);
        worker = getOrCreateWorker(driverKey, { scriptString });
    }

    return { worker, driverKey, organizationId };
}

/**
 * Main Storage Strategy Executor.
 *
 * @param {Object} data - Incoming storage request payload
 * @returns {Promise<Object>} Execution result
 */
export async function send(data) {
    try {
        // Emit telemetry event for request egress
        process.emit("usage", {
            type: "egress",
            data,
            organization_id: data?.organization_id
        });

        const resolution = await resolveDriver(data);

        // Execute query on persistent worker isolate thread
        const result = await sendToWorker(
            resolution.worker,
            resolution.driverKey,
            resolution.organizationId,
            data
        );

        // Emit telemetry event for response ingress
        process.emit("usage", {
            type: "ingress",
            data: result,
            organization_id: data?.organization_id
        });

        return result;
    } catch (error) {
        console.error(`[StorageManager] Strategy execution error for Org ${data?.organization_id}:`, error);

        const errorDetail = {
            message: error.message || error,
            storage: data?.storageConfig?.provider || data?.storage?.provider || "unknown"
        };

        if (Array.isArray(data?.error)) {
            data.error.push(errorDetail);
        } else if (data) {
            data.error = [errorDetail];
        }

        return { status: false, error: data?.error || [errorDetail] };
    }
}

/**
 * Object wrapper export allowing invocation as `storageManager.send(data)`.
 */
export const storageManager = { send };
export default storageManager;