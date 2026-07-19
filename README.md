# @cocreate/crud-server

A high-performance, multi-tenant database orchestration and synchronization routing layer. It dynamically manages distributed data architectures, allowing applications to read from and write to multiple databases simultaneously in parallel using a single unified payload object. It handles tenant-isolated workspace caching, orchestrates cross-database data synchronization, and bridges real-time WebSocket communication matrices with structural persistence.

---

## Table of Contents

* [Features](#features)
* [Supported Database Engines](#supported-database-engines)
* [Installation](#installation)
* [Usage](#usage)
* [How it Works](#how-it-works)
* [Architecture and Payload Specs](#architecture-and-payload-specs)
* [Configuration Guidelines](#configuration-guidelines)
* [How to Contribute](#how-to-contribute)
* [License](#license)

---

## Features

* **Parallel Multi-Database Execution:** Connects seamlessly to multiple storage endpoints simultaneously. Data mutation queries execute in parallel across all defined database engines for immediate multi-source consistency.
* **Unified Object Architecture:** Send data once. A single, standardized data object schema abstractly targets and updates multiple heterogeneous databases in parallel, eliminating the need for database-specific query translation at the application layer.
* **Multi-Tenant Isolation:** Dynamically maps connection strategies by checking unique incoming system `host` configurations or structural `organization_id` tracking elements.
* **Dynamic Driver Pluggability:** Follows a convention-over-configuration strategy to load target database driver utilities lazily via asynchronous dynamic imports.
* **V8 Coalescing Caching Engine:** Features an efficient, state-retaining in-memory pool for fast organization tracking, eliminating redundant disk I/O bottlenecks.
* **Dual-Layer Communication Matrix:** Listens directly for transactional mutations across core function calls (`send()`) or updates data trees over real-time WebSockets using dedicated event hooks.
* **Cross-Organization Synchronization:** Automatically intercepts administration-level document mutations to sync system properties instantly across tenant environments.

---

## Supported Database Engines

The server engine natively resolves external adapters across a wide variety of relational, NoSQL, vector, and distributed architectures using a single unified payload contract:

| Relational & SQL | Cloud NoSQL & Document | Distributed & Edge | Specialized & OLAP |
| :--- | :--- | :--- | :--- |
| • MySQL<br>• PostgreSQL<br>• MariaDB<br>• OracleDB<br>• SQLite | • MongoDB<br>• Firestore<br>• DocumentDB<br>• FerretDB | • CockroachDB<br>• TiDB<br>• PlanetScale<br>• Turso<br>• YugabyteDB | • Amazon Redshift<br>• DynamoDB<br>• CosmosDB<br>• Qdrant *(Vector)*<br>• TimescaleDB *(Time-series)*<br>• Rqlite / Dqlite *(Distributed SQL)* |

---

## Installation

```bash
npm install @cocreate/crud-server
```

---

## Usage

### Server Initialization

Bind the CRUD controller during the initialization workflow of your core `CoCreateServer` context:

```javascript
import crudServer from '@cocreate/crud-server';
import { CoCreateServer } from '@cocreate/server';

// Boot the primary application server instance
const serverContext = await CoCreateServer.start();

// Initialize the stateless routing layer
await crudServer.init(serverContext);
```

### Direct Programmatic CRUD Operations

Execute transactional database updates across configured engines via asynchronous queries using a single unified object:

```javascript
import crudServer from '@cocreate/crud-server';

// This single unified payload object targets and writes to all matching drivers in parallel
const payload = {
  organization_id: "64b9a32e18f21bc56789abcd",
  method: "object.update",
  array: "users",
  storage: ["primary-mongodb", "backup-postgresql"], // Invokes parallel driver execution
  object: [{ _id: "75c2e12a45f91bd45123efab", status: "active" }]
};

const result = await crudServer.send(payload);
```

---

## How it Works

1. **Bootstrap & Driver Injection:** On start, the platform invokes `@cocreate/config` to prompt for missing environment variables, extracts storage configuration blocks, and dynamically pulls matching database driver modules sequentially via `import()`.
2. **WebSocket Handshake Mapping:** If a real-time framework context is present, the server maps system scopes (`storage`, `database`, `array`, `index`, `object`) against mutations (`create`, `read`, `update`, `delete`), registering action event listeners over active socket networks.
3. **Tenant Evaluation Pass:** For every action, `getOrganization()` evaluates incoming tracking tags against memory caches (`hosts` and `organizations`) to load tenant-specific connection rules.
4. **Symmetrical Multi-Database Processing:** Loops through arrays provided inside the `data.storage` key. If an item matches several configured providers, the router breaks down the single unified object payload and routes it concurrently to each designated engine database in an asynchronous parallel loop (`await providers[storage.provider].send(data)`).
5. **Data Formatting & Post-Processing:** Applies server-side filters, manages sorting array indices via utility methods, syncs sensitive profile updates between platform entities, and emits a global `crud-event` event before returning a response.

---

## Architecture and Payload Specs

### Unified Payload Object Schema

The data engine relies heavily on structural, flat parameter objects passed down into the execution chain:

| Field Element | Type | Role |
| --- | --- | --- |
| `organization_id` | `String` | **Required.** Targets the root tenant profile partition mapping to execution databases. |
| `method` | `String` | Operational identifier following dot notations (e.g., `"object.read"`, `"array.update"`). |
| `array` | `String` | Target database collection or sheet name context. |
| `storage` | `String \| Array` | Specific storage adapter name(s). Pass an array of strings to invoke parallel execution across multiple targets. |
| `object` | `Array<Object>` | Raw workspace target objects or tracking query arguments containing targeted IDs (`_id`). |
| `$filter` | `Object` | Extra functional configuration object containing query criteria, array boundaries, limits, and sort constraints. |

---

## Configuration Guidelines

Upon launching the engine for the first time, your terminal context will request essential operational parameters via standard inputs if a local profile isn't active:

```text
Enter your organization_id: 64b9a32e18f21bc56789abcd
Enter a friendly name for the new storage (e.g., primary): primary
Enter the storage provider (e.g., mongodb): mongodb
Enter the storage connection url: mongodb://localhost:27017/cocreate
```

> [!WARNING]
> If a valid configuration URL (`url`) or an `organization_id` cannot be discovered on boot, the system outputs failure diagnostic metrics to the terminal and forcefully triggers a hard process kill state (`process.exit(1)`).

---

## How to Contribute

We encourage contribution to our libraries (you might even score some nifty swag), please see our [CONTRIBUTING.md](https://github.com/CoCreate-app/CoCreate-crud-server/blob/master/CONTRIBUTING.md) guide for details. If you encounter any bugs or wish to make feature requests, please submit an issue on our [GitHub Issues](https://github.com/CoCreate-app/CoCreate-crud-server/issues) tracker. We want this library to be community-driven, and CoCreate led. We need your help to realize this goal.

For broader system configurations and API guides, please visit our [CoCreate CRUD Server Documentation](https://cocreatejs.com/docs/crud-server).

---

## License

This software is dual-licensed under the GNU Affero General Public License version 3 (AGPLv3) and a commercial license.

* **Open Source Use:** For open-source projects and non-commercial use, this software is available under the AGPLv3. For the full license text, see the LICENSE file.
* **Commercial Use:** For-profit companies and individuals intending to use this software for commercial purposes must obtain a commercial license. The commercial license is available when you sign up for an API key on our website.