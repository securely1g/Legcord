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
                        {
                            windowStyle: "native",
                            transparency: "none",
                            usesOverlayChrome: false,
                            frame: platform !== "linux",
                        },
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

    it("retains desktop native frames and the macOS transparency workaround", () => {
        for (const platform of ["linux", "win32"]) {
            for (const transparency of transparencies) {
                assert.deepEqual(
                    getWindowChrome({ mobileMode: false, windowStyle: "native", transparency }, platform),
                    { windowStyle: "native", transparency, usesOverlayChrome: false, frame: true },
                );
            }
        }
        for (const transparency of ["modern", "universal"] as const) {
            const settings = { mobileMode: false, windowStyle: "native", transparency } as const;
            assert.deepEqual(getWindowChrome(settings, "darwin"), {
                windowStyle: "native",
                transparency,
                usesOverlayChrome: true,
                frame: false,
            });
        }
        assert.deepEqual(
            getWindowChrome({ mobileMode: false, windowStyle: "native", transparency: "none" }, "darwin"),
            { windowStyle: "native", transparency: "none", usesOverlayChrome: false, frame: true },
        );
    });

    it("retains desktop custom and legacy titlebar choices", () => {
        for (const platform of platforms) {
            for (const windowStyle of ["default", "overlay"] as const) {
                assert.deepEqual(getWindowChrome({ mobileMode: false, windowStyle, transparency: "none" }, platform), {
                    windowStyle,
                    transparency: "none",
                    usesOverlayChrome: true,
                    frame: false,
                });
            }
            assert.deepEqual(
                getWindowChrome({ mobileMode: false, windowStyle: "legacy", transparency: "none" }, platform),
                { windowStyle: "legacy", transparency: "none", usesOverlayChrome: false, frame: false },
            );
        }
    });
});
