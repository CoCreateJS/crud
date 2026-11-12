# @cocreate/crud

Unified CoCreate CRUD package containing the client and server implementations. This package combines the existing `@cocreate/crud-client` and `@cocreate/crud-server` source trees while those packages remain available independently during migration.

## Entry points

```js
import { crudServer } from '@cocreate/crud';
import { crudClient } from '@cocreate/crud/client';
```

The package root resolves to the server implementation in Node and the client implementation in browsers. The source lives in `src/server` and `src/client`; matching tests live in `test/server` and `test/client`.

## Server

The server runtime resolves organization/hostname defaults and sends operations directly to CoCreateDB. Initialize it with the CoCreate server, then call `send()` with CRUD envelopes.

---

## Table of Contents

* [Features](#features)
* [Supported Database Engines](#supported-database-engines)
* [Installation](#installation)
* [Usage](#usage)
A high-performance, multi-tenant database orchestration and synchronization routing layer.

The server runtime accepts a standardized payload with organization, logical storage, database, and array scope. CoCreateDB executes it; the existing transports deliver results.

Summary
- Single, unified payload contract drives all operations (`method` determines behavior).
- Operates in multi-tenant mode using `organization_id` to scope execution.
- Supports parallel write/read across multiple storage adapters via `storage` array.

Table of contents
- Features
- Installation
- Quick start (server initialization)
- Payload examples (common tasks)
- WebSocket & transport patterns
- Configuration & tips
- Contributing
- License

Features
- Unified object payload API for all CRUD operations.
- Multi-tenant isolation by `organization_id`.
- Parallel multi-storage execution when `storage` is an array.
- Pluggable drivers via dynamic `import()`.
- WebSocket integration for real-time actions and synchronization.

Installation
```bash
npm install @cocreate/crud
```

Quick start — initialize during server bootstrap
```javascript
import { crudServer } from '@cocreate/crud';
import CoCreateServer from '@cocreate/cluster';

const server = await CoCreateServer.start();
await crudServer.init(server);

// After init, you can call the router directly
await crudServer.send({
  organization_id: 'org1',
  method: 'object.create',
  array: 'users',
  storage: 'mongodb',
  object: [{ name: 'Alice', email: 'alice@example.com' }]
});
```

Bootstrap storage configuration

`CoCreate.config.js` stores a single flat bootstrap connection:

```javascript
export default {
  storage: {
    name: 'platform-mongodb',
    provider: 'mongodb',
    connectionString: 'mongodb://host/platform'
  }
};
```

Startup uses `Config.prompt()` to request a single valid JSON storage object
when storage is not configured. Include non-empty `name` and `provider` strings
and the credential fields required by the driver. For example:
`{"name":"primary","provider":"mongodb","connectionString":"mongodb://host/platform"}`.
Credential field names and nested credential objects are preserved as supplied;
the driver validates its connection requirements. Valid prompt input is parsed
before it is saved as the global `storage` object. Existing local, global, or
environment configuration is used without prompting. Storage is selected as one
complete object; local and global credential fields are not merged. Omit local
`storage` to inherit the global object. The environment carries the object as
JSON for child processes.

Bootstrap storage and named `apis` storage records are passed unchanged to the
driver as `storageConfig`. Bootstrap arrays and maps keyed by connection name are
not supported. Omit a CRUD request's `storage` to use the bootstrap connection,
or specify its exact name. Other names resolve enabled storage records from
`apis` using the bootstrap connection.

Core payload contract
- `method` (String) — dot-notated action identifier, e.g. `object.create`, `object.read`, `object.update`, `array.list`.
- `organization_id` (String) — tenant identifier (required for multi-tenant deployments).
- `array` (String) — logical collection/table name.
- `storage` (String | Array<String>) — named storage adapter(s) to target. When an array is supplied, the same payload runs in parallel against each matching driver.
- `object` (Array<Object>) — document(s) for create/update/delete operations.
- `filter` (Object) — optional query, paging, sort and projection controls.

Examples — common operations

Create
```javascript
await crudServer.send({
  method: 'object.create',
  organization_id: 'org1',
  array: 'posts',
  storage: 'mongodb',
  object: [{ title: 'Hello', body: 'World' }]
});
```

Read (with filter)
```javascript
const res = await crudServer.send({
  method: 'object.read',
  organization_id: 'org1',
  array: 'users',
  filter: { query: { email: 'alice@example.com' }, limit: 1 }
});
```

Update (parallel to two storages)
```javascript
await crudServer.send({
  method: 'object.update',
  organization_id: 'org1',
  array: 'users',
  storage: ['mongodb','pgsql-backup'],
  object: [{ _id: 'abc123', active: true }]
});
```

Delete
```javascript
await crudServer.send({
  method: 'object.delete',
  organization_id: 'org1',
  array: 'sessions',
  object: [{ _id: 'session_xyz' }]
});
```

WebSocket / transport patterns
- The client-side `@cocreate/crud/client` sends the same unified payload via `crud.send()` and can route eligible requests through IndexedDB and the CoCreate socket client.
- On the server, socket messages map directly into the same `crudServer.send(payload)` contract. This keeps the client and server API identical and stateless.

`await crudServer.send(payload)` returns the processed storage response independently of message delivery. Delivery failures are reported without retrying the operation or leaving its promise pending. Only successful create, update, and delete operations emit `crud-event`; reads do not invalidate authorization caches.

When SocketServer redirects storage authorization to the platform organization, its trusted `replyOrganizationId` preserves the original tenant response scope. Private application queries, including credential lookups, omit client destinations, broadcast flags, and the outer request UUID. The application's final response retains those reply fields.

Example: sending an AI prompt to a Copilot plugin (convention)
```javascript
// client: send via crud.socket.send
await crud.socket.send({
  method: 'copilot.chat',
  copilot: {
    prompt: 'Generate a hero section',
    organization_id: 'org1',
    user_id: 'u1'
  }
});

// server plugin receives payload and routes to AI engine
// plugin will read payload.copilot and persist history using server.crud
```

Configuration & tips
- Ensure `organization_id` is supplied for multi-tenant routing.
- `storage` is one logical DB namespace, defaulting to `production`; `database` defaults to `app`. Explicit values take precedence over hostname defaults. Array is passed through unchanged.
- Bootstrap values are loaded through `Config.prompt`. Local configuration under `crud` is then merged over the bootstrap values, followed by scoped platform `servers_config` records with `type: "crud"`. Database configuration has the highest precedence.
- `organizationStorageFallback` controls routing when an organization has no storage. Its optional `storage` names a platform storage; when omitted, the platform default is used. `database: "$organization_id"` keeps a database per tenant, while another string selects a literal shared database. Set the option to `false` to disable fallback. File requests retain host-owned routing and always use the platform default storage with the requesting organization database when storage fallback is needed.
- For long-running operations or streaming transports (AI sessions), implement plugin-level session tracking and persist conversation history via `server.crud` on the server side.

Contributing
Contributions are welcome. See CONTRIBUTING.md in the repo for guidance and tests.

License
This software is dual-licensed under AGPLv3 and a commercial license. See the repository LICENSE file for details.

## Temporary direct CoCreateDB testing

The dispatcher calls the imported DB service directly for every CRUD operation, including bootstrap reads. It does not call GetDriver. Storage names are logical namespaces and are preserved. Normal response delivery and mutation events remain in place. Provider helpers are retained for a later persistence pass.

This is uncommitted integration-testing code, not the finalized storage architecture. The CoCreate Server entry point defaults `COCREATE_DB_DIRECTORY` to the existing sibling `CoCreateDB` directory for this test; an explicitly configured directory still takes precedence. Start normally with `yarn start` from CoCreate Server. No provider-selection environment variables are required. The selected DB must contain the organization, configuration, and authorization records needed by the applications; records are not copied automatically.


Trusted noninteractive callers can use `init(server, { config: bootstrapConfig })`
to provide `organization_id`, optional `host`, and bootstrap `storage` directly.
This skips configuration prompts and uses the existing organization resolution,
configuration lookup, driver dispatch, response, and mutation-event paths. The
normal `init(server)` behavior is unchanged. The CLI uses this API for `coc crud`.

Standalone callers may omit the server context: `init(undefined, { config })` owns
its local event context and response return. The DB provider uses a registered
instance first, then configured storage modules. If neither exists, CRUD initializes
the local CoCreateDB adapter itself. Storage location belongs to this service:
`COCREATE_DB_DIRECTORY`, configured `db.directory`, `crud.directory`, or
`storage.directory`, then an existing `CoCreateDB` folder in the working directory
or an ancestor workspace. Outside a workspace, the fallback is `.cocreate/db`.
Configured relative paths resolve from `configPath` when supplied. This makes the
same envelope sufficient for CLI callers while preserving a running server's
previously registered distributed DB instance.

### CoCreateDB update results

The DB driver returns changed-field `$set`/`$unset` patches for existing-object
updates, with `_id` and routing references. Reads and creates remain complete
records. Receivers merge patches, and browser cache-only `$update` snapshots stay
out of socket transport. Incoming socket patches are cloned for cache sync and
are not upserted into incomplete browser records when their base is missing.

### Direct DB hierarchy routing

CRUD imports CoCreateDB directly and uses the server DB instance/proxy when
provided. The main dispatch and initialization do not call GetDriver. Existing
driver/provider helper APIs are retained for a later persistence pass.

The request organization_id remains the tenant scope. Explicit storage/database
values win; a hostname fills missing values, followed by production/app defaults.
Storage is a logical DB hierarchy name, never a provider selector. Array is
forwarded unchanged, with no hostname override or default. Internal organization
lookups use production/app and disable hostname fallback explicitly. A configured
organization can bootstrap local CRUD before organization or key records exist.
