import { defaults, SETTINGS_KEYS } from "./settingsDefaults.js";

const choices: Record<string, readonly string[]> = {
    windowStyle: ["default", "native", "overlay", "transparent", "legacy", "rebrand"],
    channel: ["stable", "ptb", "canary"],
    transparency: ["universal", "modern", "none"],
    windowMaterial: ["mica", "tabbed", "acrylic", "none"],
    csp: ["vanilla", "strict", "none"],
    performanceMode: [
        "battery",
        "dynamic",
        "performance",
        "balanced",
        "memory",
        "voip",
        "latency",
        "smoothScreenshare",
        "none",
    ],
    startMinimized: ["off", "minimized", "tray"],
    proxyMode: ["system", "direct", "fixed_servers", "pac_script", "auto_detect"],
    tray: [
        "dynamic",
        "dsc-tray",
        "clsc-dsc-tray",
        "ac_plug_colored",
        "ac_white_plug",
        "ac_white_plug_hollow",
        "ac_black_plug",
        "ac_black_plug_hollow",
        "disabled",
    ],
};
const mods = new Set(["vencord", "equicord", "custom", "shelter"]);
const disabledInManagedMode = new Set([
    "quickCss",
    "useSystemCssEditor",
    "extendedPluginAbilities",
    "showExperimentalPluginMenu",
    "disableDangerousSwitchBlocking",
    "automaticUpdates",
]);
const keybindActions = new Set([
    "mute",
    "deafen",
    "leaveCall",
    "navigateBack",
    "navigateForward",
    "openQuickCss",
    "pushToTalk",
    "openSettings",
    "runJavascript",
]);

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validKeybind(value: unknown): boolean {
    if (!record(value)) return false;
    return (
        ["accelerator", "id"].every((key) => typeof value[key] === "string") &&
        typeof value.action === "string" &&
        keybindActions.has(value.action) &&
        typeof value.global === "boolean" &&
        typeof value.enabled === "boolean" &&
        (value.js === undefined || typeof value.js === "string") &&
        Object.keys(value).every((key) => ["accelerator", "action", "global", "enabled", "id", "js"].includes(key))
    );
}

/** Reject unknown and mistyped administrator values as one invalid policy. */
export function validManagedSettings(value: unknown): value is Record<string, unknown> {
    if (!record(value) || Object.keys(value).length > SETTINGS_KEYS.size) return false;
    return Object.entries(value).every(([key, item]) => {
        if (!SETTINGS_KEYS.has(key) || key === "externalUrlAllowlist" || key === "externalUrlAllowlistEnabled")
            return false;
        if (disabledInManagedMode.has(key)) return item === false;
        if (key === "mods") return Array.isArray(item) && item.length === 0;
        if (choices[key]) return typeof item === "string" && choices[key].includes(item);
        if (key === "noBundleUpdates")
            return Array.isArray(item) && item.every((mod) => typeof mod === "string" && mods.has(mod));
        if (key === "spellcheckLanguage")
            return (
                Array.isArray(item) &&
                item.every((lang) => typeof lang === "string" && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(lang))
            );
        if (key === "keybinds")
            return (
                Array.isArray(item) &&
                item.every((entry) => validKeybind(entry) && !["runJavascript", "openQuickCss"].includes(entry.action))
            );
        if (key === "pluginStates") return record(item) && Object.values(item).every((enabled) => enabled === false);
        if (key === "audio")
            return (
                record(item) &&
                Object.keys(item).length === Object.keys(defaults.audio).length &&
                Object.entries(defaults.audio).every(
                    ([audioKey, example]) => typeof item[audioKey] === typeof example,
                ) &&
                ["loopback", "loopbackWithMute"].includes(String(item.loopbackType))
            );
        const example = defaults[key as keyof typeof defaults];
        if (typeof item !== typeof example) return false;
        return typeof item !== "number" || (Number.isFinite(item) && item > 0);
    });
}

export function freezeManagedValue<T>(value: T): T {
    if (value && typeof value === "object") {
        for (const child of Object.values(value)) freezeManagedValue(child);
        Object.freeze(value);
    }
    return value;
}
