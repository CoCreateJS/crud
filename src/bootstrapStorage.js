function parseStorage(value) {
    let storage = value;
    if (typeof storage === 'string') {
        try {
            storage = JSON.parse(storage);
        } catch {
            throw new Error('Bootstrap storage must be valid JSON.');
        }
    }
    if (!storage || typeof storage !== 'object' || Array.isArray(storage) ||
        typeof storage.name !== 'string' || !storage.name.trim() ||
        typeof storage.provider !== 'string' || !storage.provider.trim()) {
        throw new Error('Bootstrap storage must be a JSON object containing non-empty name and provider fields.');
    }
    return storage;
}

export async function promptBootstrapStorage(Config) {
    const { storage } = await Config.prompt({
        storage: {
            prompt: 'Enter storage as a valid JSON object including "name", "provider", and your provider credential fields. Example: {"name":"primary","provider":"mongodb","connectionString":"mongodb://..."}: ',
            parse: parseStorage
        }
    });
    return storage;
}
