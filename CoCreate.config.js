export default {
    "organization_id": "",
    "key": "",
    "host": "",
    "crud": {
        "organizationStorageFallback": {
            "database": "$organization_id"
        }
    },
    "sources": [
        {
            "array": "files",
            "object": {
                "_id": "6204253480b409001727b73e",
                "name": "index.html",
                "path": "/docs/crud-server",
                "pathname": "/docs/crud-server/index.html",
                "src": "{{./docs/index.html}}",
                "host": [
                    "*"
                ],
                "directory": "crud-server",
                "content-type": "text/html",
                "public": "true"
            }
        }
    ]
};
