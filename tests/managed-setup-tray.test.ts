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
            "tests/support/managed-setup-tray-fixture.mjs",
            mode,
        ],
        { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /"ok":true/);
}

describe("parent-managed setup tray", () => {
    it("quits without deleting the daily settings profile under management", () => runFixture("managed"));
    it("preserves cleanup when quitting ordinary unmanaged onboarding", () => runFixture("unmanaged"));
});
