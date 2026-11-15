export interface ExternalUrlPolicy {
    enabled: boolean;
    domains: readonly string[];
}

const DISCORD_APP_HOSTS = new Set(["discord.com", "ptb.discord.com", "canary.discord.com"]);
const DISCORD_CONTENT_DOMAINS = ["discord.com", "discordapp.com", "discordapp.net", "discord.media"];
const LEGCORD_CONTENT_HOSTS = new Set(["plugins", "html", "js", "assets", "css", "local"]);
const LOCAL_RPC_PORTS = new Set(["1211", "1112", "6888"]);

function hasAsciiControls(value: string, includeSpace = false): boolean {
    for (const character of value) {
        const code = character.charCodeAt(0);
        if (code <= (includeSpace ? 32 : 31) || code === 127) return true;
    }
    return false;
}

/**
 * User entries are exact DNS hostnames, never URLs or wildcard patterns.
 * A listed github.com does not grant access to api.github.com or github.com.evil.
 * International names are stored in their ASCII (punycode) form.
 */
export function normalizeAllowedDomains(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const domains = new Set<string>();
    for (const entry of value) {
        if (typeof entry !== "string") continue;
        const candidate = entry.trim();
        if (!candidate || /[\s/:\\@?#%*[\]]/u.test(candidate) || hasAsciiControls(candidate)) continue;
        const url = parseUrl(`https://${candidate}`);
        const hostname = url?.hostname ?? "";
        // The browser URL parser also canonicalizes decimal, hex and short IPv4.
        if (!hostname || hostname.length > 253 || /^\d+\.\d+\.\d+\.\d+$/u.test(hostname)) continue;
        const labels = hostname.split(".");
        if (labels.length < 2) continue;
        if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) continue;
        domains.add(hostname);
    }
    return [...domains];
}

function parseUrl(value: string): URL | null {
    // URL parsing silently removes controls and treats backslashes as slashes.
    // Reject those ambiguous spellings before comparing trusted hostnames.
    if (typeof value !== "string" || value.includes("\\") || hasAsciiControls(value, true)) return null;
    try {
        return new URL(value);
    } catch {
        return null;
    }
}

function hasNoCredentials(url: URL, raw: string): boolean {
    // Checking the authority also catches empty userinfo, e.g. https://@github.com.
    return !url.username && !url.password && !/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/iu.test(raw);
}

function isSecureRemoteUrl(url: URL, raw: string): boolean {
    return (
        (url.protocol === "https:" || url.protocol === "wss:") &&
        hasNoCredentials(url, raw) &&
        (url.port === "" || url.port === "443")
    );
}

function isDiscordContentHost(hostname: string): boolean {
    // Only Discord infrastructure gets subdomain matching, with a DNS label boundary.
    return (
        hostname === "gateway.discord.gg" ||
        DISCORD_CONTENT_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))
    );
}

function isTrustedLegcordUrl(url: URL, raw: string): boolean {
    return (
        url.protocol === "legcord:" &&
        hasNoCredentials(url, raw) &&
        url.port === "" &&
        LEGCORD_CONTENT_HOSTS.has(url.hostname)
    );
}

function isAllowedRemoteContent(url: URL, raw: string, policy: ExternalUrlPolicy): boolean {
    if (!isSecureRemoteUrl(url, raw)) return false;
    const isDiscordCdn = ["discordapp.com", "discordapp.net"].some(
        (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`),
    );
    if (isDiscordCdn) {
        const [, route, hash, originalScheme, originalHost] = url.pathname.split("/");
        // The CDN's /external/<hash>/https/<host>/... endpoint proxies third-party
        // media. Trust its original host, never the Discord proxy hostname.
        // Reject ambiguous route encodings rather than letting a CDN decode an
        // unrecognized spelling into an external proxy after our check.
        if (url.pathname.startsWith("//") || route?.includes("%")) return false;
        if (route?.toLowerCase() === "external") {
            if (
                url.protocol !== "https:" ||
                route !== "external" ||
                !hash ||
                !/^[a-z0-9_-]+$/iu.test(hash) ||
                originalScheme !== "https" ||
                !originalHost
            ) {
                return false;
            }
            return isAllowedExternalUrl(`https://${originalHost}/`, policy);
        }
    }
    if (isDiscordContentHost(url.hostname)) return true;
    return url.protocol === "https:" && policy.domains.includes(url.hostname);
}

/** Host allowlist predicate only; never authorizes launching another application. */
export function isAllowedExternalUrl(raw: string, policy: ExternalUrlPolicy): boolean {
    if (!policy.enabled) return true;
    const url = parseUrl(raw);
    return !!url && url.protocol === "https:" && isSecureRemoteUrl(url, raw) && policy.domains.includes(url.hostname);
}

/** App navigation is restricted to the three official Discord app origins. */
export function isDiscordNavigationUrl(raw: string): boolean {
    let url = parseUrl(raw);
    if (!url) return false;
    if (url.protocol === "blob:") {
        raw = url.pathname;
        url = parseUrl(raw);
        if (!url) return false;
    }
    return url.protocol === "https:" && isSecureRemoteUrl(url, raw) && DISCORD_APP_HOSTS.has(url.hostname);
}

/**
 * Preserve Discord transport/assets while filtering third-party embedded content.
 * Activities (*.discordsays.com) are deliberately outside Discord infrastructure.
 * Call this for every request/redirect: an allowed starting URL grants no trust to
 * its redirect destination. Uploaded Discord attachments remain Discord content;
 * external media proxies require their original host to be explicitly allowed.
 */
export function isAllowedContentRequest(raw: string, policy: ExternalUrlPolicy): boolean {
    if (!policy.enabled) return true;
    const url = parseUrl(raw);
    if (!url) return false;
    if (raw === "about:blank" || url.protocol === "data:") return true;
    if (isTrustedLegcordUrl(url, raw)) return true;
    // Preserve Legcord's three established loopback RPC integrations only.
    if (
        (url.protocol === "ws:" || url.protocol === "wss:") &&
        (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
        hasNoCredentials(url, raw) &&
        LOCAL_RPC_PORTS.has(url.port)
    ) {
        return true;
    }
    if (url.protocol === "blob:") {
        const inner = parseUrl(url.pathname);
        if (!inner) return false;
        return (
            isTrustedLegcordUrl(inner, url.pathname) ||
            (inner.protocol === "https:" && isAllowedRemoteContent(inner, url.pathname, policy))
        );
    }
    return isAllowedRemoteContent(url, raw, policy);
}
