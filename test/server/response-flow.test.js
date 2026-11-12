import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import test from 'node:test';

// Exercise the real dispatcher with isolated storage and transport services.
const source = fs.readFileSync(new URL('../../src/server/index.js', import.meta.url), 'utf8');
const helperStart = source.indexOf('function sendToServer(data)');
const helper = source.slice(helperStart, source.indexOf('\nfunction normalizeOrganizationStorageFallback', helperStart));
const sendStart = source.indexOf('async function send(data)');
const dispatcher = source.slice(sendStart, source.indexOf('\n/**', sendStart));

function fixture({ deliver, driver, organization = {}, env = {}, ready = true } = {}) {
    const sent = [];
    const errors = [];
    const events = new EventEmitter();
    events.env = env;
    const changes = [];
    const storageLookups = [];
    const driverLookups = [];
    events.on('crud-event', data => changes.push(data));
    const send = vm.runInNewContext(`${helper}\n${dispatcher}\nsend`, {
        server: { crud: ready ? {} : null, send(data) { sent.push(data); return deliver?.(data); } },
        config: { organization_id: 'platform' },
        db: { send: driver || (async data => ({ ...data, object: [{ _id: 'record' }] })) },
        getOrganization: async () => organization,
        getStorage: async (...args) => {
            storageLookups.push(args);
            return { provider: 'mock', secret: 'storage-secret' };
        },
        getDriver: async provider => {
            driverLookups.push(provider);
            return { send: driver || (async data => ({ ...data, object: [{ _id: 'record' }] })) };
        },
        includesFileArray: () => false,
        isPlatformArray: () => false,
        resolveOrganizationStorageFallback: () => null,
        applyFilterMetadata() {},
        process: events,
        console: { error: (...args) => errors.push(args) }
    });
    return { send, sent, errors, changes, storageLookups, driverLookups };
}

test('reads return their result without triggering mutation listeners', async () => {
    const f = fixture();
    const result = await f.send({ method: 'object.read', organization_id: 'tenant', array: 'keys' });
    assert.equal(result.object[0]._id, 'record');
    assert.equal(f.sent.length, 1);
    assert.equal(f.changes.length, 0);
});

test('an unrelated socket payload field survives CRUD results, delivery, and mutation events', async () => {
    const f = fixture();
    const socket = { purpose: 'application data' };
    const result = await f.send({ method: 'object.update', organization_id: 'tenant', array: 'records', socket });
    assert.equal(result.socket, socket);
    assert.equal(f.sent[0].socket, socket);
    assert.equal(f.changes[0].socket, socket);
});

test('successful mutations notify cache listeners once; failed writes do not', async () => {
    const f = fixture();
    await f.send({ method: 'object.update', organization_id: 'tenant', array: 'keys' });
    assert.equal(f.changes.length, 1);
    const failed = fixture({ driver: async data => ({ ...data, error: ['write failed'] }) });
    const result = await failed.send({ method: 'object.update', organization_id: 'tenant', array: 'keys' });
    assert.equal(result.error[0], 'write failed');
    assert.equal(failed.changes.length, 0);
    const unsuccessful = fixture({ driver: async data => ({ ...data, success: false }) });
    await unsuccessful.send({ method: 'object.update', organization_id: 'tenant', array: 'keys' });
    assert.equal(unsuccessful.changes.length, 0);
});

for (const mode of ['throw', 'reject', 'pending']) {
    test(`CRUD still resolves when response delivery will ${mode}`, { timeout: 1000 }, async () => {
        const f = fixture({ deliver() {
            if (mode === 'throw') throw new Error('delivery failed');
            if (mode === 'reject') return Promise.reject(new Error('delivery failed'));
            return new Promise(() => {});
        } });
        const result = await f.send({ method: 'object.read', organization_id: 'tenant', array: 'files' });
        assert.equal(result.object[0]._id, 'record');
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(f.sent.length, 1, 'Delivery failure must not retry the CRUD operation or response');
        assert.equal(f.errors.length, mode === 'pending' ? 0 : 1);
    });
}

