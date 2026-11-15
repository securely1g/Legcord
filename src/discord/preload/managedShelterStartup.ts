/**
 * Disable persisted Shelter user code before evaluating its pinned runtime.
 * Only its named database is touched; scripts, manifests and plugin data remain.
 * Serialized into the main world, so this function has no outer bindings.
 */
export function sanitizeManagedShelterStorage(factory: IDBFactory = indexedDB): Promise<void> {
    return new Promise((resolve, reject) => {
        let settled = false;
        let database: IDBDatabase | undefined;
        let transaction: IDBTransaction | undefined;
        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (error && transaction) {
                try {
                    transaction.abort();
                } catch {
                    // A completed or aborted transaction has no pending writes.
                }
            }
            database?.close();
            if (error) reject(error);
            else resolve();
        };
        const timeout = setTimeout(() => finish(new Error("Parent-managed Shelter storage timed out.")), 5000);
        const openStorage = () => {
            let opening: IDBOpenDBRequest;
            try {
                opening = factory.open("shelter");
            } catch {
                finish(new Error("Parent-managed Shelter storage could not be opened."));
                return;
            }
            opening.onerror = () => finish(new Error("Parent-managed Shelter storage could not be opened."));
            opening.onblocked = () => finish(new Error("Parent-managed Shelter storage is blocked."));
            opening.onsuccess = () => {
                database = opening.result;
                if (settled) {
                    database.close();
                    return;
                }
                const names = ["plugins-internal", "dbstore"].filter((name) =>
                    database?.objectStoreNames.contains(name),
                );
                if (names.length === 0) {
                    finish();
                    return;
                }
                try {
                    transaction = database.transaction(names, "readwrite");
                    transaction.oncomplete = () => finish();
                    transaction.onabort = () =>
                        finish(new Error("Parent-managed Shelter storage could not be secured."));
                    transaction.onerror = () =>
                        finish(new Error("Parent-managed Shelter storage could not be secured."));
                    if (names.includes("dbstore")) {
                        transaction.objectStore("dbstore").put(false, "alwaysDevMenu");
                    }
                    if (names.includes("plugins-internal")) {
                        const cursorRequest = transaction.objectStore("plugins-internal").openCursor();
                        cursorRequest.onsuccess = () => {
                            const cursor = cursorRequest.result;
                            if (!cursor) return;
                            if (cursor.key === "__DEVMODE_PLUGIN_DO_NOT_USE_OR_YOU_WILL_BE_FIRED") {
                                cursor.delete();
                            } else {
                                const plugin: unknown = cursor.value;
                                if (!plugin || typeof plugin !== "object" || Array.isArray(plugin)) {
                                    finish(new Error("Parent-managed Shelter found an invalid stored plugin."));
                                    return;
                                }
                                cursor.update({ ...plugin, on: false, update: false });
                            }
                            cursor.continue();
                        };
                    }
                } catch {
                    finish(new Error("Parent-managed Shelter storage could not be secured."));
                }
            };
        };
        try {
            factory.databases().then(
                (databases) => {
                    if (settled) return;
                    if (!databases.some((entry) => entry.name === "shelter")) {
                        finish();
                        return;
                    }
                    openStorage();
                },
                () => finish(new Error("Parent-managed Shelter storage could not be inspected.")),
            );
        } catch {
            finish(new Error("Parent-managed Shelter storage could not be inspected."));
        }
    });
}

/** Upstream invokes this supported injector hook before starting plugins. */
export function lockManagedShelterPluginApi(api: { plugins?: Record<string, unknown> }): void {
    if (!api?.plugins) throw new Error("Parent-managed Shelter plugin API is unavailable.");
    for (const action of [
        "addLocalPlugin",
        "addRemotePlugin",
        "editPlugin",
        "updatePlugin",
        "removePlugin",
        "startPlugin",
        "stopPlugin",
        "showSettingsFor",
    ]) {
        Object.defineProperty(api.plugins, action, {
            value: () => undefined,
            enumerable: true,
            writable: false,
            configurable: false,
        });
    }
    Object.freeze(api.plugins);
}

/** Never evaluate vendor code unless its persisted state was secured. */
export function buildManagedShelterBootstrap(bundle: string, requiredPlugins: unknown, settingsGuard: string): string {
    return `(async()=>{
        await (${sanitizeManagedShelterStorage.toString()})();
        const SHELTER_INJECTOR_PLUGINS = ${JSON.stringify(requiredPlugins)};
        const SHELTER_INJECTOR_SETTINGS = () => {
            (${lockManagedShelterPluginApi.toString()})(window.shelter);
            return [];
        };
        ${bundle}
        ${settingsGuard}
    })()`;
}
