import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("parent-managed settings runtime boundaries", () => {
    it("ships the pinned official Shelter build and its recorded license without local modifications", () => {
        const provenance = JSON.parse(readFileSync("assets/vendor/shelter.provenance.json", "utf8"));
        assert.equal(provenance.build_commit, "fcc9143b026a3d74c6268b1f0f5111aae22af669");
        assert.equal(provenance.source_commit, "6d42725f7ad21df5807789e852ca8c0f8c6eb61f");
        assert.equal(provenance.license, "CC0-1.0");
        for (const file of ["shelter.js", "shelter.LICENSE"]) {
            const bytes = readFileSync(`assets/vendor/${file}`);
            assert.equal(bytes.length, provenance.files[file].bytes);
            assert.equal(createHash("sha256").update(bytes).digest("hex"), provenance.files[file].sha256);
        }
        assert.equal(
            provenance.files["shelter.js"].sha256,
            "ba858e9cfb83503fdf307369eb62ebd458573d355575441eac913290da4809e2",
        );
    });
    for (const mode of ["managed", "unmanaged"]) {
        it(`${mode}: gates actual editor, script, language, extension, plugin and theme behavior`, () => {
            const result = spawnSync(
                process.execPath,
                [
                    "--experimental-strip-types",
                    "--import",
                    "./tests/register-ts.mjs",
                    "./tests/support/managed-runtime-fixture.mjs",
                    mode,
                ],
                { encoding: "utf8", timeout: 15_000 },
            );
            assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
            assert.match(result.stdout, /"ok":true/);
        });
    }
});
