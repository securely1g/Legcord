import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import {
    type ManagedPolicyFileSystem,
    parseManagedExternalUrlPolicy,
    parseManagedSettingsPolicy,
    readManagedSettingsPolicy,
} from "../src/common/managedExternalUrlPolicy.ts";

const document = {
    version: 2,
    externalUrlAllowlistEnabled: true,
    externalUrlAllowlist: [],
    settings: { spellcheck: false },
    language: "en-US",
};

describe("parent management of all Legcord settings", () => {
    it("accepts a typed administrator snapshot and freezes nested values", () => {
        const input = {
            ...document,
            settings: { spellcheck: false, spellcheckLanguage: ["en-US"], pluginStates: { sample: false } },
            language: "fr-FR",
        };
        const policy = parseManagedSettingsPolicy(input);
        assert.equal(policy.managed, true);
        assert.equal(policy.invalid, false);
        assert.equal(policy.language, "fr-FR");
        assert.deepEqual(policy.settings, input.settings);
        input.settings.spellcheckLanguage.push("de-DE");
        assert.deepEqual(policy.settings.spellcheckLanguage, ["en-US"]);
        assert.throws(() => (policy.settings.spellcheckLanguage as string[]).push("de-DE"), TypeError);
        assert.deepEqual(parseManagedExternalUrlPolicy(input), {
            managed: true,
            invalid: false,
            enabled: true,
            domains: [],
        });
    });
    it("retains compatibility with embed-only v1 documents", () => {
        const policy = parseManagedSettingsPolicy({
            version: 1,
            externalUrlAllowlistEnabled: true,
            externalUrlAllowlist: [],
        });
        assert.equal(policy.managed, false);
        assert.equal(policy.invalid, false);
    });
    it("rejects the whole document for unknown keys, metadata, or invalid setting types", () => {
        for (const value of [
            { ...document, extra: true },
            { ...document, settings: null },
            { ...document, settings: [] },
            { ...document, settings: { spellcheck: "false" } },
            { ...document, settings: { mobileMode: 1 } },
            { ...document, settings: { notASetting: true } },
            { ...document, settings: { settingsPolicyManaged: false } },
            { ...document, settings: { proxyMode: "nonsense" } },
            { ...document, settings: { keybinds: [{ action: "runJavascript" }] } },
            { ...document, settings: { pluginStates: { sample: "true" } } },
            { ...document, settings: { audio: {} } },
            { ...document, settings: { scanInterval: -1 } },
            { ...document, settings: { mods: ["unknown"] } },
            { ...document, settings: { mods: ["custom"] } },
            { ...document, settings: { quickCss: true } },
            { ...document, settings: { useSystemCssEditor: true } },
            { ...document, settings: { pluginStates: { sample: true } } },
            { ...document, settings: { disableDangerousSwitchBlocking: true } },
            { ...document, settings: { automaticUpdates: true } },
            {
                ...document,
                settings: {
                    keybinds: [
                        {
                            id: "js",
                            accelerator: "Ctrl+J",
                            global: false,
                            enabled: true,
                            action: "runJavascript",
                            js: "danger()",
                        },
                    ],
                },
            },
            { ...document, settings: { externalUrlAllowlistEnabled: false } },
            { ...document, language: "../../profile" },
            { ...document, language: false },
            { ...document, externalUrlAllowlist: ["https://evil.example"] },
        ]) {
            const policy = parseManagedSettingsPolicy(value);
            assert.equal(policy.managed, true, JSON.stringify(value));
            assert.equal(policy.invalid, true, JSON.stringify(value));
            assert.equal(parseManagedExternalUrlPolicy(value).invalid, true);
        }
    });
    it("fails closed for missing policy files and permits unmanaged only for an absent trusted directory", () => {
        const info = {
            uid: 0,
            mode: 0o755,
            size: 0,
            isDirectory: () => true,
            isFile: () => false,
            isSymbolicLink: () => false,
        };
        const fs: ManagedPolicyFileSystem = {
            lstat: () => info,
            open: () => {
                throw Object.assign(Error(), { code: "ENOENT" });
            },
            fstat: () => info,
            read: () => 0,
            close: () => {},
        };
        assert.equal(readManagedSettingsPolicy(fs, "linux").managed, true);
        assert.equal(readManagedSettingsPolicy(fs, "linux").invalid, true);
        fs.lstat = (path) => {
            if (path === "/etc/legcord") throw Object.assign(Error(), { code: "ENOENT" });
            return info;
        };
        assert.equal(readManagedSettingsPolicy(fs, "linux").managed, false);
        assert.equal(readManagedSettingsPolicy(fs, "darwin").managed, false);
    });
    for (const options of [
        { document },
        { document, safeMode: true },
        { document, missingProfile: true },
        { document: { bad: true }, invalid: true },
    ]) {
        it(`uses policy rather than writable profiles and refuses writes: ${JSON.stringify(options)}`, () => {
            const child = spawnSync(
                process.execPath,
                [
                    "--experimental-strip-types",
                    "--import",
                    "./tests/register-ts.mjs",
                    "./tests/support/managed-settings-fixture.mjs",
                    JSON.stringify(options),
                ],
                { encoding: "utf8", timeout: 10000 },
            );
            assert.equal(child.status, 0, child.stderr || child.stdout);
        });
    }
});
