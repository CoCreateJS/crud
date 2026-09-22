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
        this.crud = null;
        this.organizations = {}; 
        this.hosts = {};         

        // Hook into global organization teardown event to cleanup cache
        process.on('organization.evicted', (organization_id) => {
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

        if (this.hosts[data.host]) {
            return await this.hosts[data.host];
        } else if (this.organizations[data.organization_id]) {
            return await this.organizations[data.organization_id];
        } else {
            if (data.organization_id) {
                this.organizations[data.organization_id] = this.getOrg(data);
                this.organizations[data.organization_id] = await this.organizations[data.organization_id];
                return this.organizations[data.organization_id];
            } else if (data.host) {
                this.hosts[data.host] = await this.getOrg(data);
                return this.hosts[data.host];
            }
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
            host: data.host,
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

        let organization = await sendFn(query);

        if (organization && organization.object && organization.object[0]) {
            if (!this.organizations[organization.object[0]._id] || this.organizations[query.organization_id]?.isConfig) {
                this.organizations[organization.object[0]._id] = organization.object[0];

                delete query.filter;
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
