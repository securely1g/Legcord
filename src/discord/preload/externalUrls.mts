import type { Settings } from "../../@types/settings.js";
import { isBlockedExternalLink, shouldBlockExternalEmbed } from "../../common/externalUrlDom.js";
import type { ExternalUrlPolicy } from "../../common/externalUrlPolicy.js";

const { ipcRenderer } = require("electron");

function readPolicy(): ExternalUrlPolicy {
    const settings = ipcRenderer.sendSync("getEntireConfig") as Settings;
    return {
        enabled: settings.externalUrlAllowlistEnabled !== false,
        domains: Array.isArray(settings.externalUrlAllowlist) ? settings.externalUrlAllowlist : [],
    };
}

let policy = readPolicy();
let rescanTimer: ReturnType<typeof setTimeout> | undefined;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
const placeholders = new Map<Element, HTMLElement>();
const markedLinks = new Set<Element>();
const previousTitles = new WeakMap<Element, string | null>();
const previousDisabled = new WeakMap<Element, string | null>();
const unloadedDestinations = new WeakMap<Element, string[]>();
const EMBED_SELECTOR =
    'article[class*="embed"], [class*="embedFull_"], [class*="embedSpotify_"], [class*="embedYouTube_"]';

function showBlockedNotice(): void {
    let notice = document.getElementById("legcord-external-link-notice");
    if (!notice) {
        notice = document.createElement("div");
        notice.id = "legcord-external-link-notice";
        notice.setAttribute("role", "status");
        notice.setAttribute("aria-live", "polite");
        (document.body || document.documentElement).append(notice);
    }
    notice.textContent = "External links are blocked in Legcord.";
    notice.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
        if (notice) notice.hidden = true;
    }, 3000);
}

function eventLink(event: Event): Element | undefined {
    for (const target of event.composedPath()) {
        if (target instanceof Element && target.matches("a[href], area[href]")) return target;
    }
    return undefined;
}

