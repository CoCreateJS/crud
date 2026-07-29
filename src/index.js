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

import path from 'node:path';
import Config from '@cocreate/config';
import { ObjectId, sortData } from "@cocreate/utils";
import GetOrganizationModule, { getOrganization } from './getOrganization.js';
import MongoDB from '@cocreate/mongodb';

const drivers = new Map(); // In-memory runtime cache for loaded storage driver instances
let config = null;
let initialized = false;  
let wsManager = null;

/**
 * Returns the active server configuration object.
 * @returns {Object|null} Server runtime configuration.
 */
export function getConfig() {
    return config;
}

/**
 * Explicitly registers a pre-imported or custom storage driver instance into the runtime cache.
 * 
 * @param {string} provider - Storage provider name (e.g., 'mongodb')
 * @param {Object|Function} driver - Driver module, instance, or class constructor
 */
export function registerDriver(provider, driver) {
    if (!provider || !driver) return;
    
    let instance = driver;
    if (typeof driver === 'function') {
        try {
            instance = new driver();
        } catch (e) {
            // Keep pure function or module if constructor fails
        }
    }
    drivers.set(provider.toLowerCase(), instance);
    console.log(`[@cocreate/crud-server] Registered static driver for provider "${provider}"`);
}

// Register default MongoDB driver instance into the runtime map
registerDriver('mongodb', MongoDB);

const crudServer = {
    init,
    send,
    getConfig,
    getOrganization,
    getDriver,
    registerDriver,
    drivers // Exposed driver registry scope
};

// Initialize getOrganization with the crudServer instance context
GetOrganizationModule.init(crudServer);

export { getOrganization, GetOrganizationModule };

/**
 * Resolves and caches database drivers dynamically or from static attachments.
 * Priority:
 *  1. In-memory `drivers` registry Map
 *  2. Direct property attachment on CrudServer context (e.g., `crudServer.mongodb`)
 *  3. Dynamic filesystem import from `.storages/${provider}.js`
 * 
 * @param {string} provider - Storage provider name (e.g. 'mongodb')
 * @returns {Promise<Object>} Resolved storage driver instance
 */
export async function getDriver(provider) {
    if (!provider) {
        throw new Error('[@cocreate/crud-server] Provider name must be provided to getDriver()');
    }

    const key = provider.toLowerCase();

    // 1. Check in-memory driver registry (statically imported or previously cached)
    if (drivers.has(key)) {
        return drivers.get(key);
    }

    // 2. Check if driver is directly attached as a property on crudServer (e.g., crudServer.mongodb or crudServer.MongoDB)
    const attachedDriver = crudServer[key] || crudServer[provider];
    if (attachedDriver) {
        let instance = attachedDriver;
        if (typeof instance === 'function') {
            try {
                instance = new instance();
            } catch (e) {
                // Keep as pure function or object
            }
        }
        drivers.set(key, instance);
        console.log(`[@cocreate/crud-server] Resolved driver "${provider}" from CrudServer scope attachment.`);
        return instance;
    }

    // 3. Fallback: Dynamically import from .storages/${provider}.js
    try {
        const driverPath = path.resolve(process.cwd(), '.storages', `${provider}.js`);
        const module = await import(driverPath);
        
        let driver = module.default || module;
        if (typeof driver === 'function') {
            try {
                driver = new driver();
            } catch (e) {
                // Keep pure function if constructor fails
            }
        }

        drivers.set(key, driver);
        console.log(`[@cocreate/crud-server] Loaded and cached driver for provider "${provider}"`);
        return driver;
    } catch (err) {
        console.error(`[@cocreate/crud-server] Failed to resolve driver for provider "${provider}":`, err.message);
        throw err;
    }
}

/**
 * Initializes the CrudServer module, prompts for configuration, and binds socket listeners.
 * 
 * @param {Object} Server - CoCreateServer instance context
 * @returns {Promise<Object>} Initialized CrudServer module instance
 */
