import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const managed = process.argv[2] === "managed";
const directory = mkdtempSync(path.join(tmpdir(), "legcord-managed-runtime-"));
const state = {
    directory,
    managed,
    opened: [],
    javascript: [],
    navigation: [],
    loadedExtensions: [],
    configWrites: [],
    pluginExecuted: 0,
    menus: [],
    windows: [],
    ipc: new Map(),
    quit: 0,
    fetched: [],
};
globalThis.__managedRuntimeFixture = state;
globalThis.fetch = async (url) => {
    state.fetched.push(String(url));
    return { ok: true, json: async () => [{ object: { sha: "fixture" } }], text: async () => "fixture mod runtime" };
};
mkdirSync(path.join(directory, "storage"));
mkdirSync(path.join(directory, "extensions", "extension-test"), { recursive: true });
mkdirSync(path.join(directory, "plugins", "runtime-test"), { recursive: true });
mkdirSync(path.join(directory, "themes"));
const languageFile = path.join(directory, "storage", "lang.json");
writeFileSync(languageFile, JSON.stringify({ lang: "en-US" }));
writeFileSync(path.join(directory, "quickCss.css"), "body { color: red; }");
writeFileSync(path.join(directory, "source.css"), "/**\n * @name Fixture\n */\nbody { color: blue; }");
writeFileSync(
    path.join(directory, "extensions", "extension-test", "manifest.json"),
    JSON.stringify({ name: "Fixture", version: "1.0", manifest_version: 3 }),
);
writeFileSync(
    path.join(directory, "plugins", "runtime-test", "manifest.json"),
    JSON.stringify({
        id: "runtime-test",
        name: "Fixture",
        version: "1.0",
        main: "main.mjs",
        preload: "runtime.js",
        renderer: "runtime.js",
    }),
);
writeFileSync(
    path.join(directory, "plugins", "runtime-test", "main.mjs"),
    "globalThis.__managedRuntimeFixture.pluginExecuted++;",
);
writeFileSync(path.join(directory, "plugins", "runtime-test", "runtime.js"), "/* fixture runtime */");

const electron = `
const state = globalThis.__managedRuntimeFixture;
export const app = { getPath:()=>state.directory, getVersion:()=>"test", whenReady:()=>Promise.resolve(), quit:()=>state.quit++ };
export const shell = { openPath:async p=>{state.opened.push(p);return "";} };
export const session = { defaultSession:{loadExtension:async p=>{state.loadedExtensions.push(p);}} };
export const BrowserWindow = class {constructor(options){state.windows.push(options);}loadURL(){return Promise.resolve();}};
export const Menu = {buildFromTemplate:value=>value,setApplicationMenu:menu=>state.menus.push(menu)};
export const dialog = {};
export const ipcMain = {on:(name,fn)=>state.ipc.set(name,fn),handle:()=>{}};
`;
const windowStub = `
const state = globalThis.__managedRuntimeFixture;
export const mainWindows = [{webContents:{executeJavaScript:js=>{state.javascript.push(js);return Promise.resolve();},navigationHistory:{goBack:()=>state.navigation.push("back"),goForward:()=>state.navigation.push("forward")}}}];
`;
const policyStub = `export const getManagedSettingsPolicy=()=>({managed:globalThis.__managedRuntimeFixture.managed,invalid:false,settings:{},language:"fr-FR"});`;
const configStub = `
export const getConfig=key=>({pluginStates:{"runtime-test":true},externalUrlPolicyManaged:false,quickCss:true,keybinds:[],mods:[],noBundleUpdates:[]}[key]);
export const setConfig=(key,value)=>globalThis.__managedRuntimeFixture.configWrites.push([key,value]);
export const setConfigBulk=value=>globalThis.__managedRuntimeFixture.configWrites.push(["bulk",value]);
export const getStartMinimizedMode=()=>"off";
export const isBackgroundStart=()=>false;
export const getConfigLocation=()=>globalThis.__managedRuntimeFixture.directory+"/storage/settings.json";
`;
registerHooks({
    resolve(specifier, context, nextResolve) {
        let source;
        if (specifier === "electron") source = electron;
        else if (specifier === "electron-is-dev") source = "export default false;";
        else if (specifier.endsWith("/managedExternalUrlPolicy.js") || specifier === "./managedExternalUrlPolicy.js")
            source = policyStub;
        else if (specifier.endsWith("/window.js")) source = windowStub;
        else if (specifier.endsWith("/config.js") || specifier === "./config.js") source = configStub;
        else if (specifier === "./dom.js")
            source = "export const navigateTo=(_win,url)=>globalThis.__managedRuntimeFixture.navigation.push(url);";
        else if (specifier.endsWith("/lang.js")) source = "export const getLang=key=>key,getRawLang=()=>({});";
        else if (specifier === "../main.js") source = "export const handleRestart=()=>{};";
        else if (context.parentURL?.endsWith("/src/setup/main.ts") && specifier === "./tray.js") source = "";
        else if (specifier === "spitroast/dist/index.mjs")
            source = "export const after=()=>{},before=()=>{},instead=()=>{};";
        if (source !== undefined)
            return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
        return nextResolve(specifier, context);
    },
});