function blockExternalLink(event: Event): void {
    if (event instanceof KeyboardEvent && event.key !== "Enter" && event.key !== " ") return;
    const link = eventLink(event);
    const raw = link?.getAttribute("href");
    if (raw === null || raw === undefined || !isBlockedExternalLink(raw, document.baseURI)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    showBlockedNotice();
}

// Capture before Discord's delegated handlers can call window.open or show a
// browser confirmation. Main-process guards remain the enforcement boundary.
document.addEventListener("click", blockExternalLink, true);
document.addEventListener("auxclick", blockExternalLink, true);
document.addEventListener("keydown", blockExternalLink, true);

function restoreAttribute(element: Element, name: string, previous: string | null | undefined): void {
    if (previous === null || previous === undefined) element.removeAttribute(name);
    else element.setAttribute(name, previous);
}

function scanLinks(): void {
    for (const link of markedLinks) {
        if (!link.isConnected || !isBlockedExternalLink(link.getAttribute("href") || "", document.baseURI)) {
            link.removeAttribute("data-legcord-external-link-blocked");
            restoreAttribute(link, "title", previousTitles.get(link));
            restoreAttribute(link, "aria-disabled", previousDisabled.get(link));
            markedLinks.delete(link);
        }
    }
    for (const link of document.querySelectorAll("a[href], area[href]")) {
        if (markedLinks.has(link) || !isBlockedExternalLink(link.getAttribute("href") || "", document.baseURI)) {
            continue;
        }
        previousTitles.set(link, link.getAttribute("title"));
        previousDisabled.set(link, link.getAttribute("aria-disabled"));
        link.setAttribute("data-legcord-external-link-blocked", "");
        link.setAttribute("title", "External links are blocked in Legcord.");
        link.setAttribute("aria-disabled", "true");
        markedLinks.add(link);
    }
}

function embedDestinations(embed: Element): string[] {
    const elements = [embed, ...embed.querySelectorAll("a[href], iframe, video, audio, source[src]")];
    const destinations: string[] = [];
    for (const element of elements) {
        if (element.matches("a[href]")) destinations.push(element.getAttribute("href") || "");
        if (element.matches("iframe, video, audio, source[src]") && element.hasAttribute("src")) {
            destinations.push(element.getAttribute("src") || "");
        }
        // Inline frame documents have no allowlistable origin. Resetting them
        // also stops any connections started before filtering was enabled.
        if (element.matches("iframe[srcdoc]")) destinations.push("blocked:inline-frame");
    }
    return destinations;
}

function unloadEmbeddedContent(embed: Element, newlyBlocked: boolean): void {
    const frames = [embed, ...embed.querySelectorAll("iframe")].filter(
        (element): element is HTMLIFrameElement => element instanceof HTMLIFrameElement,
    );
    for (const frame of frames) {
        if (newlyBlocked || frame.getAttribute("src") !== "about:blank" || frame.hasAttribute("srcdoc")) {
            frame.removeAttribute("srcdoc");
            // Navigating destroys the player document, including its running
            // audio, timers and WebSockets. Merely hiding it would keep playing.
            frame.src = "about:blank";
        }
    }
    const media = [embed, ...embed.querySelectorAll("video, audio")].filter(
        (element): element is HTMLMediaElement => element instanceof HTMLMediaElement,
    );
    for (const player of media) {
        if (
            newlyBlocked ||
            player.hasAttribute("src") ||
            player.srcObject ||
            player.querySelector("source[src]") ||
            !player.paused
        ) {
            player.pause();
            player.srcObject = null;
            player.removeAttribute("autoplay");
            player.removeAttribute("src");
            for (const source of player.querySelectorAll("source[src]")) source.removeAttribute("src");
            // Abort the old resource fetch and release the decoder/buffer.
            player.load();
        }
    }
}

function scanEmbeds(): void {
    for (const [embed, placeholder] of placeholders) {
        if (!embed.isConnected) {
            placeholder.remove();
            placeholders.delete(embed);
        }
    }
    const cards = Array.from(document.querySelectorAll(EMBED_SELECTOR));
    const standalonePlayers = Array.from(document.querySelectorAll("iframe, video, audio")).filter(
        (player) => !player.closest(EMBED_SELECTOR),
    );
    for (const embed of [...cards, ...standalonePlayers]) {
        const currentDestinations = embedDestinations(embed);
        // Keep the original destinations after clearing src/srcdoc so a second
        // scan cannot mistake an unloaded blocked player for allowed content.
        const destinations = [...(unloadedDestinations.get(embed) || []), ...currentDestinations];
        const blocked = shouldBlockExternalEmbed(destinations, document.baseURI, policy);
        const placeholder = placeholders.get(embed);
        if (blocked && !placeholder) {
            const notice = document.createElement("div");
            notice.className = "legcord-blocked-embed-notice";
            notice.textContent = "External embed blocked.";
            embed.setAttribute("data-legcord-blocked-embed", "");
            embed.after(notice);
            placeholders.set(embed, notice);
        } else if (!blocked && placeholder) {
            embed.removeAttribute("data-legcord-blocked-embed");
            placeholder.remove();
            placeholders.delete(embed);
            unloadedDestinations.delete(embed);
        }
        if (blocked) {
            unloadedDestinations.set(embed, [...new Set(destinations)]);
            unloadEmbeddedContent(embed, !placeholder);
        }
    }
}

function scan(): void {
    rescanTimer = undefined;
    scanLinks();
    scanEmbeds();
}

function queueScan(): void {
    if (rescanTimer !== undefined) return;
    rescanTimer = setTimeout(scan, 100);
}

function start(): void {
    const style = document.createElement("style");
    style.textContent = `
        [data-legcord-external-link-blocked] { cursor: not-allowed !important; }
        [data-legcord-blocked-embed] { display: none !important; }
        .legcord-blocked-embed-notice { color: var(--text-muted, #b5bac1); font-size: 0.85rem; padding: 0.5rem 0; }
        #legcord-external-link-notice { position: fixed; left: 50%; bottom: 5rem; transform: translateX(-50%);
            max-width: calc(100vw - 2rem); width: max-content; padding: 0.75rem 1rem; border-radius: 0.5rem;
            background: #242429; color: #fff; box-shadow: 0 2px 12px #0008; z-index: 2147483647; }
        #legcord-external-link-notice[hidden] { display: none !important; }
    `;
    document.head.append(style);
    scan();
    const observer = new MutationObserver(queueScan);
    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["href", "src", "srcdoc"],
    });
}

ipcRenderer.on("external-url-policy-changed", () => {
    policy = readPolicy();
    queueScan();
});

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
else start();
