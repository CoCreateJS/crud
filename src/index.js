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
import { sortData } from "@cocreate/utils";
import GetOrganization from './getOrganization.js';
import { getDriver, registerDriver, drivers } from './getDriver.js';
import { isPlatformArray } from './routing.js';
import { getStorage as resolveStorage } from './getStorage.js';

let server = null;
let config = null;
let initialized = false;
let wsManager = null;
let getOrganization = null;
let crudServer = null;

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

/**
 * Initializes the CrudServer module, prompts/loads configuration, and binds socket listeners.
 * Drivers are resolved strictly on demand during send() query dispatch.
 * 
 * @param {Object} Server - CoCreateServer instance context
 * @returns {Promise<Object>} Initialized CrudServer module API instance
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
        'host': { prompt: 'Enter your host: ' },
        'storage': {
            prompt: 'Enter a friendly name for the new storage (e.g., primary): ',
            variable: 'name'
        },
        'storage.{{name}}.provider': {
            prompt: 'Enter the storage provider (e.g., mongodb): '
        },
        'storage.{{name}}.url': {
            prompt: 'Enter the storage connection url: '
        }
    });

    let primaryStorage;
    let firstStorageKey;

    if (config.storage) {
        if (typeof config.storage === 'string') {
            config.storage = JSON.parse(config.storage);
        }

        if (Array.isArray(config.storage)) {
            primaryStorage = config.storage[0];
            firstStorageKey = primaryStorage?.name;
        } else if (config.storage.provider || config.storage.url) {
            primaryStorage = config.storage;
            firstStorageKey = config.storage.name;
        } else {
            const storageKeys = Object.keys(config.storage);
            if (storageKeys.length > 0) {
                firstStorageKey = storageKeys[0];
                primaryStorage = config.storage[firstStorageKey];
            }
        }
    }

    if (!primaryStorage?.url) {
        console.log(`[@cocreate/crud-server] Could not find a connection url in your primary storage: "${firstStorageKey || 'default'}"`);
    }

    if (!primaryStorage?.url || !primaryStorage?.provider || !config.organization_id) {
        process.exit(1);
    }

    // Resolve the bootstrap driver before the server persists lifecycle state
    // or forks workers. Other configured providers remain lazy-loaded.
    await getDriver(primaryStorage.provider);

    crudServer = {
        config,
        send,
        getStorage,
        getDriver,
        registerDriver,
        drivers
    };

    getOrganization = GetOrganization.init(crudServer);
    crudServer.getOrganization = getOrganization;

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
                    data.database = data.organization_id;
                    storage = await getStorage(config, config.organization_id);
                    if (!storage) throw new Error("Server storage is not configured");
                }

                if (storage && storage.provider) {
                    const storageUrls = Array.isArray(storage.url)
                        ? storage.url
                        : [storage.url];

                    for (let j = 0; j < storageUrls.length; j++) {
                        data['storageConfig'] = {
                            name: storage.name,
                            provider: storage.provider,
                            url: storageUrls[j],
                            authToken: storage.authToken
                        };

                        // Dynamically resolve the driver from memory or a packaged storages directory.
                        const driver = await getDriver(storage.provider);

                        if (driver && typeof driver.send === 'function') {
                            data = await driver.send(data);
                        } else {
                            throw new Error(`Storage driver for provider "${storage.provider}" does not implement a send() method.`);
                        }
                    }

                }
            }

            applyFilterMetadata(data, filterStartingIndex);

            delete data.storageConfig;

            if (data.socket && wsManager) {
                if (data.organization_id === config.organization_id && data.socket.organization_id !== data.organization_id) {
                    wsManager.send({
                        config: {
                            organization_id: config.organization_id,
                        }
                    }, { ...data });
                    data.organization_id = data.socket.organization_id;
                }

                wsManager.send(data);
                process.emit('crud-event', data);
            }
            resolve(data);
        } catch (error) {
            if (data.socket && wsManager) {
                if (typeof errorHandler === 'function') {
                    errorHandler(data, error);
                } else {
                    data.error = error.message || error;
                }
                wsManager.send(data);
            }
            resolve(data);
        }
    });
}

/**
 * Resolves the organization bootstrap storage or a named tenant API storage.
 */
async function getStorage(organization, organizationId, name) {
    return await resolveStorage({
        organization,
        organizationId,
        name
    });
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
