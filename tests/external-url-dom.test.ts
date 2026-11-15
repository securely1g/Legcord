import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isBlockedExternalLink, shouldBlockExternalEmbed } from "../src/common/externalUrlDom.ts";

const baseUrl = "https://discord.com/channels/1/2";

describe("external URL presentation", () => {
    it("keeps internal Discord paths usable and blocks browser-launching URLs", () => {
        for (const url of [
            "/channels/3/4",
            "#message-1",
            "https://discord.com/settings",
            "https://ptb.discord.com/app",
        ]) {
            assert.equal(isBlockedExternalLink(url, baseUrl), false, url);
        }
        for (const url of [
            "https://github.com/Legcord/Legcord",
            "https://youtube.com/watch?v=1",
            "//example.com/",
            "mailto:user@example.com",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "https://discord.com.evil.example/",
        ]) {
            assert.equal(isBlockedExternalLink(url, baseUrl), true, url);
        }
    });

    it("hides external previews by their destination even when thumbnails are proxied", () => {
        const closed = { enabled: true, domains: [] };
        assert.equal(
            shouldBlockExternalEmbed(
                ["https://www.youtube.com/watch?v=1", "https://media.discordapp.net/external/preview.jpg"],
                baseUrl,
                closed,
            ),
            true,
        );
        assert.equal(shouldBlockExternalEmbed(["https://github.com/Legcord/Legcord"], baseUrl, closed), true);
        assert.equal(
            shouldBlockExternalEmbed(["https://cdn.discordapp.com/attachments/image.png"], baseUrl, closed),
            false,
        );
        assert.equal(shouldBlockExternalEmbed([], baseUrl, closed), false);
    });

    it("allows explicitly configured embed hosts without allowing browser launches", () => {
        const github = { enabled: true, domains: ["github.com"] };
        assert.equal(shouldBlockExternalEmbed(["https://github.com/Legcord/Legcord"], baseUrl, github), false);
        assert.equal(isBlockedExternalLink("https://github.com/Legcord/Legcord", baseUrl), true);
        assert.equal(shouldBlockExternalEmbed(["https://api.github.com/"], baseUrl, github), true);
        assert.equal(
            shouldBlockExternalEmbed(["https://youtube.com/"], baseUrl, { enabled: false, domains: [] }),
            false,
        );
    });
});
