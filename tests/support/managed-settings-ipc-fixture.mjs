import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const mode = process.argv[2];
const directory = mkdtempSync(path.join(tmpdir(), "legcord-settings-ipc-"));
const css = path.join(directory, "quickCss.css");
const application = path.join(directory, "application");
const bundledShelter = path.join(application, "assets", "vendor", "shelter.js");
mkdirSync(path.dirname(bundledShelter), { recursive: true });
writeFileSync(bundledShelter, "trusted package runtime");
writeFileSync(path.join(directory, "shelter.js"), "untrusted profile runtime");
mkdirSync(path.join(directory, "themes", "test"), { recursive: true });
writeFileSync(css, "original");
writeFileSync(path.join(directory, "themes", "test", "manifest.json"), '{"theme":"test.css"}');
globalThis.__managed = mode !== "unmanaged";
globalThis.__effects = [];
globalThis.__listeners = new Map();
globalThis.__handlers = new Map();
process.crash = () => globalThis.__effects.push({ name: "process.crash" });

const log = "const effect=(name,...args)=>{globalThis.__effects.push({name,args});};";
const exports = (names) =>
    log + names.map((name) => `export const ${name}=(...args)=>effect(${JSON.stringify(name)},...args);`).join("");
const sources = {
    "electron-is-dev": "export default false;",
    "../common/managedExternalUrlPolicy.js":
        "export const getManagedSettingsPolicy=()=>({managed:globalThis.__managed,invalid:false,settings:{}});",
    "../common/backup.js": exports(["applyBackupFromMap", "buildBackupZipBuffer", "readBackupZipToMap"]),
    "../common/blacklistGame.js": `${exports(["blacklistGame", "unblacklistGame"])}export const getBlacklist=()=>["preserved"];`,
    "../common/config.js":
        exports(["setConfig", "setConfigBulk"]) +
        'export const getConfig=key=>({spellcheck:true,mods:[],keybinds:[{id:"test",enabled:true}],useSystemCssEditor:true,extendedPluginAbilities:true})[key];export const getConfigLocation=()=>"unused";export const getEntireConfig=()=>({spellcheck:true});export const isIpcWritableSettingsKey=()=>true;',
    "../common/detectables.js": `${exports(["addDetectable", "removeDetectable"])}export const getDetectables=()=>["preserved"];`,
    "../common/lang.js":
        exports(["setLang"]) +
        'export const getLang=key=>key;export const getLangName=()=>"en-US";export const getRawLang=()=>({});',
    "../common/themes.js":
        exports([
            "disableQuickCss",
            "initQuickCss",
            "installTheme",
            "invalidateThemeListCache",
            "setThemeEnabled",
            "startThemeWatcher",
            "uninstallTheme",
        ]) +
        `export const getCachedThemeList=()=>["preserved"];export const resolveThemeDir=()=>${JSON.stringify(path.join(directory, "themes", "test"))};export const resolveThemeFile=()=>${JSON.stringify(path.join(directory, "themes", "test", "test.css"))};`,
    "../common/version.js": 'export const getDisplayVersion=()=>"test";export const getVersion=()=>"test";',
    "../common/windowVisibility.js": exports(["applyStartupWindowVisibility", "revealWindow"]),
    "../main.js": `${exports(["handleRestart"])}export const getAppliedFlags=()=>[];`,
    "../power.js": `${exports(["setPowerSaving"])}export const isPowerSavingEnabled=()=>true;`,
    "../shared/consts/paths.js": "export default {};",
    "../splash/main.js": "export const splashWindow=null;",
    "./dictation.js": exports(["registerDictationIpc"]),
    "./externalUrlFilter.js": exports(["notifyExternalUrlPolicyChanged"]),
    "./globalKeybinds.js": exports(["refreshGlobalKeybinds"]),
    "./plugins/manager.js":
        exports(["reloadPlugin", "setPluginEnabled"]) +
        "export const getRuntimeEntries=()=>[];export const getRuntimeScript=()=>null;export const listPlugins=()=>[];",
    "./rpcProcess.js": `${exports(["refreshProcessList"])}export const processList=[];`,
    "./touchbar.js": `${exports(["importGuilds", "setVoiceState"])}export const mainTouchBar={};export const voiceTouchBar={};`,
};
const electron =
    log +
    `
export const app={getPath:()=>${JSON.stringify(directory)},getAppPath:()=>${JSON.stringify(application)},getName:()=>"Legcord",quit:()=>effect("quit"),getGPUFeatureStatus:()=>({})};
export const clipboard={writeText:()=>effect("clipboard")};
export const dialog={showOpenDialog:async()=>{effect("openDialog");return {canceled:true};},showSaveDialog:async()=>{effect("saveDialog");return {canceled:true};}};
export const shell={openPath:async(file)=>{effect("openPath",file);return "";},showItemInFolder:file=>effect("showItemInFolder",file)};
export const ipcMain={on:(channel,listener)=>{const handlers=globalThis.__listeners.get(channel)||[];handlers.push(listener);globalThis.__listeners.set(channel,handlers);},handle:(channel,listener)=>globalThis.__handlers.set(channel,listener),removeAllListeners:channel=>globalThis.__listeners.delete(channel)};
export class BrowserWindow {constructor(){effect("newWindow");}focus(){effect("focusWindow");}on(){}loadFile(){effect("loadFile");return Promise.resolve();}loadURL(){effect("loadURL");return Promise.resolve();}}
`;
registerHooks({
    resolve(specifier, context, nextResolve) {
        let source;
        if (specifier === "electron") source = electron;
        if (
            context.parentURL?.endsWith("/src/discord/ipc.ts") ||
            context.parentURL?.endsWith("/src/cssEditor/main.ts")
        ) {
            if (Object.hasOwn(sources, specifier)) source = sources[specifier];
        }
        if (source !== undefined)
            return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
        return nextResolve(specifier, context);
    },
});

