import assert from "node:assert/strict";
import { it } from "node:test";

it("parent-managed settings never mutate renderer preferences, invoke writes, or request a restart", async () => {
    const store = {
        settings: { settingsPolicyManaged: true, spellcheck: true, mods: ["vencord"] },
    };
    const writes: unknown[][] = [];
    const globals = {
        shelter: { plugin: { store } },
        window: { legcord: { settings: { setConfig: (...args: unknown[]) => writes.push(args) } } },
        document: { activeElement: null, querySelectorAll: () => [] },
        HTMLElement: class {},
    };
    const descriptors = new Map(
        Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
    );
    Object.assign(globalThis, globals);
    try {
        const settings = await import("../src/shelter/settings/settings.ts");
        const original = structuredClone(store.settings);
        settings.setConfig("spellcheck", false, true);
        settings.toggleMod("equicord", true);
        settings.setRestartRequired();
        assert.deepEqual(store.settings, original);
        assert.deepEqual(writes, []);
        assert.equal(settings.isRestartRequired, false);

        // A normal installation retains its settings behavior.
        store.settings.settingsPolicyManaged = false;
        settings.setConfig("spellcheck", false, true);
        assert.equal(store.settings.spellcheck, false);
        assert.deepEqual(writes, [["spellcheck", false]]);
        assert.equal(settings.isRestartRequired, true);
        settings.toggleMod("equicord", true);
        assert.deepEqual(store.settings.mods, ["equicord"]);
        assert.deepEqual(writes.at(-1), ["mods", ["equicord"]]);
    } finally {
        for (const [key, descriptor] of descriptors) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
    }
});
