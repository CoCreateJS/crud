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
import { EventEmitter } from 'node:events';
import { createDB, resolveDirectory } from '@cocreate/db';
import { dotNotationToObject, sortData } from "@cocreate/utils";
import GetOrganization from './getOrganization.js';
import { getDriver, registerDriver, drivers } from './getDriver.js';
import { getStorage as resolveStorage } from './getStorage.js';
import {
    defaultOrganizationStorageFallback,
    resolveOrganizationStorageFallback
} from './storageFallback.js';

let server = null;
let db = null;
/**
 *
 * @public
 * @environment server
 */
let config = null;
let initialized = false;
let getOrganization = null;
let crudServer = null;

function sendToServer(data) {
    const envelope = { ...data };
    delete envelope.replyOrganizationId;
    try {
        return Promise.resolve(server.send(envelope)).catch(error => {
            console.error('[@cocreate/crud/server] Response delivery failed:', error);
        });
    } catch (error) {
        console.error('[@cocreate/crud/server] Response delivery failed:', error);
    }
}

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
 * The DB service is bound before organization/configuration reads begin.
 *
 * @param {Object} Server - CoCreateServer instance context
 * @param {Object} [options.config] - Supplied bootstrap configuration for noninteractive callers
 * @returns {Promise<Object>} Initialized CrudServer module API instance
 * @public
 * @environment server
 */
export async function init(Server, options = {}) {
    if (initialized) return crudServer;
    initialized = true;

    server = Server || Object.assign(new EventEmitter(), { send: async data => data });

    config = options.config ? { ...options.config } : await Config.prompt({
        'organization_id': { prompt: 'Enter your organization_id: ' },
        'host': { prompt: 'Enter your host: ' }
    });
    normalizeOrganizationStorageFallback();

    if (!config.organization_id) throw new Error('Missing bootstrap organization_id.');

    db = server.DB ?? createDB({
        directory: await resolveDirectory({
            directory: config.db?.directory ?? config.crud?.directory ?? config.storage?.directory,
            configPath: config.configPath
        }),
        memoryCache: false
    });

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
    // Logging can issue CRUD while the initial DB preload/config read is pending.
    if (server) server.crud = crudServer;

    await loadCrudConfig();

    const types = ['storage', 'database', 'array', 'index', 'object'];
    const methods = ['create', 'read', 'update', 'delete'];

    for (const type of types) {
        for (const method of methods) {
            const action = `${type}.${method}`;
            server.on(action, data => send(data));
        }
    }

    return crudServer;
}

/**
 * Main CRUD payload dispatcher.
 * Resolves organization/hostname defaults and calls CoCreateDB directly.
 *
 * @param {Object} data - Request query payload
 * @returns {Promise<Object>} Processed response payload
 * @public
 * @environment server
 */
async function send(data) {
    const requestOrganizationId = data.replyOrganizationId || data.organization_id;
    try {
        if (!data.organization_id || !config) {
            data.error = 'Missing an organization_id';
            return data;
        }

        if (data.host === undefined && data.organization_id === config.organization_id) {
            data.host = config.host;
        }

        let organization = await getOrganization(data);

        if (organization.error) {
            return organization;
        }

        if (!data['timeStamp']) {
            data['timeStamp'] = new Date().toISOString();
        }

        if (organization.host) {
            let host = organization.host;
            let hostname = data.host;

            for (let i = 0; i < host.length; i++) {
                if (host[i].name === hostname) {
                    if (!data.storage && host[i].storage) data.storage = host[i].storage;
                    if (!data.database && host[i].database) data.database = host[i].database;
                    break;
                }
            }
        }

        data.storage ||= 'production';
        data.database ||= 'app';

        const filterStartingIndex =
            data.filter?.startingIndex ?? data.filter?.index ?? 0;

        delete data.storageConfig;
        data = await db.send(data);

        applyFilterMetadata(data, filterStartingIndex);

        delete data.storageConfig;

        if (data.organization_id === config.organization_id &&
            requestOrganizationId !== data.organization_id) {
            sendToServer(data);
            data.organization_id = requestOrganizationId;
        }
        sendToServer(data);
        const hasErrors = Array.isArray(data.error) ? data.error.length > 0 : Boolean(data.error);
        if (!hasErrors && data.success !== false && /\.(create|update|delete)$/.test(data.method)) {
            const eventData = { ...data };
            delete eventData.replyOrganizationId;
            process.emit('crud-event', eventData);
        }
        return data;
    } catch (error) {
        delete data.storageConfig;
        if (typeof errorHandler === 'function') {
            errorHandler(data, error);
        } else {
            data.error = error.message || error;
        }
        sendToServer(data);
        return data;
    }
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

const serverModule = {
    init,
    config,
    send,
    getStorage,
    getDriver,
    registerDriver,
    drivers
};

export { serverModule as crudServer };
export default serverModule;

/**
 * High-performance, multi-tenant server-side CRUD orchestration engine supporting parallel multi-database writing, real-time sync, and tenant-isolated data routing across 20+ database engines.
 *
 * @module @cocreate/crud/server
 * @environment server
 */
