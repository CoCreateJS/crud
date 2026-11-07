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

function fixture({ deliver, driver } = {}) {
    const sent = [];
    const errors = [];
    const events = new EventEmitter();
    const changes = [];
    events.on('crud-event', data => changes.push(data));
    const send = vm.runInNewContext(`${helper}\n${dispatcher}\nsend`, {
        server: { send(data) { sent.push(data); return deliver?.(data); } },
        config: { organization_id: 'platform' },
        getOrganization: async () => ({}),
        getStorage: async () => ({ provider: 'mock', secret: 'storage-secret' }),
        getDriver: async () => ({ send: driver || (async data => ({ ...data, object: [{ _id: 'record' }] })) }),
        includesFileArray: () => false,
        isPlatformArray: () => false,
        resolveOrganizationStorageFallback: () => null,
        applyFilterMetadata() {},
        process: events,
        console: { error: (...args) => errors.push(args) }
    });
    return { send, sent, errors, changes };
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
