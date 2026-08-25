# @cocreate/crud-server

A high-performance, multi-tenant database orchestration and synchronization routing layer. It dynamically manages distributed data architectures, allowing applications to read from and write to multiple databases simultaneously in parallel using a single unified payload object. It handles tenant-isolated workspace caching, orchestrates cross-database data synchronization, and bridges real-time WebSocket communication matrices with structural persistence.

---

## Table of Contents

* [Features](#features)
* [Supported Database Engines](#supported-database-engines)
* [Installation](#installation)
* [Usage](#usage)
A high-performance, multi-tenant database orchestration and synchronization routing layer.

This README focuses on the unified payload contract and practical examples so integrators immediately understand how to use the server-side CRUD router. The `@cocreate/crud-server` runtime accepts a single standardized payload object and routes it to the appropriate storage adapters (one or many) and transports (local drivers, remote sockets).

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
npm install @cocreate/crud-server
```

Quick start — initialize during server bootstrap
```javascript
import crudServer from '@cocreate/crud-server';
import CoCreateServer from '@cocreate/server';

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

Core payload contract
- `method` (String) — dot-notated action identifier, e.g. `object.create`, `object.read`, `object.update`, `array.list`.
- `organization_id` (String) — tenant identifier (required for multi-tenant deployments).
- `array` (String) — logical collection/table name.
- `storage` (String | Array<String>) — named storage adapter(s) to target. When an array is supplied, the same payload runs in parallel against each matching driver.
- `object` (Array<Object>) — document(s) for create/update/delete operations.
- `$filter` (Object) — optional query, paging, sort and projection controls.

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
  $filter: { query: { email: 'alice@example.com' }, limit: 1 }
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
- The client-side `@cocreate/crud-client` sends the same unified payload via `crud.send()` which will route the request locally (IndexedDB) and remotely via `crud.socket.send()`.
- On the server, socket messages map directly into the same `crudServer.send(payload)` contract. This keeps the client and server API identical and stateless.

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
- For long-running operations or streaming transports (AI sessions), implement plugin-level session tracking and persist conversation history via `server.crud` on the server side.

Contributing
Contributions are welcome. See CONTRIBUTING.md in the repo for guidance and tests.

License
This software is dual-licensed under AGPLv3 and a commercial license. See the repository LICENSE file for details.