import assert from 'node:assert/strict';
import test from 'node:test';
import Config, { registerAdapter } from '../../../config/src/core.js';
import { promptBootstrapStorage } from '../../src/server/bootstrapStorage.js';

function configure({ local = {}, global = {}, env = {}, answers = [] } = {}) {
    Config.clear();
    const state = { global: structuredClone(global), env, questions: [] };
    registerAdapter({
        isBrowser: false,
        loadConfig: async () => structuredClone(local),
        getGlobalConfig: async () => structuredClone(state.global),
        setGlobalConfig: async value => { state.global = structuredClone(value); },
        getEnv: key => state.env[key],
        setEnv: (key, value) => { state.env[key] = typeof value === 'object' ? JSON.stringify(value) : value; },
        prompt: async question => {
            state.questions.push(question);
            assert.ok(answers.length, `Unexpected prompt: ${question}`);
            return answers.shift();
        }
    });
    return state;
}

test('one valid JSON answer is saved globally as an object', async () => {
    const expected = { name: 'primary', provider: 'mongodb', connectionString: 'mongodb://example/platform' };
    const state = configure({ global: { unrelated: true }, answers: [JSON.stringify(expected)] });
    const storage = await promptBootstrapStorage(Config);
    assert.deepEqual(storage, expected);
    assert.deepEqual(state.global.storage, expected);
    assert.equal(typeof state.global.storage, 'object');
    assert.equal(state.global.unrelated, true);
    assert.deepEqual(JSON.parse(state.env.storage), expected);
    assert.equal(Config.get('storage'), storage);
    assert.equal(state.questions.length, 1);
    assert.match(state.questions[0], /valid JSON object/);
});

test('global storage is used as a complete object without prompting', async () => {
    const expected = { name: 'global', provider: 'mysql', connectionUri: 'mysql://global/platform' };
    const state = configure({ local: { host: 'example.com' }, global: { storage: expected } });
    assert.deepEqual(await promptBootstrapStorage(Config), expected);
    assert.equal(state.questions.length, 0);
});

test('local storage is used without merging or overwriting global credentials', async () => {
    const local = { name: 'local', provider: 'custom', credentials: { apiKey: 'local-key' } };
    const global = { name: 'global', provider: 'mysql', connectionUri: 'mysql://global/platform' };
    const state = configure({ local: { storage: local }, global: { storage: global } });
    assert.deepEqual(await promptBootstrapStorage(Config), local);
    assert.deepEqual(state.global.storage, global);
    assert.equal(state.questions.length, 0);
});

test('arbitrary provider credentials and nested fields are preserved', async () => {
    const expected = {
        name: 'custom-store', provider: 'custom-provider', apiKey: 'example-key',
        credentials: { endpoint: 'https://example.com', options: { region: 'example' } }
    };
    const state = configure({ answers: [JSON.stringify(expected)] });
    assert.deepEqual(await promptBootstrapStorage(Config), expected);
    assert.deepEqual(state.global.storage, expected);
});

test('inherited JSON bootstrap configuration preserves the connection record', async () => {
    const expected = { _id: 'provider-id', name: 'mongo', provider: 'mongodb', connectionString: 'mongodb://env/platform', enabled: true };
    const state = configure({ env: { storage: JSON.stringify(expected) } });
    assert.deepEqual(await promptBootstrapStorage(Config), expected);
    assert.equal(state.questions.length, 0);
});

for (const [label, answer] of [
    ['malformed JSON', '{"name":"primary","secret":"sensitive"'],
    ['single quoted JSON', "{'name':'primary','provider':'mongodb'}"],
    ['a trailing comma', '{"name":"primary","provider":"mongodb",}'],
    ['an array', '[{"name":"primary","provider":"mongodb"}]'],
    ['null', 'null'],
    ['a primitive', '42'],
    ['a missing name', '{"provider":"mongodb"}'],
    ['a missing provider', '{"name":"primary"}'],
    ['an empty name', '{"name":"  ","provider":"mongodb"}'],
    ['a non-string provider', '{"name":"primary","provider":{}}']
]) {
    test(`rejects ${label} before saving any storage`, async () => {
        const state = configure({ global: { unrelated: true }, answers: [answer] });
        await assert.rejects(promptBootstrapStorage(Config), error => {
            assert.match(error.message, /Bootstrap storage must be/);
            assert.ok(!error.message.includes('sensitive'));
            return true;
        });
        assert.deepEqual(state.global, { unrelated: true });
        assert.equal(state.env.storage, undefined);
        assert.equal(Config.get('storage'), null);
    });
}

test('an invalid configured object fails without prompting or overwriting it', async () => {
    const invalid = { mongodb: { provider: 'mongodb', connectionString: 'mongodb://example' } };
    const state = configure({ global: { storage: invalid } });
    await assert.rejects(promptBootstrapStorage(Config), /name and provider/);
    assert.deepEqual(state.global.storage, invalid);
    assert.equal(state.questions.length, 0);
});
