import assert from 'node:assert/strict';
import test from 'node:test';

import { GetOrganization } from '../src/getOrganization.js';
import { isPlatformArray } from '../src/routing.js';
import { resolveOrganizationStorageFallback } from '../src/storageFallback.js';

test('organization registry reads do not receive the platform host fallback', () => {
    assert.equal(isPlatformArray('organizations'), true);
});

test('host resolves first, then a mismatched organization_id resolves without poisoning the host cache', async () => {
    const resolver = new GetOrganization();
    const tenant = { _id: 'tenant' };
    const platform = { _id: 'platform' };

    resolver.getOrg = async (data) => {
        if (data.host) {
            assert.equal(data.host, 'platform.example.com');
            assert.equal(data.organization_id, undefined);
            return platform;
        }

        assert.equal(data.host, undefined);
        assert.equal(data.organization_id, 'tenant');
        return tenant;
    };

    const organization = await resolver.getOrganization({
        organization_id: 'tenant',
        host: 'platform.example.com'
    });

    assert.equal(organization, tenant);
    assert.equal(await resolver.hosts['platform.example.com'], platform);
    assert.equal(await resolver.organizations.tenant, tenant);
});

test('host resolution remains available without an organization_id', async () => {
    const resolver = new GetOrganization();
    const platform = { _id: 'platform' };

    resolver.hosts['platform.example.com'] = platform;

    const organization = await resolver.getOrganization({
        host: 'platform.example.com'
    });

    assert.equal(organization, platform);
});

test('host registry lookup routes through the platform organization without a top-level host', async () => {
    const resolver = new GetOrganization();
    let query;
    resolver.crud = {
        getConfig: () => ({ organization_id: 'platform' }),
        send: async (data) => {
            query = data;
            return { object: [] };
        }
    };

    await resolver.getOrg({ host: 'platform.example.com' });

    assert.equal(query.host, undefined);
    assert.equal(query.organization_id, 'platform');
    assert.equal(
        query.filter.query.host.$elemMatch.name.$in[0],
        'platform.example.com'
    );
});

for (const array of ['files', ['objects', 'files']]) {
    test(`file requests fall back to a mismatched organization_id without changing the host cache: ${JSON.stringify(array)}`, async () => {
        const resolver = new GetOrganization();
        const tenant = { _id: 'tenant' };
        const platform = { _id: 'platform' };

        resolver.organizations.tenant = tenant;
        resolver.hosts['platform.example.com'] = platform;

        const organization = await resolver.getOrganization({
            organization_id: 'tenant',
            host: 'platform.example.com',
            array
        });

        assert.equal(organization, tenant);
        assert.equal(await resolver.hosts['platform.example.com'], platform);
    });
}

test('an unresolved host falls back to organization_id', async () => {
    const resolver = new GetOrganization();
    const tenant = { _id: 'tenant' };

    resolver.getOrg = async (data) => {
        if (data.host) {
            assert.equal(data.organization_id, undefined);
            return { error: 'Host was not found' };
        }

        assert.equal(data.host, undefined);
        assert.equal(data.organization_id, 'tenant');
        return tenant;
    };

    const organization = await resolver.getOrganization({
        organization_id: 'tenant',
        host: 'missing.example.com',
        array: 'files'
    });

    assert.equal(organization, tenant);
    assert.deepEqual(
        await resolver.hosts['missing.example.com'],
        { error: 'Host was not found' }
    );
});

// Exercise the resolver's recursive CRUD calls as well as the first tenant
// write. Storage is in memory; no database or API requests leave this process.
async function createTenantResolver(t, options = {}) {
    const { getStorage } = await import('../src/getStorage.js');
    const existingListeners = new Set(process.listeners('orgDisconnected'));
    const resolver = new GetOrganization();
    const evictionListener = process.listeners('orgDisconnected').find(listener => !existingListeners.has(listener));
    t.after(() => process.removeListener('orgDisconnected', evictionListener));
    const storage = { name: 'primary', provider: 'custom', credentials: { endpoint: 'test-only' } };
    const platformOrganization = {
        _id: 'tenant', name: 'Platform name', bootstrapStorage: storage,
        host: [{ name: 'tenant.example.com', database: 'tenant', storage: 'primary' }],
        platformField: 'retained'
    };
    let tenantOrganization = options.tenant;
    const requests = [];
    const runtime = {
        config: { organization_id: 'platform', storage: { name: 'platform', provider: 'custom' }, ...options.config },
        async send(request) {
            requests.push(structuredClone(request));
            const organization = await resolver.getOrganization(request);
            if (organization.error) return organization;
            let storageConfig = await getStorage({ organization, organizationId: request.organization_id });
            if (!storageConfig) {
                const fallback = resolveOrganizationStorageFallback(runtime.config, request.organization_id);
                assert.ok(fallback, 'Fallback must be explicitly allowed');
                storageConfig = await getStorage({ organization: runtime.config, organizationId: 'platform', name: fallback.storage });
                request.database = fallback.database;
            }
            if (request.organization_id === 'platform') {
                if (request.object?.[0]?._id === 'platform') return { object: [{ _id: 'platform', ...runtime.config }] };
                return { object: options.missingPlatform ? [] : [platformOrganization] };
            }
            assert.equal(storageConfig, options.missingPlatform ? (organization.bootstrapStorage || organization.storage || runtime.config.storage) : storage,
                'Use the organization storage or configured platform fallback');
            if (request.method === 'object.read') {
                if (options.throwRead) throw new Error('Connection refused');
                if (options.readError) return { error: ['Authentication failed'] };
                if (options.rejectedRead) return { success: false };
                return { object: tenantOrganization ? [tenantOrganization] : [] };
            }
            assert.equal(request.method, 'object.create');
            tenantOrganization = request.object;
            return { object: [tenantOrganization] };
        }
    };
    // Match an already initialized server so tenant lookup cannot accidentally
    // depend on the platform's temporary isConfig marker.
    if (!options.cold) resolver.organizations.platform = runtime.config;
    resolver.init(runtime);
    return { resolver, runtime, platformOrganization, requests, storage };
}

