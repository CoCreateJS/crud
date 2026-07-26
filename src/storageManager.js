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
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Direct whitelist mapping for core database drivers.
 * Maps clean provider names to their corresponding compiled bundle file paths inside dist/
 */
const DRIVER_WHITELIST = new Map([
    ["amazon-redshift", "amazon-redshift.bundle.js"],
    ["auroradb", "auroradb.bundle.js"],
    ["cockroachdb", "cockroachdb.bundle.js"],
    ["cosmosdb", "cosmosdb.bundle.js"],
    ["documentdb", "documentdb.bundle.js"],
    ["dqlite", "dqlite.bundle.js"],
    ["dynamodb", "dynamodb.bundle.js"],
    ["ferretdb", "ferretdb.bundle.js"],
    ["firestore", "firestore.bundle.js"],
    ["mariadb", "mariadb.bundle.js"],
    ["mongodb", "mongodb.bundle.js"],
    ["mysql", "mysql.bundle.js"],
    ["oracledb", "oracledb.bundle.js"],
    ["planetscale", "planetscale.bundle.js"],
    ["postgres", "postgresql.bundle.js"],
    ["postgresql", "postgresql.bundle.js"],
    ["qdrant", "qdrant.bundle.js"],
    ["rqlite", "rqlite.bundle.js"],
    ["sqlite", "sqlite.bundle.js"],
    ["tidb", "tidb.bundle.js"],
    ["timescaledb", "timescaledb.bundle.js"],
    ["turso", "sqlite.bundle.js"],
    ["yugabytedb", "yugabytedb.bundle.js"]
]);

/**
 * Active organization pool and custom driver memory cache.
 * Keyed by organization_id:
 * {
 *   [organization_id]: {
 *      workers: Map<driverKey, Worker>,
 *      pendingRequests: Map<requestId, { resolve, reject, timer }>,
 *      customDriverScripts: Map<driverKey, string>
 *   }
 * }
 */
const activeOrgRegistries = new Map();

/**
 * Default execution timeout for database query worker execution (in milliseconds).
 */
const DEFAULT_QUERY_TIMEOUT_MS = 30000;

/**
 * Process event listener for organization deletion or disconnect.
 * Automatically notifies worker thread isolates to perform cleanup,
 * terminates worker threads after a grace period, and purges RAM caches.
 */
