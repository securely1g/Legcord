import { type ExternalUrlPolicy, isAllowedContentRequest, isDiscordNavigationUrl } from "./externalUrlPolicy.js";

function resolveUrl(raw: string, baseUrl: string): string | null {
    try {
        return new URL(raw, baseUrl).href;
    } catch {
        return null;
    }
}

/** Browser-launching links stay blocked even when an embed host is allowlisted. */
export function isBlockedExternalLink(raw: string, baseUrl: string): boolean {
    const url = resolveUrl(raw, baseUrl);
    return url === null || !isDiscordNavigationUrl(url);
}

/** Inspect the card's destination links, not its Discord-proxied thumbnail URL. */
export function shouldBlockExternalEmbed(
    destinations: readonly string[],
    baseUrl: string,
    policy: ExternalUrlPolicy,
): boolean {
    if (!policy.enabled) return false;
    return destinations.some((destination) => {
        const url = resolveUrl(destination, baseUrl);
        return url === null || !isAllowedContentRequest(url, policy);
    });
}
