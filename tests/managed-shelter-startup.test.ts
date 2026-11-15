import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import {
    buildManagedShelterBootstrap,
    lockManagedShelterPluginApi,
    sanitizeManagedShelterStorage,
} from "../src/discord/preload/managedShelterStartup.ts";

type Stores = Record<string, Record<string, unknown>>;

/** A transactional fixture: aborts discard queued writes, as native IndexedDB does. */
function fixture(initial: Stores, failure?: "open" | "blocked" | "write", databaseExists = true) {
    const stores = structuredClone(initial);
    const opened: string[] = [];
    const transactions: string[][] = [];
    let closed = 0;
    const database = {
        objectStoreNames: { contains: (name: string) => Object.hasOwn(stores, name) },
        close: () => closed++,
        transaction(names: string[], mode: string) {
            assert.equal(mode, "readwrite");
            transactions.push(names);
            const working = structuredClone(stores);
            let pending = 0;
            let aborted = false;
            let completed = false;
            const finish = () => {
                if (pending || aborted || completed) return;
                completed = true;
                for (const name of names) stores[name] = working[name];
                tx.oncomplete?.();
            };
            const tx = {
                oncomplete: undefined as (() => void) | undefined,
                onabort: undefined as (() => void) | undefined,
                onerror: undefined as (() => void) | undefined,
                abort() {
                    aborted = true;
                    queueMicrotask(() => tx.onabort?.());
                },
                objectStore(name: string) {
                    assert.ok(names.includes(name));
                    return {
                        put(value: unknown, key: string) {
                            if (failure === "write") throw new Error("write failed");
                            working[name][key] = value;
                        },
                        openCursor() {
                            pending++;
                            const keys = Object.keys(working[name]);
                            let index = 0;
                            const req = {
                                result: null as unknown,
                                onsuccess: undefined as (() => void) | undefined,
                            };
                            const advance = () => {
                                if (aborted) return;
                                const key = keys[index++];
                                req.result =
                                    key === undefined
                                        ? null
                                        : {
                                              key,
                                              value: working[name][key],
                                              update: (value: unknown) => {
                                                  working[name][key] = value;
                                              },
                                              delete: () => delete working[name][key],
                                              continue: () => queueMicrotask(advance),
                                          };
                                req.onsuccess?.();
                                if (key === undefined) {
                                    pending--;
                                    queueMicrotask(finish);
                                }
                            };
                            queueMicrotask(advance);
                            return req;
                        },
                    };
                },
            };
            queueMicrotask(finish);
            return tx;
        },
    };
    const factory = {
        databases: async () => (databaseExists ? [{ name: "shelter", version: 1 }] : []),
        open(name: string) {
            opened.push(name);
            const request = {
                result: database,
                onsuccess: undefined as (() => void) | undefined,
                onerror: undefined as (() => void) | undefined,
                onblocked: undefined as (() => void) | undefined,
            };
            queueMicrotask(() => {
                if (failure === "open") request.onerror?.();
                else if (failure === "blocked") request.onblocked?.();
                else request.onsuccess?.();
            });
            return request;
        },
    } as unknown as IDBFactory;
    return { factory, stores, opened, transactions, closed: () => closed };
}