process.on("orgDeleted", (organizationId) => {
    if (!activeOrgRegistries.has(organizationId)) return;

    console.log(`[StorageManager] Org disconnected event received. Initiating grace teardown for Org: ${organizationId}`);

    const orgData = activeOrgRegistries.get(organizationId);
    if (!orgData) return;

    // 1. Send TEARDOWN_ORG command to all active worker isolates for this org
    if (orgData.workers) {
        for (const [driverKey, worker] of orgData.workers.entries()) {
            try {
                const teardownReqId = `teardown_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
                worker.postMessage({
                    id: teardownReqId,
                    action: "TEARDOWN_ORG",
                    data: { organization_id: organizationId }
                });
            } catch (err) {
                console.error(`[StorageManager] Failed to issue teardown message to worker "${driverKey}":`, err);
            }
        }
    }

    // 2. Schedule hard process cleanup after a 5-second grace period
    setTimeout(async () => {
        if (!activeOrgRegistries.has(organizationId)) return;

        // Reject any lingering pending requests for this org
        if (orgData.pendingRequests) {
            for (const [reqId, deferred] of orgData.pendingRequests.entries()) {
                clearTimeout(deferred.timer);
                deferred.reject(new Error(`Organization "${organizationId}" disconnected while query was in flight.`));
            }
            orgData.pendingRequests.clear();
        }

        // Hard terminate active worker threads
        if (orgData.workers) {
            for (const [driverKey, worker] of orgData.workers.entries()) {
                try {
                    console.log(`[StorageManager] Terminating worker isolate thread for driver "${driverKey}" in Org: ${organizationId}`);
                    await worker.terminate();
                } catch (err) {
                    console.error(`[StorageManager] Error terminating worker for ${driverKey}:`, err);
                }
            }
            orgData.workers.clear();
        }

        // Wipe custom driver scripts held in RAM
        if (orgData.customDriverScripts) {
            orgData.customDriverScripts.clear();
        }

        // Remove org entry from registry completely
        activeOrgRegistries.delete(organizationId);
        console.log(`[StorageManager] In-memory registry & worker pools fully purged for Org: ${organizationId}`);
    }, 5000);
});

/**
 * Fetches a custom driver JavaScript bundle directly into RAM without writing to local disk.
 *
 * @param {string} targetUrl - Full URL to the custom driver script
 * @returns {Promise<string>} The fetched JavaScript code string
 */
async function fetchCustomDriverScript(targetUrl) {
    const fullUrl = targetUrl;

    // SSRF Safeguard: Block private loopback / RFC1918 internal IP ranges
    if (/^(https?:\/\/)?(127\.0\.0\.1|localhost|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/i.test(fullUrl)) {
        throw new Error(`SSRF Guardrail Violation: Custom driver location URL "${fullUrl}" resolves to a restricted private address.`);
    }

    console.log(`[StorageManager] Fetching un-cached custom driver into RAM from: ${fullUrl}`);

    const response = await fetch(fullUrl, {
        headers: { "User-Agent": "CoCreate-Custom-Driver-Loader/1.0" }
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch custom driver from ${fullUrl} (Status: ${response.status} ${response.statusText})`);
    }

    const scriptText = await response.text();
    return scriptText;
}

/**
 * Ensures an active memory registry structure exists for the given organization.
 *
 * @param {string} organizationId
 * @returns {Object} Organization memory bucket
 */
function getOrCreateOrgRegistry(organizationId) {
    if (!activeOrgRegistries.has(organizationId)) {
        activeOrgRegistries.set(organizationId, {
            workers: new Map(),
            pendingRequests: new Map(),
            customDriverScripts: new Map()
        });
    }
    return activeOrgRegistries.get(organizationId);
}

/**
 * Resolves or spawns a dedicated Worker thread for a given organization and driver bundle.
 *
 * @param {string} organizationId - Organization identifier
 * @param {string} cleanKey - Normalized driver provider key
 * @param {string} bundleFileName - Webpack bundle filename in dist/
 * @returns {Worker} Active Worker thread instance
 */
function getOrCreateWorker(organizationId, cleanKey, bundleFileName) {
    const orgRegistry = getOrCreateOrgRegistry(organizationId);

    if (orgRegistry.workers.has(cleanKey)) {
        return orgRegistry.workers.get(cleanKey);
    }

    // Resolve path to bundled driver worker file
    const bundlePath = path.resolve(__dirname, "../dist", bundleFileName);

    if (!fs.existsSync(bundlePath)) {
        throw new Error(`Compiled worker bundle missing for driver "${cleanKey}" at expected location: ${bundlePath}. Ensure @cocreate/storage-bundler build has executed.`);
    }

    console.log(`[StorageManager] Spawning isolated Worker thread for driver "${cleanKey}" (Org: ${organizationId})`);

    const worker = new Worker(bundlePath, {
        workerData: { organizationId, driverKey: cleanKey }
    });

    // Handle messages returned from the worker thread
    worker.on("message", (message) => {
        if (!message || !message.id) return;

        const deferred = orgRegistry.pendingRequests.get(message.id);
        if (!deferred) return;

        // Clear request timeout timer
        clearTimeout(deferred.timer);
        orgRegistry.pendingRequests.delete(message.id);

        if (message.status) {
            deferred.resolve(message.result);
        } else {
            deferred.reject(new Error(message.error || "Unknown worker execution failure."));
        }
    });

    // Handle unexpected worker errors
    worker.on("error", (err) => {
        console.error(`[StorageManager] Worker thread crash for driver "${cleanKey}" (Org: ${organizationId}):`, err);

        // Reject all pending requests assigned to this worker
        for (const [reqId, deferred] of orgRegistry.pendingRequests.entries()) {
            clearTimeout(deferred.timer);
            deferred.reject(new Error(`Worker isolate crashed: ${err.message}`));
        }

        orgRegistry.pendingRequests.clear();
        orgRegistry.workers.delete(cleanKey);
    });

    // Handle worker unexpected exit
    worker.on("exit", (code) => {
        if (code !== 0) {
            console.warn(`[StorageManager] Worker isolate for "${cleanKey}" exited unexpectedly with code ${code}. Cleaning up registry.`);
        }
        orgRegistry.workers.delete(cleanKey);
    });

    orgRegistry.workers.set(cleanKey, worker);
    return worker;
}

/**
 * Sends a structured query request message to an isolated worker thread and awaits result.
 *
 * @param {Worker} worker - Worker thread handle
 * @param {string} organizationId - Organization identifier
 * @param {Object} payloadData - Database CRUD query payload
 * @param {number} [timeoutMs] - Optional execution timeout limit
 * @returns {Promise<Object>} Execution result payload
 */
function sendToWorker(worker, organizationId, payloadData, timeoutMs = DEFAULT_QUERY_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const orgRegistry = getOrCreateOrgRegistry(organizationId);

        const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

        const timer = setTimeout(() => {
            if (orgRegistry.pendingRequests.has(requestId)) {
                orgRegistry.pendingRequests.delete(requestId);
                reject(new Error(`Storage query timeout exceeded (${timeoutMs}ms) for driver operation.`));
            }
        }, timeoutMs);

        // Track pending response deferred promise
        orgRegistry.pendingRequests.set(requestId, { resolve, reject, timer });

        // Dispatch request to worker thread isolate
        worker.postMessage({
            id: requestId,
            action: "EXECUTE",
            data: payloadData
        });
    });
}

/**
 * Executes a custom driver script stored in RAM inside an in-memory evaluation sandbox.
 *
 * @param {string} scriptString - JavaScript code held in memory
 * @param {Object} queryData - Input CRUD payload
 * @returns {Promise<Object>} Query result
 */