for (const lookup of [
    { organization_id: 'tenant' },
    { host: 'tenant.example.com' },
    { organization_id: 'tenant', host: 'tenant.example.com' }
]) {
    test(`an empty tenant retains its platform profile and accepts the first organization write: ${JSON.stringify(lookup)}`, async t => {
        const { resolver, runtime, platformOrganization, requests } = await createTenantResolver(t);
        const resolved = await resolver.getOrganization({ ...lookup });
        assert.equal(resolved, platformOrganization);
        assert.equal(resolver.organizations.tenant, resolved);
        if (lookup.host) assert.equal(await resolver.hosts[lookup.host], resolved);
        assert.equal(requests.length, 2, 'Read the platform profile, then the empty tenant');
        assert.equal(requests[0].organization_id, 'platform');
        assert.equal(requests[1].organization_id, 'tenant');
        const result = await runtime.send({
            method: 'object.create', organization_id: 'tenant', array: 'organizations',
            object: { _id: 'tenant', name: 'First tenant organization' }
        });
        assert.equal(result.error, undefined);
        assert.equal(result.object[0].name, 'First tenant organization');
    });
}

test('tenant profile fields override platform fields while preserving bootstrap and omitted fields', async t => {
    const tenant = { _id: 'tenant', name: 'Tenant name', tenantField: 'new', host: [{ name: 'custom.example.com' }] };
    const { resolver, platformOrganization, requests } = await createTenantResolver(t, { tenant });
    const resolved = await resolver.getOrganization({ host: 'tenant.example.com' });
    assert.deepEqual(resolved, { ...platformOrganization, ...tenant });
    assert.equal(resolved.bootstrapStorage, platformOrganization.bootstrapStorage);
    assert.equal(platformOrganization.name, 'Platform name', 'Do not mutate the registry record');
    assert.equal(tenant.bootstrapStorage, undefined, 'Do not mutate the tenant record');
    assert.equal(await resolver.getOrganization({ organization_id: 'tenant' }), resolved);
    assert.equal(await resolver.getOrganization({ host: 'tenant.example.com' }), resolved);
    assert.equal(requests.length, 2, 'Both caches retain the merged profile');
});

for (const options of [{ readError: true }, { rejectedRead: true }]) {
    test(`a tenant lookup failure is not treated as an empty organization: ${JSON.stringify(options)}`, async t => {
        const { resolver } = await createTenantResolver(t, options);
        const result = await resolver.getOrganization({ host: 'tenant.example.com' });
        assert.ok(result.error);
        assert.equal(result.bootstrapStorage, undefined);
        assert.ok((await resolver.getOrganization({ organization_id: 'tenant' })).error,
            'A later request must not silently use the temporary platform-only cache');
    });
}

test('a thrown connection failure propagates and clears temporary tenant context', async t => {
    const { resolver } = await createTenantResolver(t, { throwRead: true });
    await assert.rejects(resolver.getOrganization({ organization_id: 'tenant' }), /Connection refused/);
    assert.equal(resolver.organizations.tenant, undefined);
});

test('missing organization and storage context fails without attempting tenant lookup', async t => {
    const { resolver, requests } = await createTenantResolver(t, { missingPlatform: true, config: { storage: undefined } });
    const result = await resolver.getOrganization({ organization_id: 'tenant' });
    assert.match(result.error, /organization could not be found/);
    assert.equal(requests.length, 1);
});

