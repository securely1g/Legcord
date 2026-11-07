import type { Settings } from "../@types/settings.js";

type WindowChromeSettings = Pick<Settings, "mobileMode" | "windowStyle" | "transparency">;

/** Keep main-process window options and renderer titlebars on the same policy. */
export function getWindowChrome(settings: WindowChromeSettings, platform: string) {
    // Discord's mobile layout must not receive desktop titlebar styles or platform classes.
    // Use an opaque native frame: native + transparency hides macOS's traffic lights,
    // and retaining the desktop overlay workaround would reintroduce desktop chrome.
    const windowStyle = settings.mobileMode ? "native" : settings.windowStyle;
    const transparency = settings.mobileMode ? "none" : settings.transparency;
    const usesOverlayChrome =
        windowStyle === "default" ||
        windowStyle === "overlay" ||
        (windowStyle === "native" && platform === "darwin" && transparency !== "none");

    return { windowStyle, transparency, usesOverlayChrome };
}
