import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Display } from "electron";
import { getMinWindowWidth, sanitizeWindowBounds } from "../src/common/windowBounds.ts";

function phoneDisplay(width: number): Display {
    const size = { width, height: 800 };
    const bounds = { x: 0, y: 0, ...size };
    return {
        id: 1,
        bounds,
        workArea: bounds,
        size,
        workAreaSize: size,
        scaleFactor: 2,
        rotation: 0,
        internal: true,
        detected: true,
        label: "Phone",
        touchSupport: "available",
        accelerometerSupport: "available",
        colorDepth: 24,
        colorSpace: "srgb",
        depthPerComponent: 8,
        displayFrequency: 60,
        monochrome: false,
        maximumCursorSize: { width: 64, height: 64 },
        nativeOrigin: { x: 0, y: 0 },
    };
}

describe("mobile window bounds", () => {
    it("fits a saved desktop window onto narrow phone displays", () => {
        for (const width of [320, 360, 390]) {
            const display = phoneDisplay(width);
            const result = sanitizeWindowBounds(
                { width: 835, height: 600, x: 1000, y: 1000 },
                [display],
                getMinWindowWidth(true),
            );
            assert.equal(result.width, width);
            assert.equal(result.x, 0);
            assert.ok(result.y >= 0);
            assert.ok(result.y + result.height <= display.workArea.height);
            assert.equal(result.displayScaleFactor, 2);
        }
    });

    it("preserves narrow mobile bounds through saving and restoration", () => {
        const displays = [phoneDisplay(360)];
        const saved = sanitizeWindowBounds(
            { width: 344, height: 700, x: 8, y: 50, displayId: 1 },
            displays,
            getMinWindowWidth(true),
        );
        const restored = sanitizeWindowBounds(saved, displays, getMinWindowWidth(true));
        assert.equal(restored.width, 344);
        assert.equal(restored.x, 8);
        assert.deepEqual(restored, saved);
    });

    it("retains the desktop minimum when mobile mode is off", () => {
        assert.equal(getMinWindowWidth(false), 400);
        const input = { width: 344, height: 700, x: 8, y: 50 };
        const displays = [phoneDisplay(360)];
        const desktop = sanitizeWindowBounds(input, displays, getMinWindowWidth(false));
        assert.equal(desktop.width, 400);
        assert.deepEqual(sanitizeWindowBounds(input, displays), desktop);
    });
});
