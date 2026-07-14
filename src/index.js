/********************************************************************************
 * Copyright (C) 2023 CoCreate and Contributors.
 *
 * This program is free software: you can redistribute it and/or modify
 * Wu under the terms of the GNU Affero General Public License as published
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

// Commercial Licensing Information:
// For commercial use of this software without the copyleft provisions of the AGPLv3,
// you must obtain a commercial license from CoCreate LLC.
// For details, visit <https://cocreate.app/licenses/> or contact us at sales@cocreate.app.

import { ObjectId, sortData } from "@cocreate/utils";
import Config from '@cocreate/config';

// In-process memory caches and storage registers (strictly module-internal)
const providers = {}; 
const organizations = {}; 
const hosts = {};         
let config = null;
let initialized = false;  
let wsManager = null;     // Extracted from Server and bound directly for real-time socket communications

// Main service contract structure returned as default
const crudServer = {
    init,
    send,
    getOrganization
};

/**
 * Async initialization loop. Prompts and loads platform configuration guidelines,
 * dynamically registers active drivers, and binds global WebSocket endpoint listeners.
 * @param {Object} Server - CoCreateServer context instance.
 * @returns {Promise<Object>} This fully initialized crudServer module context
 */
export async function init(Server) {
    if (initialized) return crudServer;
    initialized = true;

    if (Server && Server.wsManager) {
        wsManager = Server.wsManager;
    }

    config = await Config({
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
        
        // Dynamically resolve the first declared storage block in the configuration (order-preserved)
        const storageKeys = Object.keys(config.storage);
        if (storageKeys.length > 0) {
            firstStorageKey = storageKeys[0];
            storageUrl = config.storage[firstStorageKey].url;
        }
    }

    if (config.organization_id) {
        Server.organization_id = config.organization_id;
    } else {
        console.log('[@cocreate/crud-server] Could not find the organization_id');
    }
    if (!storageUrl) {
        console.log(`[@cocreate/crud-server] Could not find a connection url in your primary storage: "${firstStorageKey || 'default'}"`);
    }
    if (!storageUrl || !config.organization_id) {
        process.exit(1);
    }

    // Dynamically import and register drivers configured on the server
    if (config.storage && providers) {
        for (const [friendlyName, storageConfig] of Object.entries(config.storage)) {
            const { provider } = storageConfig;
            
            if (provider) {
                // Convention over Configuration: fallback to @cocreate/provider if explicit import is omitted
                const importPath = storageConfig.import || `@cocreate/${provider}`;
                
                try {
                    const driverModule = await import(importPath);
                    providers[provider] = driverModule.default || driverModule;
                } catch (err) {
                    console.error(`[@cocreate/crud-server] Failed to dynamically load database driver "${importPath}" for provider "${provider}":`, err);
                }
            }
        }
    }

    // Deferred WebSocket Listener Auto-Registration
    const bindSocketListeners = () => {
        // Dynamically check and capture wsManager from Server if it was not resolved during immediate boot
        if (!wsManager && Server && Server.wsManager) {
            wsManager = Server.wsManager;
        }

        if (wsManager) {
            const type = ['storage', 'database', 'array', 'index', 'object'];
            const method = ['create', 'read', 'update', 'delete'];

            for (let i = 0; i < type.length; i++) {
                for (let j = 0; j < method.length; j++) {
                    const action = type[i] + '.' + method[j];
                    wsManager.on(action, (data) => send(data));
                }
            }
        } else {
            // Check back in 500ms if the socket server is still resolving its connection handshake
            setTimeout(bindSocketListeners, 500);
        }
    };

    bindSocketListeners();

    return crudServer;
}

/**
 * Resolves metadata, identifies target drivers, processes sync limits, and executes query logic.
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
                for (let i = 0; i < host.length; i++) {
                    let hostname;
                    if (data.socket) {
                        hostname = data.socket.host;
                    } else {
                        hostname = data.host;
                    }
                    if (host[i].name === hostname) {
                        if (host[i].storage) {
                            data.storage = host[i].storage;
                        }
                        if (host[i].database) {
                            data.database = host[i].database;
                        }
                        if (host[i].array) {
                            data.array = host[i].array;
                        }
                        break;
                    }
                }
            }

            // Symmetrical resolution - Fallback to first configured key if data.storage is omitted
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

                if (storage) {
                    if (storage.provider && providers[storage.provider]) {
                        if (!Array.isArray(storage.url)) {
                            storage.url = [storage.url];
                        }

                        for (let j = 0; j < storage.url.length; j++) {
                            data['storageName'] = data.storage[i];
                            data['storageUrl'] = storage.url[j];

                            data = await providers[storage.provider].send(data);
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
            }

            delete data.storageUrl;
            delete data.storageName;

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
                errorHandler(data, error);
                wsManager.send(data);
            }
            resolve(data);
        }
    });
}

/**
 * Local cached tenant configuration analyzer.
 * Incorporates high-efficiency local V8 Promise coalescing alongside cross-process workerStorage checks.
 */
export async function getOrganization(data) {
    if (hosts[data.host]) {
        return await hosts[data.host];
    } else if (organizations[data.organization_id]) {
        return await organizations[data.organization_id];
    } else {
        if (data.organization_id) {
            organizations[data.organization_id] = getOrg(data);
            organizations[data.organization_id] = await organizations[data.organization_id];
            return organizations[data.organization_id];
        } else if (data.host) {
            hosts[data.host] = await getOrg(data);
            return hosts[data.host];
        }
    }
}

/**
 * Database-level organization retriever.
 */
async function getOrg(data) {
    let query = {
        method: 'object.read',
        host: data.host,
        database: config.organization_id,
        array: 'organizations',
        organization_id: config.organization_id
    };

    if (organizations[data.organization_id]) {
        data.database = data.organization_id = data.organization_id;
    }

    if (data.organization_id) {
        query.object = [{ _id: data.organization_id }];
    } else if (data.host) {
        query.$filter = {
            query: { host: { $elemMatch: { name: { $in: [data.host] } } } },
            limit: 1
        };
    } else {
        return { serverOrganization: false, error: 'An organization could not be found' };
    }

    if (!organizations[query.organization_id] && query.organization_id === config.organization_id) {
        organizations[query.organization_id] = { ...config, isConfig: true };
    }

    let organization = await send(query);

    if (organization && organization.object && organization.object[0]) {
        if (!organizations[organization.object[0]._id] || organizations[query.organization_id].isConfig) {
            organizations[organization.object[0]._id] = organization.object[0];

            delete query.$filter;
            query.database = query.organization_id = organization.object[0]._id;
            let org = await send(query);
            if (org && org.object && org.object[0]) {
                if (data.host) {
                    hosts[data.host] = org.object[0];
                }
                return org.object[0];
            } else {
                if (data.host) return hosts[data.host];
                return {
                    serverOrganization: false,
                    error: "An organization could not be found in the specified dbUrl"
                };
            }
        } else {
            if (data.host) {
                hosts[data.host] = organization.object[0];
            }
            return organization.object[0];
        }
    }
    return { serverOrganization: false, error: 'An organization could not be found' };
}

/**
 * Standard error state structure normalization helper.
 */
function errorHandler(data, error, database, array) {
    if (typeof error === 'object') {
        error['storage'] = 'mongodb';
    } else {
        error = { location: 'crudServer', message: error };
    }

    if (database) {
        error['database'] = database;
    }

    if (data.error) {
        data.error.push(error);
    } else {
        data.error = [error];
    }
}

// Export default database routing context (explicitly loaded on-demand via server initialization)
export default crudServer;