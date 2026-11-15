import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { app, dialog } from "electron";
import type { Settings } from "../@types/settings.js";
import { normalizeAllowedDomains } from "./externalUrlPolicy.js";
import { getLang } from "./lang.js";
import { getManagedExternalUrlPolicy, getManagedSettingsPolicy } from "./managedExternalUrlPolicy.js";
import { defaults, SETTINGS_KEYS } from "./settingsDefaults.js";

export { SETTINGS_KEYS } from "./settingsDefaults.js";

import { sanitizeAdditionalArguments } from "./sanitization.js";
import { getWindowStateLocation } from "./windowState.js";
export let firstRun: boolean;

let configCache: Settings | null = null;

function ensureConfigCache(): Settings {
    if (configCache) return configCache;
    try {
        const rawData = readFileSync(getConfigLocation(), "utf-8");
        const parsed = JSON.parse(rawData) as Settings;
        configCache = Object.fromEntries(
            Object.entries(parsed).filter(([key]) => !isManagedPolicyMetadata(key)),
        ) as Settings;
        if (Object.hasOwn(configCache, "externalUrlAllowlist")) {
            configCache.externalUrlAllowlist = normalizeAllowedDomains(configCache.externalUrlAllowlist);
        }
        if (Object.hasOwn(configCache, "externalUrlAllowlistEnabled")) {
            configCache.externalUrlAllowlistEnabled = configCache.externalUrlAllowlistEnabled !== false;
        }
    } catch {
        configCache = {} as Settings;
    }
    return configCache;
}

/** Keys that exist in Settings but must not be writable from renderer IPC. */
const IPC_BLOCKED_SETTINGS_KEYS = new Set<keyof Settings>(["disableDangerousSwitchBlocking"]);

function isExternalUrlSetting(key: unknown): boolean {
    return key === "externalUrlAllowlistEnabled" || key === "externalUrlAllowlist";
}

function isManagedPolicyMetadata(key: unknown): boolean {
    return (
        key === "externalUrlPolicyManaged" ||
        key === "externalUrlPolicyInvalid" ||
        key === "settingsPolicyManaged" ||
        key === "settingsPolicyInvalid"
    );
}

function isLockedManagedSetting(key: unknown): boolean {
    return (
        getManagedSettingsPolicy().managed ||
        isManagedPolicyMetadata(key) ||
        (isExternalUrlSetting(key) && getManagedExternalUrlPolicy().managed)
    );
}

export function isValidSettingsKey(key: unknown): key is keyof Settings {
    return typeof key === "string" && SETTINGS_KEYS.has(key);
}

/** True when renderer IPC is allowed to write this settings key. */
export function isIpcWritableSettingsKey(key: unknown): key is keyof Settings {
    return isValidSettingsKey(key) && !IPC_BLOCKED_SETTINGS_KEYS.has(key) && !isLockedManagedSetting(key);
}

const safeMode: Settings = {
    ...defaults,
    mods: [],
    windowStyle: "native",
    csp: "vanilla",
    hardwareAcceleration: false,
    sdpH264BaselineRewrite: false,
    disableHttpCache: true,
    vaapi: false,
    additionalArguments: "",
    disableDangerousSwitchBlocking: false,
    extendedPluginAbilities: false,
    showExperimentalPluginMenu: false,
    quickCss: false,
};

export function checkForDataFolder(): void {
    const dataPath = join(dirname(app.getPath("exe")), "legcord-data");
    if (existsSync(dataPath) && statSync(dataPath).isDirectory()) {
        console.log("Found legcord-data folder. Running in portable mode.");
        app.setPath("userData", dataPath);
    }
}

export function getConfigLocation(): string {
    const userDataPath = app.getPath("userData");
    const storagePath = join(userDataPath, "/storage/");
    return `${storagePath}settings.json`;
}
export function getEntireConfig(): Settings {
    const policy = getManagedExternalUrlPolicy();
    const settingsPolicy = getManagedSettingsPolicy();
    return {
        ...(settingsPolicy.managed ? getManagedConfig() : ensureConfigCache()),
        externalUrlAllowlistEnabled: getConfig("externalUrlAllowlistEnabled"),
        externalUrlAllowlist: [...(getConfig("externalUrlAllowlist") ?? [])],
        externalUrlPolicyManaged: policy.managed,
        externalUrlPolicyInvalid: policy.invalid,
        settingsPolicyManaged: settingsPolicy.managed,
        settingsPolicyInvalid: settingsPolicy.invalid,
    };
}

