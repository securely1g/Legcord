import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const managed = process.argv[2] === "managed";
const directory = mkdtempSync(path.join(tmpdir(), "legcord-setup-tray-"));
const settingsFile = path.join(directory, "settings.json");
const original = '{"spellcheck":true}';
writeFileSync(settingsFile, original);
const quit = new Promise((resolve) => {
    globalThis.__resolveQuit = resolve;
});
let template;
globalThis.__captureMenu = (items) => {
    template = items;
};
const electron = `
export const app={whenReady:()=>Promise.resolve(),quit:()=>globalThis.__resolveQuit()};
export const nativeImage={createFromPath:()=>({resize:()=>{}})};
export const Menu={buildFromTemplate:items=>{globalThis.__captureMenu(items);return items;}};
export class Tray {setContextMenu(){}}
`;
registerHooks({
    resolve(specifier, context, nextResolve) {
        let source;
        if (specifier === "electron") source = electron;
        if (context.parentURL?.endsWith("/src/setup/tray.ts")) {
            if (specifier === "../common/config.js")
                source = `export const getConfigLocation=()=>${JSON.stringify(settingsFile)};`;
            if (specifier === "../common/managedExternalUrlPolicy.js")
                source = `export const getManagedSettingsPolicy=()=>({managed:${managed}});`;
        }
        if (source !== undefined)
            return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
        return nextResolve(specifier, context);
    },
});
try {
    await import(pathToFileURL(path.resolve("src/setup/tray.ts")).href);
    await Promise.resolve();
    assert.ok(template, "Setup tray was initialized");
    const action = template.find(({ label }) => label === "Quit Legcord");
    assert.equal(typeof action?.click, "function");
    action.click();
    await quit;
    if (managed)
        assert.equal(readFileSync(settingsFile, "utf8"), original, "Managed setup quit preserves the daily profile");
    else assert.equal(existsSync(settingsFile), false, "Unmanaged setup cleanup is preserved");
    console.log(JSON.stringify({ ok: true, managed }));
} finally {
    rmSync(directory, { recursive: true, force: true });
}
