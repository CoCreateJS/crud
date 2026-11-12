const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const read = file => fs.readFileSync(path.join(__dirname, '../../src/server', file), 'utf8');
const context = vm.createContext({ getDriver: async () => { throw Error('Unexpected driver lookup'); } });
vm.runInContext(read('getStorage.js').replace(/^import .*;$/gm, '').replace('export async function', 'async function').replace('export default getStorage;', ''), context);
const resolveStorage = context.getStorage;
const source = read('index.js');
const sendCode = source.slice(source.indexOf('async function send(data)'), source.indexOf('\n/**', source.indexOf('async function send(data)')));
async function route(organization, request) {
    let received;
    const send = vm.runInNewContext(sendCode + '\nsend', {
        config: { organization_id: 'platform', storage: { provider: 'mongodb', connectionString: 'unused' }, organizationStorageFallback: false },
        getOrganization: async () => organization,
        db: { send: async data => { received = data; return { ...data, success: true, object: [] }; } },
        getDriver: async () => { throw Error('Unexpected driver selection'); },
        getStorage: async () => { throw Error('Unexpected provider selection'); },
        applyFilterMetadata() {}, sendToServer() {},
        process: { emit() {} }, console
    });
    const response = await send(request);
    assert.equal(response.error, undefined);
    return received;
}

test('legacy provider configuration does not choose a backend or change namespace defaults', async () => {
    const data = await route({ bootstrapStorage: { name: 'mongo', provider: 'mongodb' } }, { method: 'object.read', organization_id: 'tenant', array: 'files' });
    assert.equal(data.storage, 'production');
    assert.equal(data.database, 'app');
    assert.equal(data.array, 'files');
});
test('an explicitly selected logical namespace is independent of provider fallback', async () => {
    const data = await route({}, { method: 'object.read', organization_id: 'tenant', storage: 'development', database: 'website', array: 'files' });
    assert.equal(data.storage, 'development');
    assert.equal(data.database, 'website');
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
