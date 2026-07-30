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
import Config from '@cocreate/config';

// Resolve .storages directory at application execution root (process.cwd())
const STORAGE_DIR = path.resolve(process.cwd(), '.storages');

// In-memory runtime cache for loaded storage driver instances
export const drivers = new Map();

let cachedServerConfig = null;

// Common provider name aliases
const PROVIDER_ALIASES = {
    'postgres': 'postgresql',
    'firebase': 'firestore',
    'quadrant': 'qdrant'
};

/**
 * Helper to safely import a driver module from a disk path (handling ESM and CJS exports).
 * 
 * @param {string} filePath - Absolute file path on disk
 * @returns {Promise<Object>} Instantiated driver instance
 */
export async function importDriverModule(filePath) {
    const fileUrl = pathToFileURL(filePath).href;
    const module = await import(fileUrl);
    let driver = module.default || module;

    if (typeof driver === 'function') {
        try {
            driver = new driver();
        } catch (e) {
            // Retain pure functional export if constructor call throws
        }
    } else if (driver && driver.default) {
        if (typeof driver.default === 'function') {
            try {
                driver = new driver.default();
            } catch (e) {
                driver = driver.default;
            }
        } else {
            driver = driver.default;
        }
    }

    return driver;
}

/**
 * Explicitly registers a storage driver instance into the runtime cache.
 * 
 * @param {string} provider - Storage provider name (e.g., 'mongodb')
 * @param {Object|Function} driver - Driver module instance or object with .send method
 */
export function registerDriver(provider, driver) {
    if (!provider || !driver) return;
    
    let instance = driver;
    if (typeof driver === 'function') {
        try {
            instance = new driver();
        } catch (e) {
            // Retain as function if instantiation fails
        }
    } else if (driver && driver.default) {
        if (typeof driver.default === 'function') {
            try {
                instance = new driver.default();
            } catch (e) {
                instance = driver.default;
            }
        } else {
            instance = driver.default;
        }
    }

    const key = provider.toLowerCase();
    drivers.set(key, instance);

    const alias = PROVIDER_ALIASES[key];
    if (alias) {
        drivers.set(alias, instance);
    }

    console.log(`[@cocreate/crud-server] Cached driver instance for provider "${provider}"`);
}

/**
 * Fetches driver file on demand from remote host and persists it to disk.
 * Strictly writes file to disk; no dynamic custom code string execution allowed.
 */
export async function fetchAndInstallDriver(providerKey, organizationId, hostOverride) {
    console.log(`[@cocreate/crud-server] Driver "${providerKey}" not found in .storages/. Fetching installer...`);

    if (!cachedServerConfig && typeof Config.query === 'function') {
        try {
            cachedServerConfig = await Config.query({
                type: "storage",
                organization_id: organizationId
            });
        } catch (cfgErr) {
            console.warn(`[@cocreate/crud-server] Failed to query server config:`, cfgErr.message);
        }
    }

    const driverConfig = cachedServerConfig?.drivers?.[providerKey] || cachedServerConfig?.[providerKey] || {};
    const scriptPath = driverConfig.path || driverConfig.driverPath || `${providerKey}.js`;
    const host = driverConfig.host || cachedServerConfig?.host || hostOverride;

    if (!host) {
        throw new Error(`Unable to resolve download host for provider "${providerKey}". Driver missing from .storages/ and no host configured.`);
    }

    let baseUrl = host.trim();
    if (!/^https?:\/\//i.test(baseUrl)) {
        baseUrl = `https://${baseUrl}`;
    }

    const fullUrl = new URL(scriptPath, baseUrl).href;
    console.log(`[@cocreate/crud-server] Installing driver script from host: ${fullUrl}`);

    const response = await fetch(fullUrl, {
        headers: { "User-Agent": "CoCreate-Driver-Loader/1.0" }
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch driver script from ${fullUrl} (Status: ${response.status} ${response.statusText})`);
    }

    const scriptText = await response.text();

    if (!fs.existsSync(STORAGE_DIR)) {
        fs.mkdirSync(STORAGE_DIR, { recursive: true });
    }

    const targetFilePath = path.join(STORAGE_DIR, `${providerKey}.js`);
    fs.writeFileSync(targetFilePath, scriptText, 'utf8');
    console.log(`[@cocreate/crud-server] Installed driver file to disk: ${targetFilePath}`);

    return targetFilePath;
}

/**
 * Resolves and returns a storage driver instance from memory cache, local disk, or installed file on demand.
 * 
 * @param {string} provider - Storage provider name (e.g. 'mongodb')
 * @param {string} [organizationId] - Optional organization ID for installer context
 * @param {string} [host] - Optional host endpoint for installer context
 * @param {Object} [fallbackServerInstance] - Optional server context fallback
 * @returns {Promise<Object>} Resolved storage driver instance
 */
export async function getDriver(provider, organizationId, host, fallbackServerInstance) {
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

    // 2. Check if attached as property on fallback server instance
    if (fallbackServerInstance) {
        const attachedDriver = fallbackServerInstance[key] || fallbackServerInstance[resolvedProvider];
        if (attachedDriver) {
            registerDriver(key, attachedDriver);
            return drivers.get(key);
        }
    }

    // 3. On-Demand Check: Inspect process.cwd()/.storages/${resolvedProvider}.js on local disk
    const driverPath = path.join(STORAGE_DIR, `${resolvedProvider}.js`);

    if (fs.existsSync(driverPath)) {
        try {
            const driver = await importDriverModule(driverPath);
            registerDriver(key, driver);
            console.log(`[@cocreate/crud-server] Loaded on-demand driver for "${provider}" from ${driverPath}`);
            return drivers.get(key);
        } catch (err) {
            console.error(`[@cocreate/crud-server] Failed to import driver from ${driverPath}:`, err.message);
            throw err;
        }
    }

    // 4. On-Demand Fallback: Download driver from installer host endpoint, save to disk, import, and cache
    try {
        const installedFilePath = await fetchAndInstallDriver(resolvedProvider, organizationId, host);
        const driver = await importDriverModule(installedFilePath);
        registerDriver(key, driver);
        return drivers.get(key);
    } catch (installErr) {
        console.error(`[@cocreate/crud-server] Failed to resolve or install driver for provider "${provider}":`, installErr.message);
        throw installErr;
    }
}

export default getDriver;