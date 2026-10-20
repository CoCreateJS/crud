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
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const STORAGE_DIRS = [
    process.env.COCREATE_STORAGE_DIR,
    path.resolve(process.cwd(), 'storages'),
    process.argv[1]
        ? path.resolve(path.dirname(process.argv[1]), 'storages')
        : null
].filter((directory, index, directories) =>
    directory && directories.indexOf(directory) === index
);

// In-memory runtime cache for loaded storage driver instances
export const drivers = new Map();

function logPrefix() {
    const workerId = process.env.WORKER_ID;
    return `[@cocreate/crud-server] ${workerId ? `[WORKER ${workerId}]` : '[MASTER]'}`;
}

/**
 * Database provider to core engine driver mappings.
 * Maps specific databases (e.g., CosmosDB, MariaDB) to their actual underlying wrapper/driver.
 */
const PROVIDER_ALIASES = {
    "amazon-redshift": "amazon-redshift",
    "auroradb": "postgresql",
    "cockroachdb": "postgresql",
    "cosmosdb": "mongodb",
    "documentdb": "mongodb",
    "dqlite": "sqlite",
    "dynamodb": "dynamodb",
    "ferretdb": "mongodb",
    "firestore": "firestore",
    "mariadb": "mysql",
    "mongodb": "mongodb",
    "mysql": "mysql",
    "oracledb": "mongodb",
    "planetscale": "mysql",
    "postgresql": "postgresql",
    "qdrant": "qdrant",
    "rqlite": "sqlite",
    "sqlite": "sqlite",
    "tidb": "mysql",
    "timescaledb": "postgresql",
    "turso": "sqlite",
    "yugabytedb": "postgresql"
};

/**
 * Internal helper to safely instantiate constructor functions or resolve ESM/CJS exports.
 */
function instantiateDriver(rawDriver) {
    if (!rawDriver) return rawDriver;
    let target = rawDriver;

    // Handle CJS/ESM module default wrapper
    if (target && target.default) {
        target = target.default;
    }

    // Instantiate if it's a class or constructor function
    if (typeof target === 'function') {
        try {
            return new target();
        } catch (e) {
            // Retain as function if constructor call fails
            return target;
        }
    }

    return target;
}

/**
 * Safely imports a driver module from a disk path.
 * 
 * @param {string} filePath - Absolute file path on disk
 * @returns {Promise<Object>} Instantiated driver instance
 */
export async function importDriverModule(filePath) {
    const fileUrl = pathToFileURL(filePath).href;
    // Storage drivers are extracted at runtime and therefore cannot be
    // resolved into a static build by webpack.
    const module = await import(/* webpackIgnore: true */ fileUrl);
    const rawDriver = module.default || module;
    return instantiateDriver(rawDriver);
}

/**
 * Registers a storage driver instance into the runtime cache.
 * 
 * @param {string} provider - Storage provider name (e.g., 'mongodb', 'cosmosdb')
 * @param {Object|Function} driver - Driver module instance or constructor function
 * @returns {Object} Instantiated driver instance
 */
export function registerDriver(provider, driver) {
    if (!provider || !driver) return;
    
    const instance = instantiateDriver(driver);
    const key = provider.toLowerCase();
    
    drivers.set(key, instance);

    // If provider maps to an underlying engine alias, cache under that key as well
    const alias = PROVIDER_ALIASES[key];
    if (alias) {
        drivers.set(alias, instance);
    }

    console.log(`${logPrefix()} Cached driver instance for provider "${provider}"`);
    return instance;
}

/**
 * Resolves and returns a storage driver instance from memory cache or a storages/ directory.
 * 
 * @param {string} provider - Storage provider name (e.g. 'mongodb', 'cosmosdb')
 * @returns {Promise<Object>} Resolved storage driver instance
 */
export async function getDriver(provider) {
    if (!provider) {
        throw new Error('[@cocreate/crud-server] Provider name must be provided to getDriver()');
    }

    const key = provider.toLowerCase();
    const resolvedProvider = PROVIDER_ALIASES[key] || key;

    // 1. Check in-memory driver cache
    if (drivers.has(key)) {
        return drivers.get(key);
    }
    if (drivers.has(resolvedProvider)) {
        return drivers.get(resolvedProvider);
    }

    // 2. Check configured, application, and packaged storage directories.
    for (const storageDirectory of STORAGE_DIRS) {
        const driverPath = path.join(storageDirectory, `${resolvedProvider}.js`);
        if (!fs.existsSync(driverPath)) continue;

        try {
            const driver = await importDriverModule(driverPath);
            registerDriver(key, driver);
            console.log(`${logPrefix()} Loaded driver for "${provider}" (using "${resolvedProvider}") from ${driverPath}`);
            return drivers.get(key);
        } catch (err) {
            console.error(`${logPrefix()} Failed to import driver from ${driverPath}:`, err.message);
            throw err;
        }
    }

    throw new Error(
        `[@cocreate/crud-server] Driver for provider "${provider}" ` +
        `(mapped to "${resolvedProvider}") was not found in: ${STORAGE_DIRS.join(', ')}`
    );
}

export default getDriver;
