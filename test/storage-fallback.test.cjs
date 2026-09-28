const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const read = file => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8');
const context = vm.createContext({ getDriver: async () => { throw Error('Unexpected driver lookup'); } });
vm.runInContext(read('getStorage.js').replace(/^import .*;$/gm, '').replace('export async function', 'async function').replace('export default getStorage;', ''), context);
const resolveStorage = context.getStorage;
const normalizeStorageCredentials = context.normalizeStorageCredentials;
const fallbackModules = Promise.all([
    import('../src/routing.js'),
    import('../src/storageFallback.js')
]);
const index = read('index.js');
const start = index.indexOf('                let storage = await getStorage(');
const block = index.slice(start, index.indexOf('                if (storage && storage.provider)', start));
async function route(organization, data, config) {
    const [{ includesFileArray }, { resolveOrganizationStorageFallback }] = await fallbackModules;
    return vm.runInNewContext('(async () => {' + block + 'return storage;})()', {
        organization, data, config, storageNames: [undefined], i: 0,
        includesFileArray,
        resolveOrganizationStorageFallback,
        getStorage: (organization, organizationId, name) => resolveStorage({ organization, organizationId, name })
    });
}
const config = { organization_id: 'platform', storage: { provider: 'mongodb', url: 'platform-url' } };
test('missing tenant storage returns no result', async () => {
    assert.equal(await resolveStorage({ organization: {}, organizationId: 'tenant' }), undefined);
});
test('provider-facing credential names normalize to driver url configuration', () => {
    assert.equal(normalizeStorageCredentials({ provider: 'mysql', connectionUri: 'mysql://database' }).url, 'mysql://database');
    assert.deepEqual(
        JSON.parse(JSON.stringify(normalizeStorageCredentials({
            provider: 'firestore', projectId: 'project', clientEmail: 'service@example.com', privateKey: 'private'
        }).url)),
        { projectId: 'project', clientEmail: 'service@example.com', privateKey: 'private' }
    );
    assert.deepEqual(
        JSON.parse(JSON.stringify(normalizeStorageCredentials({
            provider: 'dynamodb', region: 'us-east-1', accessKeyId: 'access', secretAccessKey: 'secret'
        }).url)),
        { region: 'us-east-1', accessKeyId: 'access', secretAccessKey: 'secret' }
    );
});
for (const host of ['platform.example.com', 'custom.example.com']) {
    test(`fallback forces tenant database regardless of host: ${host}`, async () => {
        const organization = { _id: 'tenant' };
        const data = { organization_id: 'tenant', database: 'another-database', host };
        const storage = await route(organization, data, config);
        assert.equal(storage.url, 'platform-url');
        assert.equal(data.database, 'tenant');
        assert.equal(organization.storage, undefined);
    });
}
test('configured storage preserves explicitly requested database', async () => {
    const data = { organization_id: 'platform', database: 'new-tenant' };
    assert.equal((await route(config, data, config)).url, 'platform-url');
    assert.equal(data.database, 'new-tenant');
});
test('configured fallback can route tenants to a shared database', async () => {
    const data = { organization_id: 'tenant' };
    const fallbackConfig = {
        ...config,
        organizationStorageFallback: { database: 'shared-database' }
    };
    assert.equal((await route({}, data, fallbackConfig)).url, 'platform-url');
    assert.equal(data.database, 'shared-database');
});
test('file fallback always keeps the tenant database', async () => {
    const data = { organization_id: 'tenant', array: 'files' };
    const fallbackConfig = {
        ...config,
        organizationStorageFallback: { database: 'shared-database' }
    };
    assert.equal((await route({}, data, fallbackConfig)).url, 'platform-url');
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
test('invalid tenant storage still reports configuration error', async () => {
    await assert.rejects(route({storage: {provider:'mongodb'}}, {organization_id:'tenant'}, config), /not configured/);
});
test('missing server storage reports an error', async () => {
    await assert.rejects(route({}, {organization_id:'tenant'}, {organization_id:'platform'}), /Server storage is not configured/);
});