/** User-profile values and CLI modes never override an administrator snapshot. */
function getManagedConfig(): Settings {
    return structuredClone({
        ...defaults,
        mobileMode: true,
        doneSetup: true,
        quickCss: false,
        inviteWebsocket: false,
        processScanning: false,
        ...getManagedSettingsPolicy().settings,
    }) as Settings;
}

export function getConfig<K extends keyof Settings>(object: K): Settings[K] {
    const policy = getManagedExternalUrlPolicy();
    if (object === "externalUrlPolicyManaged") return policy.managed as Settings[K];
    if (object === "externalUrlPolicyInvalid") return policy.invalid as Settings[K];
    const settingsPolicy = getManagedSettingsPolicy();
    if (object === "settingsPolicyManaged") return settingsPolicy.managed as Settings[K];
    if (object === "settingsPolicyInvalid") return settingsPolicy.invalid as Settings[K];
    if (policy.managed) {
        if (object === "externalUrlAllowlistEnabled") return policy.enabled as Settings[K];
        if (object === "externalUrlAllowlist") return [...policy.domains] as Settings[K];
    }
    if (settingsPolicy.managed) return getManagedConfig()[object];
    if (process.argv.includes("--safe-mode")) {
        return safeMode[object];
    }

    return ensureConfigCache()[object];
}

const START_MINIMIZED_MODES = new Set<Settings["startMinimized"]>(["off", "minimized", "tray"]);

/** Effective startup window mode (CLI overrides are session-only). */
export function getStartMinimizedMode(): Settings["startMinimized"] {
    if (!getManagedSettingsPolicy().managed) {
        if (process.argv.includes("--start-in-tray")) return "tray";
        if (process.argv.includes("--start-minimized")) return "minimized";
    }
    const mode = getConfig("startMinimized");
    return START_MINIMIZED_MODES.has(mode) ? mode : "off";
}

/** True when startup should not show the window normally (skip splash). */
export function isBackgroundStart(): boolean {
    return getStartMinimizedMode() !== "off";
}

function migrateStartMinimized(settingsObject: Record<string, unknown>): boolean {
    const value = settingsObject.startMinimized;
    if (typeof value === "boolean") {
        settingsObject.startMinimized = value ? "tray" : "off";
        console.log(`[Config] Migrated startMinimized boolean → "${settingsObject.startMinimized}"`);
        return true;
    }
    return false;
}
function sanitizeSettingsValue<K extends keyof Settings>(key: K, value: Settings[K]): Settings[K] {
    if (key === "externalUrlAllowlist") return normalizeAllowedDomains(value) as Settings[K];
    if (key === "externalUrlAllowlistEnabled") return (value !== false) as Settings[K];
    if (key === "additionalArguments" && typeof value === "string") {
        if (ensureConfigCache().disableDangerousSwitchBlocking) return value;
        return sanitizeAdditionalArguments(value) as Settings[K];
    }
    return value;
}

