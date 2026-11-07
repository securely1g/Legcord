import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Settings } from "../src/@types/settings.js";
import { getWindowChrome } from "../src/common/windowChrome.ts";

const windowStyles: Settings["windowStyle"][] = ["default", "native", "overlay", "transparent", "legacy", "rebrand"];
const transparencies: Settings["transparency"][] = ["none", "modern", "universal"];
const platforms = ["linux", "win32", "darwin"];

describe("window chrome policy", () => {
    it("keeps desktop chrome out of mobile mode for every saved style and platform", () => {
        for (const platform of platforms) {
            for (const windowStyle of windowStyles) {
                for (const transparency of transparencies) {
                    const settings = Object.freeze({ mobileMode: true, windowStyle, transparency });
                    assert.deepEqual(
                        getWindowChrome(settings, platform),
                        { windowStyle: "native", transparency: "none", usesOverlayChrome: false },
                        `${platform}: ${windowStyle}, ${transparency}`,
                    );
                }
            }
        }
    });

    it("preserves desktop preferences when mobile mode is turned off again", () => {
        for (const platform of platforms) {
            for (const windowStyle of windowStyles) {
                for (const transparency of transparencies) {
                    const settings = { mobileMode: false, windowStyle, transparency };
                    const before = getWindowChrome(settings, platform);
                    settings.mobileMode = true;
                    getWindowChrome(settings, platform);
                    settings.mobileMode = false;
                    assert.deepEqual(getWindowChrome(settings, platform), before);
                    assert.equal(settings.windowStyle, windowStyle);
                    assert.equal(settings.transparency, transparency);
                }
            }
        }
    });

    it("retains the macOS native-window transparency workaround on desktop", () => {
        for (const transparency of ["modern", "universal"] as const) {
            const settings = { mobileMode: false, windowStyle: "native", transparency } as const;
            assert.equal(getWindowChrome(settings, "darwin").usesOverlayChrome, true);
            assert.equal(getWindowChrome(settings, "linux").usesOverlayChrome, false);
            assert.equal(getWindowChrome(settings, "win32").usesOverlayChrome, false);
        }
        assert.equal(
            getWindowChrome({ mobileMode: false, windowStyle: "native", transparency: "none" }, "darwin")
                .usesOverlayChrome,
            false,
        );
    });

    it("retains desktop custom and legacy titlebar choices", () => {
        for (const platform of platforms) {
            for (const windowStyle of ["default", "overlay"] as const) {
                assert.equal(
                    getWindowChrome({ mobileMode: false, windowStyle, transparency: "none" }, platform)
                        .usesOverlayChrome,
                    true,
                );
            }
            assert.deepEqual(
                getWindowChrome({ mobileMode: false, windowStyle: "legacy", transparency: "none" }, platform),
                { windowStyle: "legacy", transparency: "none", usesOverlayChrome: false },
            );
        }
    });
});
