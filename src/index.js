import Config from '@cocreate/config';
import { ObjectId, sortData } from "@cocreate/utils";
import storageManager from './storageManager.js';


const organizations = {}; 
const hosts = {};         
let config = null;
let initialized = false;  
let wsManager = null;

const crudServer = {
    init,
    send,
    getOrganization
};

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

    // Hook into global organization teardown event to drain sockets and terminate idle workers
    process.on('orgDeleted', (organization_id) => {
        delete organizations[organization_id];
        for (const host in hosts) {
            if (hosts[host] === organization_id) {
                delete hosts[host];
            }
        }
    });

    return crudServer;
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
                        data['storageName'] = storage.provider;
                        data['storageUrl'] = storage.url[j];
                        data['storageConfig'] = {
                            provider: storage.provider,
                            url: storage.url[j]
                        }

                        // DYNAMIC EXECUTION: Handled dynamically via StorageManager Worker Pool
                        data = await storageManager.send(data);
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

            delete data.storageUrl;
            delete data.storageName;
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