describe("parent-managed Shelter startup", () => {
    it("disables persisted user plugins and dev mode before startup, preserving scripts, manifests and plugin data", async () => {
        const plugin = {
            on: true,
            update: true,
            js: "untrusted script",
            manifest: { name: "User plugin" },
            local: false,
            src: "https://example.com/",
        };
        const state = fixture({
            "plugins-internal": { user: plugin, __DEVMODE_PLUGIN_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: { on: true } },
            "plugins-data": { user: { preserved: true } },
            dbstore: { alwaysDevMenu: true, otherPreference: "preserved" },
            discord: { login: "untouched" },
        });
        await sanitizeManagedShelterStorage(state.factory);
        assert.deepEqual(state.stores["plugins-internal"].user, { ...plugin, on: false, update: false });
        assert.equal(
            Object.hasOwn(state.stores["plugins-internal"], "__DEVMODE_PLUGIN_DO_NOT_USE_OR_YOU_WILL_BE_FIRED"),
            false,
        );
        assert.deepEqual(state.stores["plugins-data"], { user: { preserved: true } });
        assert.deepEqual(state.stores.dbstore, { alwaysDevMenu: false, otherPreference: "preserved" });
        assert.deepEqual(state.stores.discord, { login: "untouched" });
        assert.deepEqual(state.opened, ["shelter"]);
        assert.deepEqual(state.transactions, [["plugins-internal", "dbstore"]]);
        assert.equal(state.closed(), 1);
    });

    it("accepts a fresh Shelter database without creating plugin stores or touching other databases", async () => {
        const state = fixture({});
        await sanitizeManagedShelterStorage(state.factory);
        assert.deepEqual(state.stores, {});
        assert.deepEqual(state.transactions, []);
        assert.equal(state.closed(), 1);
    });

    it("does not open or create a Shelter database when the profile has none", async () => {
        const state = fixture({}, undefined, false);
        await sanitizeManagedShelterStorage(state.factory);
        assert.deepEqual(state.opened, []);
        assert.deepEqual(state.stores, {});
        assert.equal(state.closed(), 0);
    });

    it("aborts malformed plugin records atomically without evaluating the vendor runtime", async () => {
        const initial = {
            "plugins-internal": { valid: { on: true, update: true }, malformed: null },
            dbstore: { alwaysDevMenu: true },
        };
        const state = fixture(initial);
        const context = { indexedDB: state.factory, setTimeout, clearTimeout, vendorExecuted: false };
        await assert.rejects(
            runInNewContext(buildManagedShelterBootstrap("vendorExecuted=true;", {}, ""), context),
            /invalid stored plugin/,
        );
        assert.equal(context.vendorExecuted, false);
        assert.deepEqual(state.stores, initial);
    });

    for (const failure of ["open", "blocked", "write"] as const) {
        it(`fails closed on ${failure} errors before evaluating vendor code`, async () => {
            const initial = { "plugins-internal": {}, dbstore: { alwaysDevMenu: true } };
            const state = fixture(initial, failure);
            const context = { indexedDB: state.factory, setTimeout, clearTimeout, vendorExecuted: false };
            await assert.rejects(
                runInNewContext(buildManagedShelterBootstrap("vendorExecuted=true;", {}, ""), context),
                /Parent-managed Shelter/,
            );
            assert.equal(context.vendorExecuted, false);
            assert.deepEqual(state.stores, initial);
        });
    }

    it("fails closed if database inspection rejects or never completes", async () => {
        for (const inspect of [
            () => Promise.reject(new Error("inspection failed")),
            () => new Promise<never>(() => {}),
        ]) {
            let opened = false;
            const context = {
                indexedDB: {
                    databases: inspect,
                    open: () => {
                        opened = true;
                    },
                },
                setTimeout: (callback: () => void, delay: number) => {
                    assert.equal(delay, 5000);
                    queueMicrotask(callback);
                    return 0;
                },
                clearTimeout: () => {},
                vendorExecuted: false,
            };
            await assert.rejects(
                runInNewContext(buildManagedShelterBootstrap("vendorExecuted=true;", {}, ""), context),
                /Parent-managed Shelter/,
            );
            assert.equal(context.vendorExecuted, false);
            assert.equal(opened, false);
        }
    });

    it("locks public plugin mutators while keeping installed/loaded plugin readers available", () => {
        let mutations = 0;
        const api = { plugins: { startPlugin: () => mutations++, installedPlugins: () => ["builtin"] } };
        lockManagedShelterPluginApi(api);
        api.plugins.startPlugin();
        assert.equal(mutations, 0);
        assert.deepEqual(api.plugins.installedPlugins(), ["builtin"]);
        assert.throws(() => Object.assign(api.plugins, { startPlugin: () => mutations++ }));
    });

    it("installs the supported callback before vendor initialization and runs the model guard afterward", async () => {
        const state = fixture({});
        const context = { indexedDB: state.factory, setTimeout, clearTimeout, window: {}, order: [] as string[] };
        const bundle = `window.shelter={plugins:{startPlugin:()=>order.push("unexpected mutation")}};
            SHELTER_INJECTOR_SETTINGS();
            window.shelter.plugins.startPlugin();
            order.push(Object.keys(SHELTER_INJECTOR_PLUGINS)[0]);`;
        await runInNewContext(
            buildManagedShelterBootstrap(bundle, { builtin: true }, 'order.push("model guard");'),
            context,
        );
        assert.deepEqual(context.order, ["builtin", "model guard"]);
    });
});
