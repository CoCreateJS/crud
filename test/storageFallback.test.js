import assert from 'node:assert/strict';
import test from 'node:test';

import {
    resolveOrganizationStorageFallback
} from '../src/storageFallback.js';

test('storage fallback defaults to platform default storage and tenant database', () => {
    assert.deepEqual(
        resolveOrganizationStorageFallback({}, 'tenant'),
        { storage: undefined, database: 'tenant' }
    );
});

test('storage fallback resolves a named platform storage and shared database', () => {
    assert.deepEqual(
        resolveOrganizationStorageFallback({
            organizationStorageFallback: {
                storage: 'shared-storage',
                database: 'shared-database'
            }
        }, 'tenant'),
        {
            storage: 'shared-storage',
            database: 'shared-database'
        }
    );
});

test('storage fallback resolves the organization database token', () => {
    assert.deepEqual(
        resolveOrganizationStorageFallback({
            organizationStorageFallback: {
                storage: 'shared-storage',
                database: '$organization_id'
            }
        }, 'tenant'),
        { storage: 'shared-storage', database: 'tenant' }
    );
});

test('storage fallback can be disabled', () => {
    assert.equal(
        resolveOrganizationStorageFallback({
            organizationStorageFallback: false
        }, 'tenant'),
        null
    );
});
