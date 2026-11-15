import { app, session, shell, webContents } from "electron";
import {
    type ExternalUrlPolicy,
    isAllowedContentRequest,
    isDiscordNavigationUrl,
} from "../common/externalUrlPolicy.js";
import { isBlockedLocalhostWebSocket, isTelemetryBlockedUrl } from "../common/sanitization.js";

/** Embedded hosts never become top-level browsing destinations. */
export function isAllowedApplicationNavigation(url: string): boolean {
    if (isDiscordNavigationUrl(url) || url === "about:blank") return true;
    // These two local diagnostics are exposed by existing settings buttons.
    if (url === "chrome://gpu/" || url === "chrome://webrtc-internals/") return true;
    try {
        const parsed = new URL(url);
        return parsed.protocol === "legcord:" && isAllowedContentRequest(url, { enabled: true, domains: [] });
    } catch {
        return false;
    }
}

/** One app-wide boundary also covers plugin/context-menu calls and child windows. */
export function installExternalUrlGuards(readPolicy: () => ExternalUrlPolicy): void {
    shell.openExternal = async () => {
        console.info("[URL filter] Blocked an external application launch.");
    };

    app.on("web-contents-created", (_event, contents) => {
        // Main Discord windows install their own handler for safe local popouts.
        // Child windows otherwise inherit a deny-all popup policy.
        contents.setWindowOpenHandler(() => ({ action: "deny" }));
        contents.on("will-frame-navigate", (event) => {
            const allowed = event.isMainFrame
                ? isAllowedApplicationNavigation(event.url)
                : isAllowedContentRequest(event.url, readPolicy());
            if (!allowed) event.preventDefault();
        });
        contents.on("will-redirect", (event) => {
            const allowed = event.isMainFrame
                ? isAllowedApplicationNavigation(event.url)
                : isAllowedContentRequest(event.url, readPolicy());
            if (!allowed) event.preventDefault();
        });
        contents.on("will-attach-webview", (event) => event.preventDefault());
    });

    void app.whenReady().then(() => {
        // Electron keeps only one onBeforeRequest listener. Keep telemetry and
        // allowlist checks together, and install once for all windows/popouts.
        session.defaultSession.webRequest.onBeforeRequest(
            { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*", "ftp://*/*"] },
            (details, callback) => {
                const blocked =
                    isTelemetryBlockedUrl(details.url) ||
                    isBlockedLocalhostWebSocket(details.url) ||
                    !isAllowedContentRequest(details.url, readPolicy()) ||
                    (details.resourceType === "mainFrame" && !isAllowedApplicationNavigation(details.url));
                callback({ cancel: blocked });
            },
        );
    });
}

export function notifyExternalUrlPolicyChanged(): void {
    for (const contents of webContents.getAllWebContents()) {
        if (!contents.isDestroyed()) contents.send("external-url-policy-changed");
    }
}
