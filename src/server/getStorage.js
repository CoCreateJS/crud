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

import { getDriver } from "./getDriver.js";

/**
 * Resolves the tenant bootstrap storage by default. Its assigned name resolves
 * directly; other names are resolved from the tenant's own `apis` collection.
 *
 * @param {Object} options
 * @param {Object} options.organization - Resolved organization context
 * @param {string} options.organizationId - Tenant organization identifier
 * @param {string} [options.name] - Exact requested storage name
 * @returns {Promise<Object>} Resolved tenant storage API record
 */
export async function getStorage({ organization, organizationId, name }) {
    if (!organizationId) {
        throw new Error("Missing an organization_id while resolving storage");
    }

    const bootstrapStorage = organization?.bootstrapStorage || organization?.storage;
    if (!bootstrapStorage) return;
    if (typeof bootstrapStorage !== 'object' || Array.isArray(bootstrapStorage) ||
        !bootstrapStorage.name || !bootstrapStorage.provider) {
        throw new Error(
            `Bootstrap storage is not configured as a flat object with name and provider for organization "${organizationId}"`
        );
    }

    if (!name || name === bootstrapStorage.name) {
        return bootstrapStorage;
    }

    const query = {
        type: "storage",
        enabled: true,
        name
    };

    const bootstrapDriver = await getDriver(bootstrapStorage.provider);
    if (!bootstrapDriver || typeof bootstrapDriver.send !== "function") {
        throw new Error(
            `Storage driver for bootstrap provider "${bootstrapStorage.provider}" does not implement a send() method.`
        );
    }

    const response = await bootstrapDriver.send({
        method: "object.read",
        organization_id: organizationId,
        database: organizationId,
        array: "apis",
        object: [],
        filter: {
            query,
            limit: 1
        },
        storageConfig: bootstrapStorage
    });

    const storage = response?.object?.[0];
    if (!storage) {
        throw new Error(
            `Storage "${name}" was not found for organization "${organizationId}"`
        );
    }

    if (!storage.name || !storage.provider) {
        throw new Error(
            `Storage API record for organization "${organizationId}" is missing name or provider`
        );
    }

    return storage;
}

export default getStorage;
