import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
    parseManagedExternalUrlPolicy,
    parseManagedSettingsPolicy,
} from "../../src/common/managedExternalUrlPolicy.ts";

const options = JSON.parse(process.argv[2]);
const directory = mkdtempSync(path.join(tmpdir(), "legcord-all-settings-"));
const storage = path.join(directory, "storage");
const settingsFile = path.join(storage, "settings.json");
mkdirSync(storage);
const windowFile = path.join(storage, "window.json");
writeFileSync(windowFile, "invalid JSON");
const profile = JSON.stringify({
    spellcheck: true,
    proxyMode: "pac_script",
    proxyPacScript: "https://evil.example/proxy.pac",
    mobileMode: false,
    useSystemCssEditor: true,
    doneSetup: false,
    mods: ["custom"],
    keybinds: [{ action: "runJavascript" }],
    settingsPolicyManaged: false,
    settingsPolicyInvalid: false,
});
if (!options.missingProfile) writeFileSync(settingsFile, profile);
if (options.safeMode) process.argv.push("--safe-mode");
const external = parseManagedExternalUrlPolicy(options.document);
const settings = parseManagedSettingsPolicy(options.document);
registerHooks({
    resolve(specifier, context, nextResolve) {
        let source;
        if (specifier === "electron")
            source = `export const app={getPath:key=>key==='exe'?'/usr/bin/legcord':${JSON.stringify(directory)},setPath:()=>{}};export const dialog={showErrorBox:()=>{throw Error('Unexpected reset')}};`;
        if (context.parentURL?.endsWith("/src/common/config.ts")) {
            if (specifier === "./managedExternalUrlPolicy.js")
                source = `export const getManagedExternalUrlPolicy=()=>(${JSON.stringify(external)});export const getManagedSettingsPolicy=()=>(${JSON.stringify(settings)});`;
            if (specifier === "./lang.js") source = "export const getLang=key=>key;";
            if (specifier === "./windowState.js")
                source = `export const getWindowStateLocation=()=>${JSON.stringify(windowFile)};`;
        }
        if (source !== undefined)
            return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
        return nextResolve(specifier, context);
    },
});
try {
    const config = await import(pathToFileURL(path.resolve("src/common/config.ts")).href);
    const values = config.getEntireConfig();
    const expectedSpellcheck = !!options.invalid;
    assert.equal(values.settingsPolicyManaged, true);
    assert.equal(values.settingsPolicyInvalid, !!options.invalid);
    assert.equal(values.spellcheck, expectedSpellcheck);
    assert.equal(values.proxyMode, "system");
    assert.equal(values.proxyPacScript, "");
    assert.equal(values.mobileMode, true);
    assert.equal(values.useSystemCssEditor, false);
    assert.equal(values.quickCss, false);
    assert.deepEqual(values.mods, []);
    assert.deepEqual(values.keybinds, []);
    for (const key of config.SETTINGS_KEYS) assert.equal(config.isIpcWritableSettingsKey(key), false, key);
    for (const key of [
        "settingsPolicyManaged",
        "settingsPolicyInvalid",
        "externalUrlPolicyManaged",
        "externalUrlPolicyInvalid",
    ])
        assert.equal(config.isIpcWritableSettingsKey(key), false, key);
    config.setConfig("spellcheck", true);
    config.setConfig("proxyMode", "direct");
    config.setConfigBulk({ spellcheck: true, proxyMode: "direct", settingsPolicyManaged: false });
    config.setup();
    config.checkIfConfigExists();
    config.checkIfConfigIsBroken();
    assert.deepEqual(JSON.parse(readFileSync(windowFile, "utf8")), {});
    assert.equal(config.firstRun, false);
    values.audio.deviceSelect = false;
    values.mods.push("custom");
    config.getConfig("spellcheckLanguage").push("fr-FR");
    assert.equal(config.getConfig("audio").deviceSelect, true);
    assert.deepEqual(config.getConfig("mods"), []);
    assert.deepEqual(config.getConfig("spellcheckLanguage"), ["en-US"]);
    assert.equal(config.getConfig("spellcheck"), expectedSpellcheck);
    assert.equal(config.getConfig("proxyMode"), "system");
    assert.equal(existsSync(settingsFile), !options.missingProfile);
    if (!options.missingProfile) assert.equal(readFileSync(settingsFile, "utf8"), profile);
    console.log(JSON.stringify({ ok: true, invalid: !!options.invalid, missingProfile: !!options.missingProfile }));
} finally {
    rmSync(directory, { recursive: true, force: true });
}