export function setConfig<K extends keyof Settings>(object: K, toSet: Settings[K]): void {
    if (isLockedManagedSetting(object)) return;
    const parsed = ensureConfigCache();
    parsed[object] = sanitizeSettingsValue(object, toSet);
    const toSave = JSON.stringify(parsed, null, 4);
    writeFileSync(getConfigLocation(), toSave, "utf-8");
}
export function setConfigBulk(object: Settings): void {
    if (getManagedSettingsPolicy().managed) return;
    const existingData = configCache ?? ({} as Settings);
    const sanitizedEntries = Object.fromEntries(
        Object.entries(object)
            .filter(([key]) => isValidSettingsKey(key) && !isLockedManagedSetting(key))
            .map(([key, value]) => [
                key,
                sanitizeSettingsValue(key as keyof Settings, value as Settings[keyof Settings]),
            ]),
    ) as Partial<Settings>;
    const mergedData = { ...existingData, ...sanitizedEntries };
    configCache = mergedData as Settings;
    const toSave = JSON.stringify(mergedData, null, 4);
    writeFileSync(getConfigLocation(), toSave, "utf-8");
}
export function checkIfConfigExists(): void {
    const userDataPath = app.getPath("userData");
    const storagePath = join(userDataPath, "/storage/");
    const settingsFile = `${storagePath}settings.json`;

    if (!existsSync(app.getPath("userData"))) {
        mkdirSync(app.getPath("userData"));
        console.log("Created missing user data folder");
    }
    // A managed device has already been provisioned by its administrator.
    // A missing or edited daily profile must not reopen onboarding.
    if (getManagedSettingsPolicy().managed) {
        if (!existsSync(storagePath)) mkdirSync(storagePath, { recursive: true });
        firstRun = false;
        return;
    }

    try {
        if (!existsSync(settingsFile)) {
            if (!existsSync(storagePath)) {
                mkdirSync(storagePath);
                console.log("Created missing storage folder");
            }
            console.log("First run of the Legcord. Starting setup.");
            setup();
            firstRun = true;
        } else if (!getConfig("doneSetup")) {
            console.log("First run of the Legcord. Starting setup.");
            setup();
            firstRun = true;
        } else {
            console.log("Legcord has been run before. Skipping setup.");
        }
    } catch {
        checkIfConfigIsBroken();
    }
}
export function checkIfConfigIsBroken(): void {
    if (getManagedSettingsPolicy().managed) {
        checkWindowStateIntegrity();
        handleAutomaticUpdates(getEntireConfig());
        return;
    }
    try {
        const settingsObject = ensureConfigCache() as Settings & Record<string, unknown>;

        if (migrateStartMinimized(settingsObject)) {
            writeFileSync(getConfigLocation(), JSON.stringify(settingsObject, null, 4), "utf-8");
        }

        let configWasFine = true;
        const settingsKeys = Object.keys(settingsObject) as (keyof Settings)[];
        // Managed filter preferences are projections, not required user-profile
        // entries. Migration must not reset profiles or repeatedly fill locked keys.
        const defaultKeys = (Object.keys(defaults) as (keyof Settings)[]).filter((key) => !isLockedManagedSetting(key));

        const missingKeysInSettings = defaultKeys.filter((key) => !settingsKeys.includes(key));
        configWasFine = missingKeysInSettings.length === 0;

        defaultKeys.forEach((key: keyof Settings) => {
            const valueInSettings = settingsObject[key];
            const valueInDefaults = defaults[key];
            if (!valueInSettings || !valueInDefaults) return;
            if (typeof valueInDefaults !== typeof valueInSettings) {
                console.log(
                    `Root config ${key} type (${typeof valueInSettings}) differs from default type (${typeof valueInDefaults}). Setting default value...`,
                );
                setConfig(key, valueInDefaults);
                configWasFine = false;
            }
        });

        missingKeysInSettings.forEach((missingKey) => {
            console.log(`Missing config root entry ${missingKey}, setting default config for this entry...`);
            setConfig(missingKey, defaults[missingKey]);
        });

        console.log(configWasFine ? "Config is fine" : "Config is now fine");
    } catch (e) {
        console.error(e);
        console.log("Detected a corrupted config");
        setup();
        dialog.showErrorBox(getLang("config-corrupted-title"), getLang("config-corrupted-message"));
    }
    checkWindowStateIntegrity();
    handleAutomaticUpdates(configCache!);
}

function checkWindowStateIntegrity(): void {
    try {
        const windowData = readFileSync(getWindowStateLocation(), "utf-8");
        JSON.parse(windowData);
        console.log("Window config is fine");
    } catch (e) {
        console.error(e);
        writeFileSync(getWindowStateLocation(), "{}", "utf-8");
        console.log("Detected a corrupted window config");
    }
}

export function setup(): void {
    console.log("Setting up temporary Legcord settings.");
    setConfigBulk({
        ...defaults,
    });
}

export function setFirstRun(value: boolean): void {
    firstRun = value;
}

export function handleAutomaticUpdates(settings: Settings): void {
    if (settings.automaticUpdates) {
        require("../updater.js");
    }
}