function emit(channel, ...args) {
    const listeners = globalThis.__listeners.get(channel);
    assert.ok(listeners?.length, `Registered event ${channel}`);
    const event = {};
    for (const listener of listeners) listener(event, ...args);
    return event;
}
async function invoke(channel, ...args) {
    assert.ok(globalThis.__handlers.has(channel), `Registered handler ${channel}`);
    return globalThis.__handlers.get(channel)({}, ...args);
}
function effects() {
    return globalThis.__effects.map(({ name }) => name);
}
function clear() {
    globalThis.__effects.length = 0;
}

try {
    const { registerIpc } = await import(pathToFileURL(path.resolve("src/discord/ipc.ts")).href);
    const { openCssEditor } = await import(pathToFileURL(path.resolve("src/cssEditor/main.ts")).href);
    registerIpc({
        minimize: () => globalThis.__effects.push({ name: "minimize" }),
        setTouchBar: () => globalThis.__effects.push({ name: "setTouchBar" }),
    });
    clear();
    assert.equal(
        (await invoke("getShelterBundle")).js,
        mode === "unmanaged" ? "untrusted profile runtime" : "trusted package runtime",
    );
    if (mode === "managed") {
        unlinkSync(bundledShelter);
        assert.equal(
            (await invoke("getShelterBundle")).js,
            undefined,
            "Missing package runtime must not fall back to the profile",
        );
        assert.equal(readFileSync(path.join(directory, "shelter.js"), "utf8"), "untrusted profile runtime");
    }
    if (mode === "managed") {
        const deniedEvents = [
            ["enableQuickCss"],
            ["disableQuickCss"],
            ["openQuickCss"],
            ["importQuickCss", "changed"],
            ["openThemesFolder"],
            ["openImportPicker"],
            ["setThemeEnabled", "test", false],
            ["editTheme", "test"],
            ["openThemeFolder", "test"],
            ["uninstallTheme", "test"],
            ["setLang", "fr"],
            ["importGuilds", ["test"]],
            ["setPowerSaving", false],
            ["setConfig", "spellcheck", false],
            ["saveSettings", { spellcheck: false }],
            ["blacklistGame", "test", 1],
            ["unblacklistGame", 1],
            ["addKeybind", { id: "new" }],
            ["toggleKeybind", "test"],
            ["removeKeybind", "test"],
            ["openStorageFolder"],
            ["openPluginsFolder"],
            ["openRuntimePluginsFolder"],
            ["openCrashesFolder"],
            ["crash"],
            ["openCustomIconDialog"],
            ["openWebRTCInternals"],
            ["openGPUInfo"],
            ["refreshProcessList"],
            ["addDetectable", { id: "test" }],
            ["removeDetectable", "test"],
        ];
        for (const [channel, ...args] of deniedEvents) {
            emit(channel, ...args);
            assert.deepEqual(effects(), [], `${channel} must produce no side effects`);
        }
        await invoke("installBDTheme", "https://example.com/theme.css");
        assert.deepEqual(effects(), []);
        for (const [channel, ...args] of [
            ["plugins:set-enabled", "test", true],
            ["plugins:reload", "test"],
            ["pluginWriteFile", "test", "settings.json", "changed"],
            ["backupSave", "{}"],
        ]) {
            assert.deepEqual(await invoke(channel, ...args), { ok: false, error: "PARENT_MANAGED" });
            assert.deepEqual(effects(), [], `${channel} must not call its subsystem`);
        }
        assert.deepEqual(JSON.parse(await invoke("backupRestore")), { ok: false, error: "PARENT_MANAGED" });
        openCssEditor(css);
        assert.deepEqual(effects(), [], "Direct CSS editor calls must not open a window");
        assert.equal(readFileSync(css, "utf8"), "original");
        assert.equal(emit("getConfig", "spellcheck").returnValue, true);
        assert.deepEqual(emit("getEntireConfig").returnValue, { spellcheck: true });
        assert.deepEqual(emit("getThemes").returnValue, ["preserved"]);
        assert.deepEqual(emit("getRpcBlacklist").returnValue, ["preserved"]);
        emit("setVoiceState", true, false);
        emit("setVoiceTouchbar", true);
        emit("win-minimize");
        assert.deepEqual(effects(), ["setVoiceState", "setTouchBar", "minimize"]);
        console.log(
            JSON.stringify({
                ok: true,
                deniedEvents: deniedEvents.length,
                deniedInvocations: 6,
                ordinaryControlsPreserved: true,
            }),
        );
    } else if (mode === "unmanaged") {
        emit("setConfig", "spellcheck", false);
        emit("openQuickCss");
        emit("openStorageFolder");
        assert.deepEqual(effects(), ["setConfig", "openPath", "showItemInFolder"]);
        clear();
        openCssEditor(css);
        assert.deepEqual(effects(), ["newWindow", "loadFile"]);
        emit("editor-setCSS", "unmanaged edit");
        assert.equal(readFileSync(css, "utf8"), "unmanaged edit");
        clear();
        globalThis.__managed = true;
        emit("editor-setCSS", "forbidden edit");
        openCssEditor(css);
        assert.equal(readFileSync(css, "utf8"), "unmanaged edit");
        assert.deepEqual(effects(), [], "An existing editor cannot focus or save under management");
        console.log(JSON.stringify({ ok: true, unmanagedControlsPreserved: true, existingEditorWriteDenied: true }));
    } else throw new Error(`Unknown test mode: ${mode}`);
} finally {
    rmSync(directory, { recursive: true, force: true });
}
