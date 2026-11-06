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
 *
 ********************************************************************************/

import Config from '@cocreate/config';
import { dotNotationToObject, sortData } from "@cocreate/utils";
import GetOrganization from './getOrganization.js';
import { getDriver, registerDriver, drivers } from './getDriver.js';
import { includesFileArray, isPlatformArray } from './routing.js';
import { getStorage as resolveStorage } from './getStorage.js';
import { promptBootstrapStorage } from './bootstrapStorage.js';
import {
    defaultOrganizationStorageFallback,
    resolveOrganizationStorageFallback
} from './storageFallback.js';

let server = null;
/**
 *
 * @public
 * @environment server
 */
let config = null;
let initialized = false;
let wsManager = null;
let getOrganization = null;
let crudServer = null;

function normalizeOrganizationStorageFallback() {
    let configuredStorageFallback = config.organizationStorageFallback;
    if (typeof configuredStorageFallback === 'string') {
        try {
            configuredStorageFallback = JSON.parse(configuredStorageFallback);
        } catch { }
    }
    config.organizationStorageFallback = configuredStorageFallback ?? {
        ...defaultOrganizationStorageFallback
    };
}

/**
 * Merges module configuration and scoped platform database overrides over the
 * bootstrap configuration loaded by Config.prompt().
 * @public
 * @environment server
 */
export async function loadCrudConfig() {
    const systemConfig = Config.get('crud');
    const databaseConfig = await Config.query({
        type: 'crud',
        organization_id: config.organization_id,
        server: server?.host,
        cluster: server?.cluster_id
    }, crudServer);

    if (systemConfig) dotNotationToObject(systemConfig, config);
    if (databaseConfig) dotNotationToObject(databaseConfig, config);
    normalizeOrganizationStorageFallback();

    return config;
}


/**
 * Initializes the CrudServer module, prompts/loads configuration, and binds socket listeners.
 * Drivers are resolved strictly on demand during send() query dispatch.
 *
 * @param {Object} Server - CoCreateServer instance context
 * @returns {Promise<Object>} Initialized CrudServer module API instance
 * @public
 * @environment server
 */
export async function init(Server) {
    if (initialized) return crudServer;
    initialized = true;

    server = Server || null;

    if (server && server.wsManager) {
        wsManager = server.wsManager;
    }

    config = await Config.prompt({
        'organization_id': { prompt: 'Enter your organization_id: ' },
        'host': { prompt: 'Enter your host: ' }
    });
    config.storage = await promptBootstrapStorage(Config);
    const primaryStorage = config.storage;
    normalizeOrganizationStorageFallback();

    if (!config.organization_id) throw new Error('Missing bootstrap organization_id.');

    // Resolve the bootstrap driver before the server persists lifecycle state
    // or forks workers. Other configured providers remain lazy-loaded.
    await getDriver(primaryStorage.provider);

    crudServer = {
        config,
        send,
        getStorage,
        /**
         *
 * @public
 * @environment server
 */
        getDriver,
        /**
         *
 * @public
 * @environment server
 */
        registerDriver,
        /**
         *
 * @public
 * @environment server
 */
        drivers
    };

    getOrganization = GetOrganization.init(crudServer);
    crudServer.getOrganization = getOrganization;

    await loadCrudConfig();

    const bindSocketListeners = () => {
        if (!wsManager && server && server.wsManager) {
            wsManager = server.wsManager;
        }

        if (wsManager) {
            const types = ['storage', 'database', 'array', 'index', 'object'];
            const methods = ['create', 'read', 'update', 'delete'];

            for (let i = 0; i < types.length; i++) {
                for (let j = 0; j < methods.length; j++) {
                    const action = types[i] + '.' + methods[j];
                    wsManager.on(action, (data) => send(data));
                }
            }
        } else {
            setTimeout(bindSocketListeners, 500);
        }
    };

    bindSocketListeners();

    return crudServer;
}

/**
 * Main CRUD payload dispatcher.
 * Resolves organization context, determines target storage driver, and executes query.
 *
 * @param {Object} data - Request query payload
 * @returns {Promise<Object>} Processed response payload
 * @public
 * @environment server
 */
