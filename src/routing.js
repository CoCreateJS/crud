/********************************************************************************
 * Copyright (C) 2026 CoCreate and Contributors.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 ********************************************************************************/

const platformArrays = new Set([
    'servers',
    'servers_usage',
    'servers_telemetry',
    'servers_bandwidth'
]);

export function isPlatformArray(array) {
    return platformArrays.has(array);
}
