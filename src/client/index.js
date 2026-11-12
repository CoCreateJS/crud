/********************************************************************************
 * Copyright (C) 2023 CoCreate and Contributors.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 ********************************************************************************/

/**
 * Commercial Licensing Information:
 * For commercial use of this software without the copyleft provisions of the AGPLv3,
 * you must obtain a commercial license from CoCreate LLC.
 * For details, visit <https://CoCreateJS.com/licenses/> or contact us at sales@CoCreateJS.com.
 */

import { SocketClient as CoCreateSocket } from "@cocreate/socket";
import {
    ObjectId,
    getValueFromObject,
    getAttributeNames,
    setAttributeNames,
    isValidDate
} from "@cocreate/utils";

const isBrowser = typeof window !== "undefined";
let dbInstance = null;

// Dynamic environmental lazy loading of browser-only storage engines (IndexedDB)
// using a non-awaited promise chain to avoid Node.js require() async errors.
if (isBrowser) {
    import("@cocreate/indexeddb")
        .then((indexeddbModule) => {
            const rawIndexeddb = indexeddbModule.default || indexeddbModule;
            dbInstance = rawIndexeddb && (rawIndexeddb.default || rawIndexeddb);
        })
        .catch((error) => {
            console.warn("[@cocreate/crud/client] Safe Dynamic Fallback: Failed to load browser-only storage engine @cocreate/indexeddb.", error);
        });
}

const CoCreateCRUD = {
    /**
     *
 * @public
 * @environment client
 * @environment server
 */
    socket: CoCreateSocket,
    /**
     *
 * @public
 * @environment client
 * @environment server
 */
    database: isBrowser
        ? window.location.hostname.startsWith("dev.")
            ? "dev"
            : window.location.hostname.startsWith("test.")
                ? "test"
                : ""
        : "",
    /**
     * Performs a crud action using the define method.
     *
     * @see https://CoCreateJS.com/docs/objects.html#send
     * @param {Object} data - Configuration and parameters payload
     * @param {Object} [options] - Local request options
     * @param {boolean} [options.cache=true] - Allow reads from the browser cache
     * @return {Promise} The data read from the defined db's. Errors are logged and can be found in the data object
 * @private
 * @environment client
 * @environment server
 */
    send: async function (data, options = {}) {
        if (!data) return null;
        if (!data.method) {
            // TODO: errorhandler(data, 'data.method is required')
            return data;
        }

        data.timeStamp = new Date().toISOString();

        if (!data.organization_id) {
            data.organization_id = await this.socket.organization_id();
        }

        if (!data.user_id) {
            data.user_id = await this.socket.user_id;
        }

        if (!data.database && this.database) {
            data.database = this.database;
        }

        const forTransport = payload => payload?.method === 'object.update' && Array.isArray(payload.object)
            ? { ...payload, object: payload.object.map(({ $update, ...changes }) => changes) }
            : payload;
        let response;
        if (
            isBrowser && dbInstance && options.cache !== false
        ) {
            response = await dbInstance.send(data);

            const type = data.method.split(".")[0];
            if (
                !this.socket.connected ||
                (type && response?.[type]?.length)
            ) {
                if (response?.object && response?.object[0] && response?.object[0]?.organization_id) {
                    this.socket.send(forTransport(response));
                    return response;
                }
            } else if (
                data.storage === "indexeddb" ||
                (Array.isArray(data.storage) &&
                    data.storage.length === 1 &&
                    data.storage[0] === "indexeddb")
            ) {
                return response;
            }
        }

        return await this.socket.send(forTransport(response || data));
    },

    listen: function (method, callback) {
        this.socket.listen(method, callback);
    },

    syncListeners: function () {
        const type = [
            "storage",
            "database",
            "array",
            "index",
            "object"
        ];
        const method = ["create", "read", "update", "delete"];

        for (let i = 0; i < type.length; i++) {
            for (let j = 0; j < method.length; j++) {
                const action = type[i] + "." + method[j];
                const self = this;
                this.listen(action, function (data) {
                    self.sync(data);
                });
            }
        }
    },

    sync: async function (data) {
        if (!data.database && this.database) {
            data.database = this.database;
        }

        if (
            dbInstance &&
            data.uuid &&
            data.status &&
            data.status == "received" &&
            !data.synced
        ) {
            if (data.method.endsWith(".read")) {
                if (this.socket.frameId === data.frameId) {
                    const self = this;
                    let type = data.method.split(".")[0];
                    if (!data[type] || !data[type].length) return;
                    // let deletedItems = await this.getDeletedItems()
                    let isDeleted = ""; // this.isDeleted(type, items[i], deletedItems)

                    if (isDeleted) {
                        console.log("sync failed item recently deleted");
                    } else {
                        for (let i = 0; i < data[type].length; i++) {
                            let key, value;
                            if (
                                data[type][i].updated &&
                                data[type][i].updated.on
                            ) {
                                key = "updated.on";
                                value = data[type][i].updated.on;
                            } else if (
                                data[type][i].created &&
                                data[type][i].created.on
                            ) {
                                key = "created.on";
                                value = data[type][i].created.on;
                            } else continue;

                            let response = {
                                clientId: data.clientId,
                                frameId: data.frameId,
                                socketId: data.socketId,
                                method: type + ".read",
                                user_id: data.user_id,
                                organization_id: data.organization_id
                            };
                            if (data.database) {
                                response.database = data.database;
                            }

                            if (type === "object") {
                                response[type] = {
                                    _id: data[type][i]._id
                                };
                                response.array = data.array;
                            } else {
                                response[type] = data[type][i].name;
                            }

                            response = await dbInstance.send(response);
                            let objLength = Object.keys(response[type][0]).length;
                            if (
                                !response[type].length ||
                                (type === "object" &&
                                    response[type][0] &&
                                    response[type][0]._id &&
                                    objLength === 1)
                            ) {
                                response.method = type + ".create";
                                response[type] = data[type][i];
                                response.synced = true;
                                response = await dbInstance.send(response);

                                self.socket.sendLocalMessage(response);
                            } else {
                                let queryValue = value;
                                let dataValue = getValueFromObject(
                                    response[type][0],
                                    key
                                );
                                if (
                                    isValidDate(queryValue) &&
                                    isValidDate(dataValue)
                                ) {
                                    queryValue = new Date(queryValue);
                                    dataValue = new Date(dataValue);
                                } else if (
                                    !response[type][0].organization_id
                                ) {
                                    console.log("invalid date");
                                }

                                if (dataValue < queryValue) {
                                    response.method = type + ".update";
                                    response[type] = data[type][i];
                                    response.synced = true;
                                    response = await dbInstance.send(response);

                                    self.socket.sendLocalMessage(response);
                                }
                            }
                        }
                    }
                }
            } else if (
                !data.synced && this.socket.frameId === data.receiverFrameId
            ) {
                data.synced = true;
                const cached = { ...data, object: data.object?.map(record => structuredClone(record)) };
                if (data.method === 'object.update' && data.object?.some(record => record.$set || record.$unset))
                    cached.upsert = false;
                await dbInstance.send(cached);
                // self.socket.sendLocalMessage(response);
            }
        }
    },

    syncServer: function () {
        const self = this;
        const promise = indexedDB.databases();
        promise.then((databases) => {
            for (let database of databases) {
                if (
                    !["socketSync", "crudSync"].includes(database.name)
                ) {
                    let dbRequest = indexedDB.open(database.name);
                    dbRequest.onsuccess = function () {
                        let db = dbRequest.result;
                        let objectStoreNames = Array.from(
                            db.objectStoreNames
                        );

                        let arrayLength = objectStoreNames.length;
                        for (let array of objectStoreNames) {
                            let transaction = db.transaction(
                                [array],
                                "readonly"
                            );
                            let objectStore =
                                transaction.objectStore(array);

                            let objectRequest = objectStore.getAll();
                            objectRequest.onsuccess = function () {
                                arrayLength -= 1;
                                let data = {
                                    method: "syncServer",
                                    database: database.name,
                                    array,
                                    object: objectRequest.result
                                };
                                self.socket.send(data);
                                console.log("sync success", {
                                    database: database.name,
                                    array
                                });
                                if (!arrayLength && db.close) {
                                    db.close();
                                    console.log("sync completed");
                                }
                            };

                            objectRequest.onerror = function () {
                                console.log("sync failed", {
                                    database: database.name,
                                    array
                                });
                                if (!arrayLength && db.close) {
                                    db.close();
                                    console.log("sync completed");
                                }
                            };
                        }
                    };

                    dbRequest.onerror = function () {
                        console.log(dbRequest.error, database);
                    };
                }
            }
        });
    },

    ObjectId,
    getValueFromObject,
    getAttributeNames,
    setAttributeNames
};