test('platform storage fallback replies in the original tenant scope', async () => {
    const f = fixture();
    const result = await f.send({
        method: 'object.read', organization_id: 'platform', database: 'platform',
        replyOrganizationId: 'tenant', array: 'files', socketId: 'socket', clientId: 'client', uuid: 'request'
    });
    assert.equal(result.organization_id, 'tenant');
    assert.equal(result.database, 'platform');
    assert.deepEqual(f.sent.map(data => data.organization_id), ['platform', 'tenant']);
    assert.equal(f.sent[1].socketId, 'socket');
    assert.equal(f.sent[1].uuid, 'request');
    assert.equal('replyOrganizationId' in f.sent[1], false);
});

test('driver failures return an error without exposing storage credentials', async () => {
    const f = fixture({ driver: async () => { throw new Error('database failed'); } });
    const result = await f.send({ method: 'object.read', organization_id: 'tenant', array: 'files' });
    assert.equal(result.error, 'database failed');
    assert.equal(result.storageConfig, undefined);
    assert.equal(f.sent[0].storageConfig, undefined);
});


for (const type of ['object', 'array', 'database']) {
    for (const operation of ['create', 'read', 'update', 'delete']) {
        test(`direct DB dispatch handles ${type}.${operation} without routing environment variables`, async () => {
            const f = fixture();
            const response = await f.send({
                method: `${type}.${operation}`, organization_id: 'tenant', database: 'dev', array: 'files'
            });
            assert.equal(response.error, undefined);
            assert.equal(response.storage, 'production');
            assert.deepEqual(f.driverLookups, []);
            assert.equal(f.storageLookups.length, 0);
        });
    }
}

test('direct DB dispatch executes a mutation once despite old client storage names', async () => {
    const f = fixture();
    await f.send({ method: 'object.update', organization_id: 'tenant', database: 'dev', array: 'files', storage: 'development' });
    assert.deepEqual(f.driverLookups, []);
    assert.equal(f.storageLookups.length, 0);
    assert.equal(f.changes.length, 1);
});

test('direct DB dispatch covers platform databases and bootstrap reads', async () => {
    const f = fixture({ ready: false });
    await f.send({ method: 'object.read', organization_id: 'tenant', database: 'platform', array: 'organizations' });
    assert.deepEqual(f.driverLookups, []);
    assert.equal(f.storageLookups.length, 0);
});

test('direct DB dispatch does not pass old storage credentials to DB', async () => {
    const f = fixture({ driver: async data => {
        assert.equal(data.storageConfig, undefined);
        return { ...data, object: [] };
    } });
    await f.send({ method: 'object.read', organization_id: 'tenant', array: 'files', storageConfig: { provider: 'mongodb', secret: 'old' } });
    assert.deepEqual(f.driverLookups, []);
});

test('bootstrap selects DB and publishes CRUD before awaiting database config', () => {
    const initSource = source.slice(source.indexOf('export async function init('), source.indexOf('async function send(data)'));
    assert.match(initSource, /db = server.DB \?\? createDB/);
    assert.equal(initSource.includes("getDriver('db'"), false);
    assert.ok(initSource.indexOf('server.crud = crudServer') < initSource.indexOf('await loadCrudConfig()'));
    assert.equal(initSource.includes('getDriver(primaryStorage.provider)'), false);
});

test('CRUD resolves host defaults, preserves explicit namespace values, and never rewrites array', async () => {
    const organization = { host: [{ name: 'example.test', storage: 'development', database: 'website', array: 'ignored' }] };
    const f = fixture({ organization });
    const defaults = await f.send({ method: 'object.read', organization_id: 'tenant', host: 'example.test', array: 'caller' });
    assert.equal(defaults.storage, 'development');
    assert.equal(defaults.database, 'website');
    assert.equal(defaults.array, 'caller');
    const explicit = await f.send({ method: 'object.read', organization_id: 'tenant', host: 'example.test', storage: 'test', database: 'custom', array: 'caller' });
    assert.equal(explicit.storage, 'test');
    assert.equal(explicit.database, 'custom');
    assert.equal(explicit.array, 'caller');
    const missingArray = await f.send({ method: 'object.read', organization_id: 'tenant', host: 'example.test' });
    assert.equal(missingArray.array, undefined);
    const fallback = await f.send({ method: 'object.read', organization_id: 'tenant' });
    assert.equal(fallback.storage, 'production');
    assert.equal(fallback.database, 'app');
    assert.equal(fallback.array, undefined);
    assert.deepEqual(f.driverLookups, []);
});
