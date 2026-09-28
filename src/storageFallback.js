export const ORGANIZATION_ID_DATABASE = '$organization_id';

export const defaultOrganizationStorageFallback = Object.freeze({
    database: ORGANIZATION_ID_DATABASE
});

export function resolveOrganizationStorageFallback(config, organizationId) {
    const configuredFallback = config?.organizationStorageFallback;
    if (configuredFallback === false) return null;

    const fallback = configuredFallback ?? defaultOrganizationStorageFallback;
    if (!fallback || typeof fallback !== 'object' || Array.isArray(fallback)) {
        throw new Error('organizationStorageFallback must be an object or false');
    }

    const storage = fallback.storage;
    if (storage !== undefined && (typeof storage !== 'string' || !storage.trim())) {
        throw new Error('organizationStorageFallback.storage must be a non-empty storage name');
    }

    const configuredDatabase = fallback.database ?? ORGANIZATION_ID_DATABASE;
    if (typeof configuredDatabase !== 'string' || !configuredDatabase.trim()) {
        throw new Error('organizationStorageFallback.database must be a non-empty string');
    }

    return {
        storage,
        database: configuredDatabase === ORGANIZATION_ID_DATABASE
            ? organizationId
            : configuredDatabase
    };
}
