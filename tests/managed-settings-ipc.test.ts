import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

function runFixture(mode: string): void {
    const result = spawnSync(
        process.execPath,
        [
            "--experimental-strip-types",
            "--import",
            "./tests/register-ts.mjs",
            "tests/support/managed-settings-ipc-fixture.mjs",
            mode,
        ],
        { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /"ok":true/);
}

describe("parent-managed settings IPC", () => {
    it("rejects settings, editors, folders, themes, plugins and backups before side effects while preserving ordinary controls", () => {
        runFixture("managed");
    });
    it("preserves unmanaged controls and rejects writes or focusing an editor after management is enabled", () => {
        runFixture("unmanaged");
    });
});