async function executeCustomInRAM(scriptString, queryData) {
    return new Promise((resolve, reject) => {
        try {
            // Evaluates code inside an isolated async function scope without touching host disk
            const evalFactory = new Function(
                "queryData",
                `
                return (async () => {
                    ${scriptString}
                    if (typeof adapter !== 'undefined' && typeof adapter.send === 'function') {
                        return await adapter.send(queryData);
                    }
                    if (typeof execute === 'function') {
                        return await execute(queryData);
                    }
                    throw new Error("Custom driver script does not export an 'adapter.send' function or an 'execute' handler.");
                })();
                `
            );

            evalFactory(queryData)
                .then((result) => resolve(result))
                .catch((err) => reject(err));
        } catch (err) {
            reject(err);
        }
    });
}

/**
 * Resolves a database driver strategy for a given organization request.
 * - Whitelisted drivers are routed to isolated Worker thread pools running pre-bundled code.
 * - Non-whitelisted custom drivers fetch remote JS strings directly into RAM without disk persistence.
 *
 * @param {Object} data - Request payload containing driver/provider details
 * @returns {Promise<Object>} Resolved driver strategy metadata and handle
 */
async function resolveDriver(data) {
    const driverKey = (data.provider || data.driver || data.storage || "").trim();
    const organizationId = data.organization_id;

    if (!driverKey) {
        throw new Error("Missing required 'provider' or 'driver' parameter in storage request payload.");
    }

    if (!organizationId) {
        throw new Error("Missing required 'organization_id' parameter in storage request payload.");
    }

    const orgRegistry = getOrCreateOrgRegistry(organizationId);

    // Normalize driver key (case-insensitive and strip optional '@cocreate/' scope)
    const cleanKey = driverKey.toLowerCase().replace(/^@cocreate\//, "");

    // =========================================================================
    // CASE A: Whitelisted Native Core Driver (Worker Thread Isolate)
    // =========================================================================
    if (DRIVER_WHITELIST.has(cleanKey)) {
        const bundleFileName = DRIVER_WHITELIST.get(cleanKey);
        const worker = getOrCreateWorker(organizationId, cleanKey, bundleFileName);

        return {
            isWhitelisted: true,
            type: "worker_isolate",
            worker,
            organizationId
        };
    }

    // =========================================================================
    // CASE B: Un-whitelisted Custom Driver (Fetch Provider Path into RAM)
    // =========================================================================
    let scriptString = orgRegistry.customDriverScripts.get(driverKey);

    if (!scriptString) {
        let fetchUrl = driverKey;

        // If explicit location/path fields are passed, construct full URL
        if (data.driverLocation) {
            fetchUrl = new URL(data.driverPath || "", data.driverLocation).href;
        } else if (!/^https?:\/\//i.test(fetchUrl)) {
            throw new Error(`Custom provider "${driverKey}" is not whitelisted and is not a valid HTTP/HTTPS URL.`);
        }

        // Fetch raw script string into RAM (NEVER written to disk)
        scriptString = await fetchCustomDriverScript(fetchUrl);

        // Cache purely in memory for the lifetime of the connected organization
        orgRegistry.customDriverScripts.set(driverKey, scriptString);
    }

    return {
        isWhitelisted: false,
        type: "custom_ram",
        driverKey,
        scriptString
    };
}

/**
 * Main Storage Strategy Executor.
 * Receives incoming CRUD requests, resolves the targeted database driver (whitelisted vs custom),
 * and routes execution accordingly.
 *
 * @param {Object} data - Incoming query and database payload
 * @returns {Promise<Object>} Execution result payload
 */
export async function executeStorageStrategy(data) {
    try {
        const resolution = await resolveDriver(data);

        // Emit telemetry event for monitoring resource utilization
        process.emit("usage", {
            type: "storage_exec",
            provider: data.provider || data.driver,
            organization_id: data.organization_id
        });

        // 1. Native Whitelisted Driver Execution inside Worker Isolate
        if (resolution.isWhitelisted && resolution.type === "worker_isolate") {
            return await sendToWorker(resolution.worker, resolution.organizationId, data);
        }

        // 2. Custom Driver Execution in Ephemeral Isolate Context (RAM Only)
        if (!resolution.isWhitelisted && resolution.scriptString) {
            return await executeCustomInRAM(resolution.scriptString, data);
        }

        throw new Error(`Unable to execute strategy for driver: ${data.provider || data.driver}`);
    } catch (error) {
        console.error(`[StorageManager] Strategy execution error for Org ${data.organization_id}:`, error);

        const errorDetail = {
            message: error.message || error,
            storage: data.provider || data.driver || "unknown"
        };

        if (Array.isArray(data.error)) {
            data.error.push(errorDetail);
        } else {
            data.error = [errorDetail];
        }

        return { status: false, error: data.error };
    }
}

export {
    DRIVER_WHITELIST,
    resolveDriver,
    activeOrgRegistries
};