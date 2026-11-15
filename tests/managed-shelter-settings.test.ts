import assert from "node:assert/strict";
import { it } from "node:test";
import { createContext, runInContext } from "node:vm";
import {
    managedShelterSettingsGuardScript,
    removeBuiltInShelterSettings,
    SHELTER_SETTINGS_SECTION,
} from "../src/discord/preload/managedShelter.ts";

it("removes only the native Shelter section from the pinned nested layout", () => {
    const legcord = { key: "shelter_legcord_section", layout: [{ key: "shelter_legcord-settings_sidebar_item" }] };
    const account = { key: "account_section", layout: [] };
    const builtin = { key: SHELTER_SETTINGS_SECTION, layout: [{ key: "shelter_shelter-settings_sidebar_item" }] };
    const root = { key: "$Root", layout: [account, legcord, builtin] };
    Object.assign(account, { parent: root });
    assert.equal(removeBuiltInShelterSettings(root), true);
    assert.deepEqual(root.layout, [account, legcord]);
    assert.equal(removeBuiltInShelterSettings(root), false);
});

it("ignores unrelated and malformed models and terminates on cyclic layouts", () => {
    for (const root of [undefined, null, [], {}, { key: "$Root", layout: null }, { key: "other", layout: [] }]) {
        assert.equal(removeBuiltInShelterSettings(root), false);
    }
    const frozen = { key: "$Root", layout: Object.freeze([{ key: SHELTER_SETTINGS_SECTION }]) };
    assert.doesNotThrow(() => removeBuiltInShelterSettings(frozen));
    const root: { key: string; layout: unknown[] } = { key: "$Root", layout: [] };
    root.layout.push(root, { key: SHELTER_SETTINGS_SECTION });
    assert.equal(removeBuiltInShelterSettings(root), true);
    assert.deepEqual(root.layout, [root]);
});

function renderer() {
    const tasks: Array<() => void> = [];
    const context = createContext({
        queueMicrotask: (task: () => void) => tasks.push(task),
        document: {
            documentElement: {},
            querySelectorAll: () => [],
            addEventListener: () => {},
        },
        MutationObserver: class {
            observe() {}
        },
    });
    runInContext(
        `globalThis.root={key:'$Root',layout:[{key:'shelter_legcord_section'}]};
         Object.defineProperty(Object.prototype,'buildLayout',{
           configurable:true,
           get(){queueMicrotask(()=>root.layout.push({key:'shelter_shelter_section'}));},
           set(value){Object.defineProperty(this,'buildLayout',{value,configurable:true,writable:true});}
         });
         globalThis.before=Object.getOwnPropertyDescriptor(Object.prototype,'buildLayout');`,
        context,
    );
    return { context, tasks };
}

it("managed renderer integration filters after native injection and preserves its accessor/setter", () => {
    const { context, tasks } = renderer();
    runInContext(managedShelterSettingsGuardScript(true), context);
    runInContext("globalThis.node={parent:root}; node.buildLayout;", context);
    assert.equal(tasks.length, 2);
    while (tasks.length) tasks.shift()?.();
    assert.equal(runInContext("JSON.stringify(root.layout)", context), '[{"key":"shelter_legcord_section"}]');
    assert.equal(
        runInContext("Object.getOwnPropertyDescriptor(Object.prototype,'buildLayout').set === before.set", context),
        true,
    );
    runInContext("node.buildLayout=42", context);
    assert.equal(runInContext("node.buildLayout", context), 42);
});

it("unmanaged renderer integration changes no descriptor or native section", () => {
    const { context, tasks } = renderer();
    assert.equal(managedShelterSettingsGuardScript(false), "");
    runInContext(managedShelterSettingsGuardScript(false), context);
    assert.equal(
        runInContext("Object.getOwnPropertyDescriptor(Object.prototype,'buildLayout').get === before.get", context),
        true,
    );
    runInContext("({parent:root}).buildLayout", context);
    while (tasks.length) tasks.shift()?.();
    assert.equal(runInContext("root.layout[1].key", context), SHELTER_SETTINGS_SECTION);
});

it("entry-point fallback hides and blocks the native settings key without touching Legcord navigation", () => {
    const calls: string[] = [];
    const context = createContext({
        queueMicrotask() {},
        calls,
        MutationObserver: class {
            observe() {}
        },
    });
    runInContext(
        `globalThis.Element=class {
          constructor(key){this.key=key;this.style={setProperty(){}};}
          getAttribute(name){return name==='data-settings-sidebar-item'?this.key:null;}
          setAttribute(){}
          closest(){return this;}
        };
        globalThis.builtin=new Element('shelter_shelter-settings_sidebar_item');
        globalThis.nativePanel=new Element('shelter_shelter-settings_panel');
        globalThis.legcord=new Element('shelter_legcord-settings_sidebar_item');
        globalThis.listeners={};
        globalThis.document={documentElement:{},querySelectorAll:()=>[builtin,nativePanel,legcord],addEventListener:(name,fn)=>listeners[name]=fn};`,
        context,
    );
    runInContext(managedShelterSettingsGuardScript(true), context);
    assert.equal(runInContext("builtin.hidden && builtin.inert", context), true);
    assert.equal(runInContext("nativePanel.hidden && nativePanel.inert", context), true);
    assert.equal(runInContext("Boolean(legcord.hidden || legcord.inert)", context), false);
    runInContext(
        `for(const target of [builtin,nativePanel,legcord]) listeners.click({target,preventDefault:()=>calls.push(target.key),stopImmediatePropagation(){}});`,
        context,
    );
    assert.deepEqual(calls, ["shelter_shelter-settings_sidebar_item", "shelter_shelter-settings_panel"]);
});
