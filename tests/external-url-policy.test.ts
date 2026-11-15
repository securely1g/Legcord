import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    type ExternalUrlPolicy,
    isAllowedContentRequest,
    isAllowedExternalUrl,
    isDiscordNavigationUrl,
    normalizeAllowedDomains,
} from "../src/common/externalUrlPolicy.ts";

const policy: ExternalUrlPolicy = { enabled: true, domains: ["github.com"] };

describe("normalizeAllowedDomains", () => {
    it("normalizes exact DNS hosts, including international names, and removes duplicates", () => {
        assert.deepEqual(normalizeAllowedDomains([" GitHub.COM ", "github.com", "api.github.com", "bücher.example"]), [
            "github.com",
            "api.github.com",
            "xn--bcher-kva.example",
        ]);
    });

    it("drops URLs, patterns, ports, credentials, IPs and malformed names", () => {
        assert.deepEqual(
            normalizeAllowedDomains([
                "https://github.com",
                "github.com/path",
                "github.com:443",
                "user@github.com",
                "*.github.com",
                "github.com?query",
                "github.com#fragment",
                "github%2ecom",
                "github.com\\evil",
                "github.com.",
                ".github.com",
                "github..com",
                "-github.com",
                "github-.com",
                "git_hub.com",
                "git hub.com",
                "git\nhub.com",
                "127.0.0.1",
                "127.1",
                "0x7f000001",
                "2130706433",
                "[::1]",
                "localhost",
                `${"a".repeat(64)}.com`,
                42,
                null,
                {},
            ]),
            [],
        );
    });

    it("fails closed for malformed configuration containers", () => {
        for (const value of [undefined, null, "github.com", { domains: ["github.com"] }, true]) {
            assert.deepEqual(normalizeAllowedDomains(value), []);
        }
        assert.deepEqual(normalizeAllowedDomains(["github.com", false, "https://youtube.com"]), ["github.com"]);
    });
});

describe("isAllowedExternalUrl", () => {
    it("allows only the selected HTTPS hostname and the default secure port", () => {
        for (const url of [
            "https://github.com",
            "https://GITHUB.COM/project",
            "https://github.com:443/path?q=x#hash",
        ]) {
            assert.equal(isAllowedExternalUrl(url, policy), true, url);
        }
    });

    it("blocks protocols, credentials, alternate ports and hostname lookalikes", () => {
        for (const url of [
            "http://github.com",
            "wss://github.com",
            "file:///tmp/github.com",
            "javascript:alert(1)",
            "mailto:github.com",
            "https://github.com:8443",
            "https://user:pass@github.com",
            "https://@github.com",
            "https://github.com@youtube.com",
            "https://github.com.youtube.com",
            "https://api.github.com",
            "https://github.com.",
            "https://youtube.com/?next=https://github.com",
            "https://github.com\\@youtube.com",
            "https://git\nhub.com",
            "/github.com",
            "not a url",
        ]) {
            assert.equal(isAllowedExternalUrl(url, policy), false, url);
        }
    });

    it("blocks all external links for an enabled empty list and leaves legacy mode to its caller", () => {
        assert.equal(isAllowedExternalUrl("https://github.com", { enabled: true, domains: [] }), false);
        assert.equal(isAllowedExternalUrl("steam://run/123", { enabled: false, domains: [] }), true);
    });
});

describe("isDiscordNavigationUrl", () => {
    it("allows Discord app origins and blobs from those origins", () => {
        for (const url of [
            "https://discord.com/channels/@me",
            "https://ptb.discord.com/app",
            "https://canary.discord.com:443/popout",
            "blob:https://discord.com/file-id",
        ]) {
            assert.equal(isDiscordNavigationUrl(url), true, url);
        }
    });

    it("rejects other subdomains, credentials, ports, protocols and forged blob origins", () => {
        for (const url of [
            "https://cdn.discord.com/file",
            "https://discord.com.evil/app",
            "https://discord.com@evil.com/app",
            "https://@discord.com/app",
            "https://discord.com:8443/app",
            "http://discord.com/app",
            "legcord://html/setup.html",
            "blob:https://discord.com.evil/file-id",
            "blob:https://user@discord.com/file-id",
            "blob:null/file-id",
            "blob:blob:https://discord.com/file-id",
            "invalid",
        ]) {
            assert.equal(isDiscordNavigationUrl(url), false, url);
        }
    });
});