for (const tenant of [undefined, { _id: 'tenant', name: 'Tenant name' }]) {
    test(`a cold platform cache resolves tenant storage (${tenant ? 'existing' : 'empty'} tenant)`, async t => {
        const { resolver, platformOrganization } = await createTenantResolver(t, { cold: true, tenant });
        const result = await resolver.getOrganization({ organization_id: 'tenant', host: 'tenant.example.com' });
        assert.equal(result.error, undefined);
        assert.equal(result.bootstrapStorage, platformOrganization.bootstrapStorage);
        assert.equal(result.name, tenant?.name || platformOrganization.name);
    });
}

for (const tenant of [
    undefined,
    { _id: 'tenant', name: 'Tenant without registry record' },
    { _id: 'tenant', name: 'Tenant with its own storage', bootstrapStorage: { name: 'own', provider: 'custom', endpoint: 'test-only' } }
]) {
    test(`platform storage works without a registry record (${tenant ? 'existing' : 'empty'} tenant organization)`, async t => {
        const { resolver, runtime, requests } = await createTenantResolver(t, { missingPlatform: true, tenant });
        const resolved = await resolver.getOrganization({ organization_id: 'tenant' });
        assert.equal(resolved.error, undefined);
        assert.equal(resolved._id, 'tenant');
        assert.equal(resolved.name, tenant?.name);
        assert.equal(resolved.bootstrapStorage, tenant?.bootstrapStorage);
        assert.equal(resolved.storage, undefined, 'Let CRUD apply its configured storage fallback');
        assert.equal(requests.length, 2);
        const result = await runtime.send({
            method: 'object.create', organization_id: 'tenant', array: 'organizations',
            object: { _id: 'tenant', name: 'First write using platform storage' }
        });
        assert.equal(result.error, undefined);
        assert.equal(result.object[0].name, 'First write using platform storage');
    });
}

test('missing registry data does not enable a disabled platform storage fallback', async t => {
    const { resolver, requests } = await createTenantResolver(t, {
        missingPlatform: true, config: { organizationStorageFallback: false }
    });
    const result = await resolver.getOrganization({ organization_id: 'tenant' });
    assert.ok(result.error);
    assert.equal(requests.length, 1);
});

test('an unknown hostname alone cannot fabricate an organization identity', async t => {
    const { resolver, requests } = await createTenantResolver(t, { missingPlatform: true });
    const result = await resolver.getOrganization({ host: 'unknown.example.com' });
    assert.ok(result.error);
    assert.equal(requests.length, 1);
});

test('Socket Server local orgDisconnected clears only that organization resolver cache', async t => {
    const { SocketServer } = await import('../../socket/src/server/index.js');
    const previous = new Set(process.listeners('orgDisconnected'));
    const resolver = new GetOrganization();
    t.after(() => {
        for (const listener of process.listeners('orgDisconnected')) {
            if (!previous.has(listener)) process.removeListener('orgDisconnected', listener);
        }
    });
    resolver.organizations.tenant = { _id: 'tenant' };
    resolver.organizations.other = { _id: 'other' };
    resolver.hosts['tenant.test'] = 'tenant';
    resolver.hosts['alias.test'] = { _id: 'tenant' };
    resolver.hosts['other.test'] = { _id: 'other' };
    SocketServer.prototype.emitOrganizationDisconnected.call({}, 'tenant', { reason: 'idle' });
    assert.equal(resolver.organizations.tenant, undefined);
    assert.equal(resolver.hosts['tenant.test'], undefined);
    assert.equal(resolver.hosts['alias.test'], undefined);
    assert.deepEqual(resolver.organizations.other, { _id: 'other' });
    assert.deepEqual(resolver.hosts['other.test'], { _id: 'other' });
});


test('own-organization disconnect clears resolver presence while bootstrap config remains available', async t => {
    const { SocketServer } = await import('../../socket/src/server/index.js');
    const previous = new Set(process.listeners('orgDisconnected'));
    const resolver = new GetOrganization();
    const reports = [];
    const listener = (id, details) => reports.push({ id, details });
    process.on('orgDisconnected', listener);
    t.after(() => {
        for (const item of process.listeners('orgDisconnected')) {
            if (!previous.has(item)) process.removeListener('orgDisconnected', item);
        }
    });
    resolver.organizations.tenant = { _id: 'tenant' };
    resolver.hosts['tenant.test'] = 'tenant';
    const bootstrap = { organization_id: 'tenant', storage: { name: 'bootstrap' } };
    resolver.crud = { config: bootstrap };
    SocketServer.prototype.emitOrganizationDisconnected.call({ server: bootstrap, workerId: 1 }, 'tenant', { reason: 'idle' });
    assert.equal(reports.length, 1);
    assert.equal('retainResources' in reports[0].details, false);
    assert.equal(reports[0].details.workerId, 1);
    assert.equal(resolver.organizations.tenant, undefined);
    assert.equal(resolver.hosts['tenant.test'], undefined);
    assert.equal(resolver.crud.config, bootstrap);
});