const load = (relative) => import(pathToFileURL(path.resolve(relative)).href);
try {
    const actions = await load("src/common/keybindActions.ts");
    actions.runAction({ action: "openQuickCss" });
    actions.runAction({ action: "runJavascript", js: "fixture script" });
    assert.equal(state.opened.length, managed ? 0 : 1);
    assert.equal(state.javascript.includes("fixture script"), !managed);
    actions.runAction({ action: "mute" });
    actions.runAction({ action: "navigateBack" });
    assert.ok(state.javascript.some((js) => js.includes("AUDIO_TOGGLE_SELF_MUTE")));
    assert.ok(state.navigation.includes("back"));

    const language = await load("src/common/lang.ts");
    assert.equal(language.getLangName(), managed ? "fr-FR" : "en-US");
    const languageBefore = readFileSync(languageFile, "utf8");
    language.setLang("de-DE");
    assert.equal(language.getLangName(), managed ? "fr-FR" : "de-DE");
    assert.equal(readFileSync(languageFile, "utf8") === languageBefore, managed);

    const plugins = await load("src/discord/plugins/manager.ts");
    await plugins.initializePluginSystem();
    assert.equal(state.pluginExecuted, managed ? 0 : 1);
    assert.equal(plugins.listPlugins().length, managed ? 0 : 1);
    assert.equal(plugins.getRuntimeEntries("preload").length, managed ? 0 : 1);
    assert.equal(plugins.getRuntimeScript("runtime-test", "renderer"), managed ? null : "/* fixture runtime */");
    assert.equal(await plugins.setPluginEnabled("runtime-test", false), !managed);
    assert.equal(await plugins.reloadPlugin("runtime-test"), !managed);
    assert.equal(state.configWrites.length, managed ? 0 : 1);

    await load("src/discord/extensions/plugin.ts");
    assert.equal(state.loadedExtensions.length, managed ? 0 : 1);

    const themes = await load("src/common/themes.ts");
    const callbacks = new Map();
    const sent = [];
    const fakeWindow = {
        isDestroyed: () => false,
        webContents: { send: (...args) => sent.push(args), on: (event, fn) => callbacks.set(event, fn) },
        on: (event, fn) => callbacks.set(event, fn),
    };
    const cssBefore = readFileSync(path.join(directory, "quickCss.css"), "utf8");
    themes.startThemeWatcher();
    themes.injectThemesMain(fakeWindow);
    themes.initQuickCss(fakeWindow);
    await themes.installTheme(path.join(directory, "source.css"), { allowLocalPath: true });
    assert.equal(callbacks.has("did-finish-load"), !managed);
    assert.equal(sent.length > 0, !managed);
    assert.equal(readdirSync(path.join(directory, "themes")).length > 0, !managed);
    assert.equal(readFileSync(path.join(directory, "quickCss.css"), "utf8"), cssBefore);
    if (managed) {
        themes.setThemeEnabled("Fixture-BD", true);
        themes.uninstallTheme("Fixture-BD");
        assert.deepEqual(readdirSync(path.join(directory, "themes")), []);
    }
    callbacks.get("closed")?.();
    themes.stopThemeWatcher();

    const menu = await load("src/discord/menu.ts");
    menu.setMenu();
    const devTools = state.menus[0][0].submenu.find((item) => item.role === "toggleDevTools");
    assert.equal(devTools.enabled, !managed);
    assert.equal(devTools.visible, !managed);
    const splash = await load("src/splash/main.ts");
    await splash.createSplashWindow();
    assert.equal(state.windows.at(-1).webPreferences.devTools, !managed);
    const setup = await load("src/setup/main.ts");
    void setup.createSetupWindow();
    assert.equal(state.windows.at(-1).webPreferences.devTools, !managed);
    const writesBefore = state.configWrites.length;
    state.ipc.get("setup-saveSettings")({}, { quickCss: true });
    assert.equal(state.configWrites.length - writesBefore, managed ? 0 : 1);
    if (managed) {
        const settingsFile = path.join(directory, "storage", "settings.json");
        writeFileSync(settingsFile, "preserved");
        state.ipc.get("setup-quit")();
        assert.equal(readFileSync(settingsFile, "utf8"), "preserved");
        assert.equal(state.quit, 1);
    }

    const modloader = await load("src/discord/extensions/modloader.ts");
    const writesBeforeMods = state.configWrites.length;
    await modloader.fetchMods();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.fetched.length > 0, !managed);
    assert.equal(state.configWrites.length > writesBeforeMods, !managed);
    if (managed) {
        assert.equal(
            readdirSync(directory).includes("shelter.js"),
            false,
            "Managed startup must not create a profile runtime cache",
        );
    }
    console.log(JSON.stringify({ ok: true, managed }));
} finally {
    rmSync(directory, { recursive: true, force: true });
}
