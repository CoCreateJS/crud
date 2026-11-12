import { stat } from 'node:fs/promises';
import path from 'node:path';

/** Resolve standalone storage in the service, shared by all local CRUD callers. */
export async function resolveLocalDBDirectory({ directory, configPath, cwd = process.cwd() } = {}) {
    if (process.env.COCREATE_DB_DIRECTORY) return path.resolve(cwd, process.env.COCREATE_DB_DIRECTORY);
    if (directory) return path.resolve(configPath ? path.dirname(configPath) : cwd, directory);
    let parent = path.resolve(cwd);
    while (true) {
        const candidate = path.join(parent, 'CoCreateDB');
        try {
            if ((await stat(candidate)).isDirectory()) return candidate;
        } catch (error) {
            if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
        }
        const next = path.dirname(parent);
        if (next === parent) break;
        parent = next;
    }
    return path.resolve(cwd, '.cocreate/db');
}

export async function createLocalDB(options) {
    const { createDB } = await import('@cocreate/db');
    return createDB({ directory: await resolveLocalDBDirectory(options), memoryCache: false });
}
