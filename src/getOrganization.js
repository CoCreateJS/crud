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

export class GetOrganization {
    constructor() {
        this.server = null;
        this.organizations = {}; 
        this.hosts = {};         

        // Hook into global organization teardown event to cleanup organization cache
        process.on('orgDeleted', (organization_id) => {
            delete this.organizations[organization_id];
            for (const host in this.hosts) {
                if (this.hosts[host] === organization_id) {
                    delete this.hosts[host];
                }
            }
        });
    }

    /**
     * Binds the server / CrudServer instance to this module.
     * @param {Object} server - Server or CrudServer context instance.
     * @returns {GetOrganization} Self instance.
     */
    init(server) {
        this.server = server;
        return this;
    }

    /**
     * Local cached tenant configuration analyzer.
     * Incorporates high-efficiency local V8 Promise coalescing.
     * Supports getOrganization(data) or getOrganization(server, data).
     */
    async getOrganization(data, payload) {
        let serverInstance = this.server;

        // Support passing server instance directly as first argument if needed
        if (data && (typeof data.send === 'function' || typeof data.getConfig === 'function')) {
            serverInstance = data;
            data = payload;
        }

        if (!data) {
            return { serverOrganization: false, error: 'No request payload provided' };
        }

        if (this.hosts[data.host]) {
            return await this.hosts[data.host];
        } else if (this.organizations[data.organization_id]) {
            return await this.organizations[data.organization_id];
        } else {
            if (data.organization_id) {
                this.organizations[data.organization_id] = this.getOrg(data, serverInstance);
                this.organizations[data.organization_id] = await this.organizations[data.organization_id];
                return this.organizations[data.organization_id];
            } else if (data.host) {
                this.hosts[data.host] = await this.getOrg(data, serverInstance);
                return this.hosts[data.host];
            }
        }
    }

    /**
     * Database-level organization retriever.
     */
    async getOrg(data, customServerInstance) {
        const activeServer = customServerInstance || this.server;
        
        const config = typeof activeServer?.getConfig === 'function' 
            ? activeServer.getConfig() 
            : (activeServer?.config || null);

        if (!config) {
            return { serverOrganization: false, error: 'Server configuration not initialized' };
        }

        let query = {
            method: 'object.read',
            host: data.host,
            database: config.organization_id,
            array: 'organizations',
            organization_id: config.organization_id
        };

        if (this.organizations[data.organization_id]) {
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

        if (!this.organizations[query.organization_id] && query.organization_id === config.organization_id) {
            this.organizations[query.organization_id] = { ...config, isConfig: true };
        }

        let sendFn = typeof activeServer?.send === 'function' ? activeServer.send.bind(activeServer) : null;
        if (!sendFn) {
            return { serverOrganization: false, error: 'Send method not available on server instance' };
        }

        let organization = await sendFn(query);

        if (organization && organization.object && organization.object[0]) {
            if (!this.organizations[organization.object[0]._id] || this.organizations[query.organization_id]?.isConfig) {
                this.organizations[organization.object[0]._id] = organization.object[0];

                delete query.$filter;
                query.database = query.organization_id = organization.object[0]._id;
                let org = await sendFn(query);
                if (org && org.object && org.object[0]) {
                    if (data.host) {
                        this.hosts[data.host] = org.object[0];
                    }
                    return org.object[0];
                } else {
                    if (data.host) return this.hosts[data.host];
                    return {
                        serverOrganization: false,
                        error: "An organization could not be found in the specified dbUrl"
                    };
                }
            } else {
                if (data.host) {
                    this.hosts[data.host] = organization.object[0];
                }
                return organization.object[0];
            }
        }
        return { serverOrganization: false, error: 'An organization could not be found' };
    }
}

const getOrganizationInstance = new GetOrganization();
export default getOrganizationInstance;
export const getOrganization = (data, payload) => getOrganizationInstance.getOrganization(data, payload);