if (isBrowser) {
    CoCreateCRUD.syncListeners();
    let attributes = {
        // attribute | variable
        host: "host",
        organization_id: "organization_id",
        apikey: "apikey",
        storage: "storage",
        database: "database",
        array: "array",
        object: "object",
        key: "key",
        updateName: "updateName",
        index: "index",
        crud: "isCrud",
        crdt: "isCrdt",
        realtime: "isRealtime",
        save: "isSave",
        update: "isUpdate",
        delete: "isDelete",
        upsert: "isUpsert",
        read: "isRead",
        listen: "isListen",
        broadcast: "broadcast",
        "broadcast-sender": "broadcastSender",
        "broadcast-client": "broadcastClient",
        namespace: "namespace",
        room: "room"
    };

    if (!window.CoCreateConfig) window.CoCreateConfig = { attributes };
    else if (!window.CoCreateConfig.attributes)
        window.CoCreateConfig.attributes = attributes;
    else setAttributeNames(attributes, false);
}

export { CoCreateCRUD as crudClient };
export default CoCreateCRUD;

/**
 * A high-performance, multi-tenant CRUD client for CoCreate. Execute create, read, update, delete, and real-time synchronization operations against one or multiple storage providers using a unified API. Supports parallel persistence across databases such as MongoDB, SQLite, PostgreSQL, and other CoCreate storage adapters.
 *
 * @module @cocreate/crud/client
 * @environment client
 * @environment server
 */
