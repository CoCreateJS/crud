# @cocreate/crud

Unified CoCreate CRUD package containing the client and server implementations. This package combines the existing `@cocreate/crud-client` and `@cocreate/crud-server` source trees while those packages remain available independently during migration.

## Entry points

```js
import { crudServer } from '@cocreate/crud';
import { crudClient } from '@cocreate/crud/client';
```

The package root resolves to the server implementation in Node and the client implementation in browsers. The source lives in `src/server` and `src/client`; matching tests live in `test/server` and `test/client`.

## Server

The server runtime accepts a unified payload and routes operations to configured storage adapters. Initialize it with the CoCreate server, then call `send()` with CRUD envelopes.

---

## Table of Contents

* [Features](#features)
* [Supported Database Engines](#supported-database-engines)
* [Installation](#installation)
* [Usage](#usage)
A high-performance, multi-tenant database orchestration and synchronization routing layer.

The server runtime accepts a single standardized payload object and routes it to the appropriate storage adapters (one or many) and transports (local drivers, remote sockets).

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
- When targeting multiple storages use the `storage` array; the router runs each adapter in parallel and returns consolidated responses.
- Bootstrap values are loaded through `Config.prompt`. Local configuration under `crud` is then merged over the bootstrap values, followed by scoped platform `servers_config` records with `type: "crud"`. Database configuration has the highest precedence.
- `organizationStorageFallback` controls routing when an organization has no storage. Its optional `storage` names a platform storage; when omitted, the platform default is used. `database: "$organization_id"` keeps a database per tenant, while another string selects a literal shared database. Set the option to `false` to disable fallback. File requests retain host-owned routing and always use the platform default storage with the requesting organization database when storage fallback is needed.
- For long-running operations or streaming transports (AI sessions), implement plugin-level session tracking and persist conversation history via `server.crud` on the server side.

Contributing
Contributions are welcome. See CONTRIBUTING.md in the repo for guidance and tests.

License
This software is dual-licensed under AGPLv3 and a commercial license. See the repository LICENSE file for details.

## Comparing read storage on a development server

`COCREATE_CRUD_READ_STORAGE=db` forces `object.read` through the registered local DB driver after CRUD bootstrap configuration has loaded and host/database routing has resolved. `COCREATE_CRUD_READ_DATABASE=dev` limits that override to the `dev` database. Every array in that database uses the selected storage, including nested file rendering and data reads. Other databases and create/update/delete requests keep their configured routing. With no read-storage override, normal configured storage selection applies; the provider is not hardcoded to MongoDB.

For example, start the server with its existing data directory and an explicit benchmark scope:

```sh
COCREATE_DB_DIRECTORY=/path/to/existing/db \
COCREATE_CRUD_READ_STORAGE=db \
COCREATE_CRUD_READ_DATABASE=dev \
node src/index.js
```

Restart without `COCREATE_CRUD_READ_STORAGE` to restore the configured default. Use the same file contents, server settings, warmup, HTTP client, and paths for both runs. This override changes read routing only; it does not copy data or synchronize storage providers.
