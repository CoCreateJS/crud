import assert from 'node:assert/strict';
import test from 'node:test';

import { GetOrganization } from '../src/getOrganization.js';
import { isPlatformArray } from '../src/routing.js';

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
