const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../../src/client/index.js'), 'utf8');
const send = source.slice(source.indexOf('send: async function'), source.indexOf('    listen: function')).trim().replace(/,$/, '');
function client(cached) {
    const sent = [];
    const server = { object: [{ _id: 'server-only-record' }] };
    const crud = vm.runInNewContext('({' + send + '})', {
        isBrowser: true,
        dbInstance: { send: async data => ({ ...data, object: cached }) }
    });
    crud.socket = { connected: true, organization_id: async () => 'org', user_id: 'user',
        send: async data => { sent.push(data); return server; } };
    return { crud, sent, server };
}
for (const storage of ['mongodb', ['mongodb'], undefined]) {
    test(`empty cached page reaches server: ${JSON.stringify(storage)}`, async () => {
        const { crud, sent, server } = client([]);
        const result = await crud.send({ method: 'object.read', storage, array: 'files', filter: { index: 24, limit: 24, loadMore: true } });
        assert.equal(result, server);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].filter.index, 24);
        assert.equal(sent[0].filter.loadMore, true);
    });
}
for (const storage of ['indexeddb', ['indexeddb']]) {
    test(`explicit local read stays local: ${JSON.stringify(storage)}`, async () => {
        const { crud, sent } = client([]);
        const result = await crud.send({ method: 'object.read', storage, array: 'files' });
        assert.equal(result.object.length, 0);
        assert.equal(sent.length, 0);
    });
}
test('partial cached page still refreshes from server', async () => {
    const cached = [{ _id: 'cached', organization_id: 'org' }];
    const { crud, sent } = client(cached);
    const result = await crud.send({ method: 'object.read', storage: 'mongodb', array: 'files', filter: { index: 24, limit: 24, loadMore: true } });
    assert.equal(result.object, cached);
    assert.equal(sent.length, 1);
});

test('update transport excludes the full cache-only snapshot', async () => {
    const cached = [{ _id: 'id', organization_id: 'org', $set: { name: 'new' }, $update: { _id: 'id', name: 'new', other: 'local' } }];
    const { crud, sent } = client(cached);
    const result = await crud.send({ method: 'object.update', object: { _id: 'id', $set: { name: 'new' } } });
    assert.equal(sent.length, 1);
    assert.equal('$update' in sent[0].object[0], false);
    assert.equal('other' in sent[0].object[0], false);
    assert.equal(sent[0].object[0].$set.name, 'new');
    assert.ok(result.object[0].$update, 'The local caller may still use its cache snapshot');
});

test('received patches do not upsert incomplete cache records or mutate shared socket payloads', async () => {
    const sync = source.slice(source.indexOf('sync: async function'), source.indexOf('    syncServer: function')).trim().replace(/,$/, '');
    let cached;
    const crud = vm.runInNewContext('({' + sync + '})', {
        isBrowser: true, structuredClone,
        dbInstance: { send: async data => { cached = data; data.object[0].$update = { unrelated: 'cache snapshot' }; } }
    });
    crud.socket = { frameId: 'frame' };
    const data = { method: 'object.update', uuid: 'request', status: 'received', receiverFrameId: 'frame',
        object: [{ _id: 'id', $set: { name: 'new' } }], upsert: true };
    await crud.sync(data);
    assert.equal(cached.upsert, false);
    assert.equal('$update' in data.object[0], false);
    assert.equal(data.object[0].$set.name, 'new');
});
