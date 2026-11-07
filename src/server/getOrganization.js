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

import { resolveOrganizationStorageFallback } from './storageFallback.js';

export class GetOrganization {
    constructor() {
        this.crud = null;
        this.organizations = {};
        this.hosts = {};

        // Hook into global organization teardown event to cleanup cache
        process.on('orgDisconnected', (organization_id, details = {}) => {
            delete this.organizations[organization_id];
            for (const host in this.hosts) {
                if (
                    this.hosts[host] === organization_id ||
                    String(this.hosts[host]?._id) === String(organization_id)
                ) {
                    delete this.hosts[host];
                }
            }
        });
    }

    /**
     * Binds the crudServer instance context.
     * @param {Object} crud - CrudServer context instance.
     * @returns {Function} Bound getOrganization function.
     */
    init(crud) {
        this.crud = crud;
        return (data) => this.getOrganization(data);
    }

    /**
     * Local cached tenant configuration analyzer.
     * @param {Object} data - Request payload containing host or organization_id
     * @returns {Promise<Object>} Organization context or error
     */
    async getOrganization(data) {
        if (!data) {
            return { serverOrganization: false, error: 'No request payload provided' };
        }

        if (data.host) {
            if (!this.hosts[data.host]) {
                this.hosts[data.host] = this.getOrg({
                    ...data,
                    organization_id: undefined
                });
            }

            const hostOrganization = await this.hosts[data.host];
            if (
                !data.organization_id ||
                String(data.organization_id) === String(hostOrganization?._id)
            ) {
                return hostOrganization;
            }
        }

        if (data.organization_id) {
            if (!this.organizations[data.organization_id]) {
                this.organizations[data.organization_id] = this.getOrg({
                    ...data,
                    host: undefined
                });
            }
            return await this.organizations[data.organization_id];
        }

        return { serverOrganization: false, error: 'An organization could not be found' };
    }

    /**
     * Database-level organization retriever.
     */
    async getOrg(data) {
        const crud = this.crud;
        const config = typeof crud?.getConfig === 'function'
            ? crud.getConfig()
            : (crud?.config || null);

        if (!config) {
            return { serverOrganization: false, error: 'Server configuration not initialized' };
        }

        let query = {
            method: 'object.read',
            database: config.organization_id,
            array: 'organizations',
            organization_id: config.organization_id
        };

        if (this.organizations[data.organization_id]) {
            if (!data.database) data.database = data.organization_id;
        }

        if (data.organization_id) {
            query.object = [{ _id: data.organization_id }];
        } else if (data.host) {
            query.filter = {
                query: { host: { $elemMatch: { name: { $in: [data.host] } } } },
                limit: 1
            };
        } else {
            return { serverOrganization: false, error: 'An organization could not be found' };
        }

        if (!this.organizations[query.organization_id] && query.organization_id === config.organization_id) {
            this.organizations[query.organization_id] = { ...config, isConfig: true };
        }

        let sendFn = typeof crud?.send === 'function' ? crud.send.bind(crud) : null;
        if (!sendFn) {
            return { serverOrganization: false, error: 'Send method not available on CRUD instance' };
        }

        const organization = await sendFn(query);
        if (organization?.error || organization?.success === false) {
            return { serverOrganization: false, error: organization.error || 'Unable to read the platform organization' };
        }

        let platformOrganization = organization?.object?.[0];
        if (!platformOrganization && data.organization_id) {
            const storage = config.bootstrapStorage || config.storage;
            if (storage?.name && storage?.provider &&
                resolveOrganizationStorageFallback(config, data.organization_id)) {
                // A registry record is optional when the organization ID is
                // known and the existing platform storage fallback can connect.
                // Storage selection remains the CRUD dispatcher's responsibility.
                platformOrganization = {
                    _id: data.organization_id,
                    organization_id: data.organization_id
                };
            }
        }
        if (platformOrganization) {
            const organizationId = platformOrganization._id;
            // The nested tenant read needs this connection context before the
            // tenant has an organization record of its own.
            this.organizations[organizationId] = platformOrganization;

            let tenant;
            try {
                tenant = await sendFn({
                    method: 'object.read',
                    database: organizationId,
                    organization_id: organizationId,
                    array: 'organizations',
                    object: [{ _id: organizationId }]
                });
            } catch (error) {
                delete this.organizations[organizationId];
                throw error;
            }

            if (!tenant || tenant.error || tenant.success === false) {
                const failure = {
                    serverOrganization: false,
                    error: tenant?.error || 'Unable to read the tenant organization'
                };
                this.organizations[organizationId] = failure;
                if (data.host) this.hosts[data.host] = failure;
                return failure;
            }

            // Tenant fields override the platform profile; absent fields,
            // including bootstrapStorage, continue to come from the platform.
            const resolvedOrganization = tenant.object?.[0]
                ? { ...platformOrganization, ...tenant.object[0] }
                : platformOrganization;
            this.organizations[organizationId] = resolvedOrganization;
            if (data.host) this.hosts[data.host] = resolvedOrganization;
            return resolvedOrganization;
        }
        return { serverOrganization: false, error: 'An organization could not be found' };
    }
}

const getOrganizationInstance = new GetOrganization();
export default getOrganizationInstance;