describe("isAllowedContentRequest", () => {
    it("preserves Discord assets, gateway and voice transport", () => {
        for (const url of [
            "https://discord.com/app",
            "https://canary.discord.com/assets/app.js",
            "https://cdn.discordapp.com/attachments/image.png",
            "https://media.discordapp.net/attachments/image.png",
            "wss://gateway.discord.gg/?v=10",
            "wss://gateway.discord.com/?v=10",
            "wss://us-west123.discord.media/?v=8",
            "ws://localhost:1211/",
            "ws://127.0.0.1:1112/",
            "wss://localhost:6888/",
            "https://github.com/project",
        ]) {
            assert.equal(isAllowedContentRequest(url, policy), true, url);
        }
    });

    it("blocks third-party embeds, Activities, lookalikes and unsupported transport", () => {
        for (const url of [
            "https://www.youtube.com/embed/video",
            "https://youtube-nocookie.com/embed/video",
            "https://rr1.googlevideo.com/videoplayback",
            "https://player.twitch.tv/",
            "https://open.spotify.com/embed/track/id",
            "https://123.discordsays.com/youtube.com/embed/video",
            "https://discord.com.evil/asset",
            "https://evildiscordapp.com/asset",
            "https://gateway.discord.gg.evil/",
            "https://gateway.discord.gg:8443/",
            "https://user@discord.com/asset",
            "http://cdn.discordapp.com/asset",
            "ws://gateway.discord.gg/",
            "wss://github.com/socket",
            "ws://localhost:9999/",
            "ws://127.0.0.1:443/",
            "ws://localhost.evil:1211/",
            "ws://user@localhost:1211/",
            "https://api.github.com/",
            "file:///tmp/image.png",
            "legcord://evil/asset",
            "legcord://user@assets/image.png",
            "legcord://assets:444/image.png",
        ]) {
            assert.equal(isAllowedContentRequest(url, policy), false, url);
        }
    });

    it("checks the original HTTPS host of Discord external-media proxies", () => {
        const noExternalHosts: ExternalUrlPolicy = { enabled: true, domains: [] };
        for (const host of ["images-ext-1.discordapp.net", "images-ext-2.discordapp.net", "media.discordapp.net"]) {
            const githubProxy = `https://${host}/external/aBc_123-xyz/https/github.com/project/image.png?width=800`;
            assert.equal(isAllowedContentRequest(githubProxy, noExternalHosts), false, githubProxy);
            assert.equal(isAllowedContentRequest(githubProxy, policy), true, githubProxy);
            for (const originalHost of ["youtube.com", "github.com.evil", "api.github.com", "user@github.com"]) {
                const proxy = `https://${host}/external/hash/https/${originalHost}/video.mp4`;
                assert.equal(isAllowedContentRequest(proxy, policy), false, proxy);
            }
        }
        assert.equal(
            isAllowedContentRequest(
                "https://media.discordapp.net/external/hash/https/discord.com/video.mp4",
                noExternalHosts,
            ),
            false,
        );
        assert.equal(
            isAllowedContentRequest("https://media.discordapp.net/external/hash/https/youtube.com/video.mp4", {
                enabled: true,
                domains: ["media.discordapp.net"],
            }),
            false,
        );
    });

    it("fails closed for malformed or insecure proxy destinations", () => {
        for (const path of [
            "/external/hash/http/github.com/image.png",
            "/external/hash/ftp/github.com/image.png",
            "/external/hash/HTTPS/github.com/image.png",
            "/external/hash/https/",
            "/external//https/github.com/image.png",
            "/external/hash/https",
            "/external/hash/https/github.com:8443/image.png",
            "/external/hash/https/@github.com/image.png",
            "/external/hash/https/github.com%2Fevil/image.png",
            "/external/hash",
            "/external",
            "/External/hash/https/github.com/image.png",
            "/%65xternal/hash/https/github.com/image.png",
            "//external/hash/https/github.com/image.png",
        ]) {
            const proxy = `https://media.discordapp.net${path}`;
            assert.equal(isAllowedContentRequest(proxy, policy), false, proxy);
        }
        assert.equal(
            isAllowedContentRequest("blob:https://media.discordapp.net/external/hash/https/youtube.com/video", policy),
            false,
        );
    });

    it("keeps uploaded Discord content independent of external-media permissions", () => {
        const noExternalHosts: ExternalUrlPolicy = { enabled: true, domains: [] };
        for (const path of [
            "/attachments/channel/file/video.mp4",
            "/avatars/user/avatar.webp",
            "/icons/guild/icon.png",
        ]) {
            assert.equal(isAllowedContentRequest(`https://cdn.discordapp.com${path}`, noExternalHosts), true, path);
            assert.equal(isAllowedContentRequest(`https://media.discordapp.net${path}`, noExternalHosts), true, path);
        }
    });

    it("permits local resources and blobs only from approved origins", () => {
        for (const url of [
            "about:blank",
            "data:image/png;base64,abc",
            "legcord://assets/css/mobile.css",
            "legcord://html/settings.html",
            "legcord://plugins/settings/plugin.js",
            "legcord://local/custom.css",
            "blob:https://discord.com/blob-id",
            "blob:https://cdn.discordapp.com/blob-id",
            "blob:https://github.com/blob-id",
            "blob:legcord://html/blob-id",
        ]) {
            assert.equal(isAllowedContentRequest(url, policy), true, url);
        }
        for (const url of ["blob:https://youtube.com/blob-id", "blob:null/blob-id", "blob:file:///tmp/file"]) {
            assert.equal(isAllowedContentRequest(url, policy), false, url);
        }
    });

    it("evaluates redirect destinations independently", () => {
        assert.equal(isAllowedContentRequest("https://github.com/redirect?url=https://youtube.com", policy), true);
        assert.equal(isAllowedContentRequest("https://youtube.com", policy), false);
        assert.equal(isAllowedContentRequest("https://discord.com/redirect?url=https://youtube.com", policy), true);
        assert.equal(isAllowedContentRequest("https://www.youtube.com/embed/video", policy), false);
    });

    it("preserves ordinary requests when the filter is disabled", () => {
        assert.equal(
            isAllowedContentRequest("https://www.youtube.com/embed/video", { enabled: false, domains: [] }),
            true,
        );
    });
});