export async function init(Server) {
    if (initialized) return crudServer;
    initialized = true;

    if (Server && Server.wsManager) {
        wsManager = Server.wsManager;
    }

    config = await Config.prompt({
        'organization_id': { prompt: 'Enter your organization_id: ' },
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

    let storageUrl;
    let firstStorageKey;

    if (config.storage) {
        if (typeof config.storage === 'string') {
            config.storage = JSON.parse(config.storage);
        }
        
        const storageKeys = Object.keys(config.storage);
        if (storageKeys.length > 0) {
            firstStorageKey = storageKeys[0];
            storageUrl = config.storage[firstStorageKey].url;
        }
    }

    if (!storageUrl) {
        console.log(`[@cocreate/crud-server] Could not find a connection url in your primary storage: "${firstStorageKey || 'default'}"`);
    }

    if (!storageUrl || !config.organization_id) {
        process.exit(1);
    }

    const bindSocketListeners = () => {
        if (!wsManager && Server && Server.wsManager) {
            wsManager = Server.wsManager;
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
export async function send(data) {
    return new Promise(async (resolve) => {
        try {
            if (!data.organization_id || !config) {
                data.error = 'Missing an organization_id';
                return resolve(data);
            }

            let organization = await getOrganization(data);

            if (organization.error) {
                return resolve(organization);
            }

            let storages = organization.storage;
            if (!storages) {
                return resolve({ serverStorage: false, error: 'A storage url could not be found' });
            }

            if (!data['timeStamp']) {
                data['timeStamp'] = new Date().toISOString();
            }

            if (data.array) {
                if (!data.database) {
                    data['database'] = data.organization_id;
                }

                if (data.method === 'object.update' && data.organization_id !== config.organization_id) {
                    let syncKeys;
                    if (data.array === 'organizations') {
                        syncKeys = ['name', 'logo', 'storage', 'host'];
                    } else if (data.array === 'userssss') {
                        syncKeys = ['name', 'email', 'password', 'avatar'];
                    }

                    if (syncKeys && syncKeys.length) {
                        let platformUpdate = {
                            database: config.organization_id,
                            array: data.array,
                            object: [{}],
                            organization_id: config.organization_id
                        };

                        let object = data.object[0] || data.object;
                        if (object) {
                            for (let key of syncKeys) {
                                if (object[key]) {
                                    platformUpdate.object[0][key] = object[key];
                                }
                            }
                        }
                    }
                }
            }

            if (organization.host) {
                let host = organization.host;
                let hostname = data.socket ? data.socket.host : data.host;

                for (let i = 0; i < host.length; i++) {
                    if (host[i].name === hostname) {
                        if (host[i].storage) data.storage = host[i].storage;
                        if (host[i].database) data.database = host[i].database;
                        if (host[i].array) data.array = host[i].array;
                        break;
                    }
                }
            }

            if (!data.storage || !data.storage.length) {
                if (Array.isArray(storages)) {
                    data.storage = storages[0].name;
                } else if (typeof storages === 'object' && storages !== null) {
                    data.storage = [Object.keys(storages)[0]];
                }
            }

            if (!Array.isArray(data.storage)) {
                data.storage = [data.storage];
            }

            for (let i = 0; i < data.storage.length; i++) {
                let storage;
                if (Array.isArray(storages)) {
                    storage = storages.find((obj) => obj.name === data.storage[i]);
                } else if (typeof storages === 'object' && storages !== null) {
                    storage = storages[data.storage[i]];
                }

                if (storage && storage.provider) {
                    if (!Array.isArray(storage.url)) {
                        storage.url = [storage.url];
                    }

                    for (let j = 0; j < storage.url.length; j++) {
                        data['storageConfig'] = {
                            name: data.storage[i],
                            provider: storage.provider,
                            url: storage.url[j]
                        };

                        // Dynamically load driver from .storages/${provider}.js and cache in runtime memory
                        const driver = await getDriver(storage.provider);

                        if (driver && typeof driver.send === 'function') {
                            data = await driver.send(data);
                        } else {
                            throw new Error(`Storage driver for provider "${storage.provider}" does not implement a send() method.`);
                        }
                    }

                    if (data.$filter) {
                        let type = data.method.split(".")[0];
                        if (data.$filter.sort && data.$filter.sort.length) {
                            data[type] = sortData(data[type], data.$filter.sort);
                        }
                        if (!data.$filter.index) {
                            data.$filter.index = 0;
                        }
                        data.$filter.startingIndex = data.$filter.index;
                        data.$filter.index += data[type].length;
                    }
                }
            }

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

export default crudServer;