async function send(data) {
    return new Promise(async (resolve) => {
        try {
            if (!data.organization_id || !config) {
                data.error = 'Missing an organization_id';
                return resolve(data);
            }

            if (
                !data.host &&
                !data.socket &&
                data.organization_id === config.organization_id &&
                !isPlatformArray(data.array)
            ) {
                data.host = config.host;
            }

            let organization = await getOrganization(data);

            if (organization.error) {
                return resolve(organization);
            }

            if (!data['timeStamp']) {
                data['timeStamp'] = new Date().toISOString();
            }

            if (organization.host) {
                let host = organization.host;
                let hostname = data.socket ? data.socket.host : data.host;

                for (let i = 0; i < host.length; i++) {
                    if (host[i].name === hostname) {
                        if (host[i].storage) data.storage = host[i].storage;
                        if (!data.database && host[i].database) data.database = host[i].database;
                        if (host[i].array) data.array = host[i].array;
                        break;
                    }
                }
            }

            // A host-specific database is honored above. Otherwise, keep each
            // organization in its own database and avoid MongoDB's URI/test
            // database fallback.
            if (!data.database) {
                data.database = data.organization_id;
            }

            const filterStartingIndex =
                data.filter?.startingIndex ?? data.filter?.index ?? 0;

            const storageNames = data.storage
                ? (Array.isArray(data.storage) ? data.storage : [data.storage])
                : [undefined];

            for (let i = 0; i < storageNames.length; i++) {
                let storage = await getStorage(
                    organization,
                    data.organization_id,
                    storageNames[i]
                );

                if (!storage) {
                    const fallback = includesFileArray(data.array)
                        ? {
                            storage: undefined,
                            database: data.organization_id
                        }
                        : resolveOrganizationStorageFallback(
                            config,
                            data.organization_id
                        );
                    if (!fallback) {
                        throw new Error(
                            `Storage is not configured for organization "${data.organization_id}" and organization storage fallback is disabled`
                        );
                    }

                    data.database = fallback.database;
                    storage = await getStorage(
                        config,
                        config.organization_id,
                        fallback.storage
                    );
                    if (!storage) throw new Error("Server storage is not configured");
                }

                if (storage && storage.provider) {
                    data.storageConfig = storage;

                    // Each storage name resolves to one API record; the driver reads its own credentials.
                    const driver = await getDriver(storage.provider);

                    if (driver && typeof driver.send === 'function') {
                        data = await driver.send(data);
                    } else {
                        throw new Error(`Storage driver for provider "${storage.provider}" does not implement a send() method.`);
                    }
                }
            }

            applyFilterMetadata(data, filterStartingIndex);

            delete data.storageConfig;

            if (data.socket && server?.send) {
                if (data.organization_id === config.organization_id && data.socket.organization_id !== data.organization_id) {
                    server.send({ ...data, socket: undefined });
                    data.organization_id = data.socket.organization_id;
                }

                server.send(data);
                process.emit('crud-event', data);
            }
            resolve(data);
        } catch (error) {
            if (data.socket && server?.send) {
                if (typeof errorHandler === 'function') {
                    errorHandler(data, error);
                } else {
                    data.error = error.message || error;
                }
                server.send(data);
            }
            resolve(data);
        }
    });
}

/**
 * Resolves the organization bootstrap storage or a named tenant API storage.
 * @public
 * @environment server
 */
async function getStorage(organization, organizationId, name) {
    return await resolveStorage({
        organization,
        organizationId,
        name
    });
}

/**
 *
 * @public
 * @environment server
 */
export function getFilterCount(filter) {
    if (!Array.isArray(filter?.storages) || !filter.storages.length)
        return;

    const datasets = new Map();

    for (const metadata of filter.storages) {
        if (
            metadata?.database === undefined ||
            metadata?.array === undefined ||
            typeof metadata.count !== "number" ||
            !Number.isFinite(metadata.count)
        ) continue;

        const key = JSON.stringify([metadata.database, metadata.array]);
        const count = datasets.get(key);

        if (count === undefined || metadata.count > count)
            datasets.set(key, metadata.count);
    }

    let count = 0;
    for (const datasetCount of datasets.values()) count += datasetCount;
    return count;
}

function applyFilterMetadata(data, startingIndex) {
    if (!data.filter) return;

    const type = data.method.split(".")[0];
    if (!Array.isArray(data[type])) return;

    if (data.filter.sort?.length)
        data[type] = sortData(data[type], data.filter.sort);

    const count = getFilterCount(data.filter);
    if (count !== undefined) data.filter.count = count;

    data.filter.startingIndex = startingIndex;
    data.filter.index = startingIndex + data[type].length;
}

export default {
    init,
    config,
    send,
    getStorage,
    getDriver,
    registerDriver,
    drivers
};

/**
 * High-performance, multi-tenant server-side CRUD orchestration engine supporting parallel multi-database writing, real-time sync, and tenant-isolated data routing across 20+ database engines.
 *
 * @module crud-server
 * @environment server
 */
