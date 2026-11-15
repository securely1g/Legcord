import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const options = JSON.parse(process.argv[2]);
const directory = mkdtempSync(path.join(tmpdir(), "legcord-managed-config-"));
const storage = path.join(directory, "storage");
const settingsFile = path.join(storage, "settings.json");
mkdirSync(storage);
writeFileSync(path.join(storage, "window.json"), "{}");
if (!options.missingProfile) {
    writeFileSync(
        settingsFile,
        JSON.stringify({
            doneSetup: true,
            automaticUpdates: false,
            spellcheck: true,
            externalUrlAllowlistEnabled: false,
            externalUrlAllowlist: ["youtube.com"],
            externalUrlPolicyManaged: !options.managed,
            externalUrlPolicyInvalid: !options.invalid,
        }),
    );
}
if (options.safeMode) process.argv.push("--safe-mode");
const electron = `export const app={getPath:key=>key==='exe'?'/usr/bin/legcord':${JSON.stringify(directory)},setPath:()=>{}};export const dialog={showErrorBox:()=>{throw new Error('Unexpected config reset')}};`;
const policy = `const domains=Object.freeze(${JSON.stringify(options.domains)});const policy=Object.freeze({managed:${options.managed},enabled:${options.enabled},domains,invalid:${options.invalid}});export const getManagedExternalUrlPolicy=()=>policy;`;
registerHooks({
    resolve(specifier, context, nextResolve) {
        let source;
        if (specifier === "electron") source = electron;
        if (context.parentURL?.endsWith("/src/common/config.ts")) {
            if (specifier === "./managedExternalUrlPolicy.js") source = policy;
            if (specifier === "./lang.js") source = "export const getLang=key=>key;";
            if (specifier === "./windowState.js")
                source = `export const getWindowStateLocation=()=>${JSON.stringify(path.join(storage, "window.json"))};`;
        }
        if (source !== undefined)
            return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
        return nextResolve(specifier, context);
    },
});

try {
    const config = await import(pathToFileURL(path.resolve("src/common/config.ts")).href);
    const initial = config.getEntireConfig();
    const expectedEnabled = options.managed ? options.enabled : false;
    const expectedDomains = options.managed ? options.domains : ["youtube.com"];
    assert.equal(config.getConfig("externalUrlPolicyManaged"), options.managed);
    assert.equal(config.getConfig("externalUrlPolicyInvalid"), options.invalid);
    assert.equal(initial.externalUrlPolicyManaged, options.managed);
    assert.equal(initial.externalUrlPolicyInvalid, options.invalid);
    assert.equal(initial.externalUrlAllowlistEnabled, expectedEnabled);
    assert.deepEqual(initial.externalUrlAllowlist, expectedDomains);
    assert.equal(config.getConfig("externalUrlAllowlistEnabled"), expectedEnabled);
    assert.deepEqual(config.getConfig("externalUrlAllowlist"), expectedDomains);
    if (options.managed) {
        initial.externalUrlAllowlist.push("evil.example");
        initial.externalUrlAllowlistEnabled = !expectedEnabled;
        config.getConfig("externalUrlAllowlist").push("evil.example");
        assert.deepEqual(config.getConfig("externalUrlAllowlist"), expectedDomains);
        assert.equal(config.getConfig("externalUrlAllowlistEnabled"), expectedEnabled);
    }
    assert.equal(config.isIpcWritableSettingsKey("externalUrlAllowlistEnabled"), !options.managed);
    assert.equal(config.isIpcWritableSettingsKey("externalUrlAllowlist"), !options.managed);
    assert.equal(config.isIpcWritableSettingsKey("externalUrlPolicyManaged"), false);
    assert.equal(config.isIpcWritableSettingsKey("externalUrlPolicyInvalid"), false);
    config.setConfig("externalUrlAllowlistEnabled", false);
    config.setConfig("externalUrlAllowlist", ["evil.example"]);
    config.setConfig("externalUrlPolicyManaged", false);
    config.setConfig("externalUrlPolicyInvalid", false);
    config.setConfigBulk({
        externalUrlAllowlistEnabled: false,
        externalUrlAllowlist: ["evil.example"],
        externalUrlPolicyManaged: false,
        externalUrlPolicyInvalid: false,
        spellcheck: false,
    });
    if (options.managed) {
        assert.equal(config.getEntireConfig().externalUrlAllowlistEnabled, expectedEnabled);
        assert.deepEqual(config.getEntireConfig().externalUrlAllowlist, expectedDomains);
    } else {
        assert.deepEqual(config.getEntireConfig().externalUrlAllowlist, ["evil.example"]);
    }
    const persisted = JSON.parse(readFileSync(settingsFile, "utf8"));
    assert.equal(Object.hasOwn(persisted, "externalUrlPolicyManaged"), false);
    assert.equal(Object.hasOwn(persisted, "externalUrlPolicyInvalid"), false);
    assert.equal(persisted.spellcheck, false);
    if (options.managed && !options.missingProfile) {
        assert.equal(persisted.externalUrlAllowlistEnabled, false);
        assert.deepEqual(persisted.externalUrlAllowlist, ["youtube.com"]);
    }
    config.setup();
    config.checkIfConfigIsBroken();
    if (options.managed) {
        assert.equal(config.getConfig("externalUrlAllowlistEnabled"), expectedEnabled);
        assert.deepEqual(config.getEntireConfig().externalUrlAllowlist, expectedDomains);
        assert.equal(config.getEntireConfig().externalUrlPolicyManaged, true);
    }
    console.log(JSON.stringify({ ok: true, managed: options.managed }));
} finally {
    rmSync(directory, { recursive: true, force: true });
}
