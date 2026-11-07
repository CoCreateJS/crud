const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const read = file => fs.readFileSync(path.join(__dirname, '../../src/server', file), 'utf8');
const context = vm.createContext({ getDriver: async () => { throw Error('Unexpected driver lookup'); } });
vm.runInContext(read('getStorage.js').replace(/^import .*;$/gm, '').replace('export async function', 'async function').replace('export default getStorage;', ''), context);
const resolveStorage = context.getStorage;
const fallbackModules = Promise.all([
    import('../../src/server/routing.js'),
    import('../../src/server/storageFallback.js')
]);
const index = read('index.js');
const start = index.indexOf('let storage = await getStorage(');
const block = index.slice(start, index.indexOf('if (storage && storage.provider)', start));
async function route(organization, data, config) {
    const [{ includesFileArray }, { resolveOrganizationStorageFallback }] = await fallbackModules;
    return vm.runInNewContext('(async () => {' + block + 'return storage;})()', {
        organization, data, config, storageNames: [undefined], i: 0,
        includesFileArray,
        resolveOrganizationStorageFallback,
        getStorage: (organization, organizationId, name) => resolveStorage({ organization, organizationId, name })
    });
}
const config = { organization_id: 'platform', storage: { name: 'platform', provider: 'mongodb', connectionString: 'platform-url' } };
test('missing tenant storage returns no result', async () => {
    assert.equal(await resolveStorage({ organization: {}, organizationId: 'tenant' }), undefined);
});
for (const host of ['platform.example.com', 'custom.example.com']) {
    test(`fallback forces tenant database regardless of host: ${host}`, async () => {
        const organization = { _id: 'tenant' };
        const data = { organization_id: 'tenant', database: 'another-database', host };
        const storage = await route(organization, data, config);
        assert.equal(storage.connectionString, 'platform-url');
        assert.equal(data.database, 'tenant');
        assert.equal(organization.storage, undefined);
    });
}
test('configured storage preserves explicitly requested database', async () => {
    const data = { organization_id: 'platform', database: 'new-tenant' };
    assert.equal((await route(config, data, config)).connectionString, 'platform-url');
    assert.equal(data.database, 'new-tenant');
});
test('configured fallback can route tenants to a shared database', async () => {
    const data = { organization_id: 'tenant' };
    const fallbackConfig = {
        ...config,
        organizationStorageFallback: { database: 'shared-database' }
    };
    assert.equal((await route({}, data, fallbackConfig)).connectionString, 'platform-url');
    assert.equal(data.database, 'shared-database');
});
test('file fallback always keeps the tenant database', async () => {
    const data = { organization_id: 'tenant', array: 'files' };
    const fallbackConfig = {
        ...config,
        organizationStorageFallback: { database: 'shared-database' }
    };
    assert.equal((await route({}, data, fallbackConfig)).connectionString, 'platform-url');
    assert.equal(data.database, 'tenant');
});
test('configured fallback can be disabled', async () => {
    const fallbackConfig = {
        ...config,
        organizationStorageFallback: false
    };
    await assert.rejects(
        route({}, { organization_id: 'tenant' }, fallbackConfig),
        /fallback is disabled/
    );
});
test('tenant storage missing a provider still reports a configuration error', async () => {
    await assert.rejects(route({bootstrapStorage: {name:'invalid'}}, {organization_id:'tenant'}, config), /not configured/);
});
test('missing server storage reports an error', async () => {
    await assert.rejects(route({}, {organization_id:'tenant'}, {organization_id:'platform'}), /Server storage is not configured/);
});

test('bootstrapStorage takes precedence and retains native credentials', async () => {
    const storage = await resolveStorage({
        organizationId: 'tenant',
        organization: {
            bootstrapStorage: { name: 'primary', provider: 'mongodb', connectionString: 'mongodb://tenant' },
            storage: { provider: 'mysql', url: 'legacy-url' }
        },
        name: 'primary'
    });
    assert.equal(storage.provider, 'mongodb');
    assert.equal(storage.name, 'primary');
    assert.equal(storage.connectionString, 'mongodb://tenant');
    assert.equal(storage.url, undefined);
});

test('named storages resolve from the tenant APIs using its bootstrap driver', async () => {
    let request;
    const namedContext = vm.createContext({
        getDriver: async provider => {
            assert.equal(provider, 'mongodb');
            return { send: async data => {
                request = data;
                return { object: [{ name: 'analytics', provider: 'postgresql', connectionUri: 'postgres://analytics' }] };
            } };
        }
    });
    vm.runInContext(read('getStorage.js').replace(/^import .*;$/gm, '').replace('export async function', 'async function').replace('export default getStorage;', ''), namedContext);
    const storage = await namedContext.getStorage({
        organizationId: 'tenant', name: 'analytics',
        organization: { bootstrapStorage: { name: 'primary', provider: 'mongodb', connectionString: 'mongodb://tenant' } }
    });
    assert.equal(storage.connectionUri, 'postgres://analytics');
    assert.equal(storage.url, undefined);
    assert.equal(request.organization_id, 'tenant');
    assert.equal(request.database, 'tenant');
    assert.equal(request.array, 'apis');
    assert.equal(request.filter.query.name, 'analytics');
    assert.equal(request.filter.query.type, 'storage');
    assert.equal(request.filter.query.enabled, true);
    assert.equal(request.storageConfig.connectionString, 'mongodb://tenant');
});

for (const storage of [
    [{ name: 'primary', provider: 'mongodb', connectionString: 'mongodb://db' }],
    { primary: { provider: 'mongodb', connectionString: 'mongodb://db' } }
]) {
    test(`rejects a legacy bootstrap ${Array.isArray(storage) ? 'array' : 'map'}`, async () => {
        await assert.rejects(resolveStorage({
            organization: { storage }, organizationId: 'platform'
        }), /flat object with name and provider/);
    });
}

test('bootstrap default and exact name return the original flat connection unchanged', async () => {
    const storage = { name: 'platform-mysql', provider: 'mysql', connectionUri: 'mysql://db/platform' };
    const organization = { storage };
    assert.equal(await resolveStorage({ organization, organizationId: 'platform' }), storage);
    assert.equal(await resolveStorage({ organization, organizationId: 'platform', name: storage.name }), storage);
    assert.equal(storage.url, undefined);
});
