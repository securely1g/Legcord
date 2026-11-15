import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { describe, it } from "node:test";
import {
    getManagedExternalUrlPolicy,
    MANAGED_EXTERNAL_URL_POLICY_DIRECTORY,
    MANAGED_EXTERNAL_URL_POLICY_PATH,
    MAX_MANAGED_POLICY_BYTES,
    type ManagedPolicyFileSystem,
    parseManagedExternalUrlPolicy,
    readManagedExternalUrlPolicy,
} from "../src/common/managedExternalUrlPolicy.ts";

const document = { version: 1, externalUrlAllowlistEnabled: true, externalUrlAllowlist: [] };
const strict = { managed: true, enabled: true, domains: [], invalid: true };

function info(kind: "directory" | "file" | "symlink" | "fifo", uid = 0, mode = 0o755, size = 0) {
    return {
        uid,
        mode,
        size,
        isDirectory: () => kind === "directory",
        isFile: () => kind === "file",
        isSymbolicLink: () => kind === "symlink",
    };
}

function failure(code: string): Error & { code: string } {
    return Object.assign(new Error(code), { code });
}

function fixture(
    overrides: Partial<ManagedPolicyFileSystem> = {},
    content = new TextEncoder().encode(JSON.stringify(document)),
) {
    const calls: string[] = [];
    const closed: number[] = [];
    let bytesRead = 0;
    const fs: ManagedPolicyFileSystem = {
        lstat(path) {
            calls.push(path);
            assert.ok(path === "/etc" || path === MANAGED_EXTERNAL_URL_POLICY_DIRECTORY);
            return info("directory");
        },
        open(path, flags) {
            calls.push(path);
            assert.equal(path, MANAGED_EXTERNAL_URL_POLICY_PATH);
            assert.equal(flags & constants.O_NOFOLLOW, constants.O_NOFOLLOW);
            assert.equal(flags & constants.O_NONBLOCK, constants.O_NONBLOCK);
            return 42;
        },
        fstat(fd) {
            assert.equal(fd, 42);
            return info("file", 0, 0o644, content.length);
        },
        read(fd, buffer, offset, length, position) {
            assert.equal(fd, 42);
            // Partial reads exercise the descriptor loop instead of a pathname reread.
            const count = Math.min(7, length, content.length - position);
            buffer.set(content.subarray(position, position + count), offset);
            bytesRead += count;
            return count;
        },
        close(fd) {
            closed.push(fd);
        },
        ...overrides,
    };
    return { fs, calls, closed, bytesRead: () => bytesRead };
}

describe("managed external URL policy documents", () => {
    it("normalizes every valid host and permits explicit administrator enable/disable", () => {
        const policy = parseManagedExternalUrlPolicy({
            ...document,
            externalUrlAllowlistEnabled: false,
            externalUrlAllowlist: [" GitHub.COM ", "github.com", "bücher.example"],
        });
        assert.deepEqual(policy, {
            managed: true,
            enabled: false,
            domains: ["github.com", "xn--bcher-kva.example"],
            invalid: false,
        });
        assert.ok(Object.isFrozen(policy));
        assert.ok(Object.isFrozen(policy.domains));
        assert.throws(() => (policy.domains as string[]).push("evil.example"), TypeError);
    });

    it("rejects the entire policy for malformed values rather than partially allowing hosts", () => {
        for (const value of [
            null,
            [],
            "policy",
            {},
            { ...document, version: 2 },
            { ...document, externalUrlAllowlistEnabled: "false" },
            { ...document, externalUrlAllowlistEnabled: null },
            { ...document, extra: true },
            { version: 1, enabled: false, externalUrlAllowlist: [] },
            { ...document, externalUrlAllowlist: "github.com" },
            { ...document, externalUrlAllowlist: ["github.com", "https://youtube.com"] },
            { ...document, externalUrlAllowlist: ["github.com", false] },
            { ...document, externalUrlAllowlist: ["*.github.com"] },
            { ...document, externalUrlAllowlist: Array(257).fill("github.com") },
        ]) {
            assert.deepEqual(parseManagedExternalUrlPolicy(value), strict);
        }
    });
});

describe("managed policy filesystem boundary", () => {
    it("reads only fixed /etc locations through a checked descriptor and closes it", () => {
        const f = fixture();
        assert.deepEqual(readManagedExternalUrlPolicy(f.fs, "linux"), {
            managed: true,
            enabled: true,
            domains: [],
            invalid: false,
        });
        assert.deepEqual(f.calls, ["/etc", MANAGED_EXTERNAL_URL_POLICY_DIRECTORY, MANAGED_EXTERNAL_URL_POLICY_PATH]);
        assert.deepEqual(f.closed, [42]);
    });

    it("is unmanaged only when the trusted policy directory is absent", () => {
        const f = fixture({
            lstat(path) {
                if (path === MANAGED_EXTERNAL_URL_POLICY_DIRECTORY) throw failure("ENOENT");
                return info("directory");
            },
            open() {
                assert.fail("Must not open any policy when the directory is absent");
            },
        });
        assert.deepEqual(readManagedExternalUrlPolicy(f.fs, "linux"), {
            managed: false,
            enabled: true,
            domains: [],
            invalid: false,
        });
        assert.deepEqual(f.closed, []);
    });

    it("does not inspect Linux policy paths on other platforms", () => {
        const f = fixture({ lstat: () => assert.fail("Unexpected Linux path read") });
        assert.equal(readManagedExternalUrlPolicy(f.fs, "darwin").managed, false);
        assert.equal(readManagedExternalUrlPolicy(f.fs, "win32").managed, false);
    });

    it("fails closed for symlink, non-root, writable or inaccessible policy directories", () => {
        for (const badInfo of [
            info("symlink"),
            info("file"),
            info("directory", 1000),
            info("directory", 0, 0o775),
            info("directory", 0, 0o757),
        ]) {
            for (const unsafePath of ["/etc", MANAGED_EXTERNAL_URL_POLICY_DIRECTORY]) {
                const f = fixture({ lstat: (path) => (path === unsafePath ? badInfo : info("directory")) });
                assert.deepEqual(readManagedExternalUrlPolicy(f.fs, "linux"), strict);
                assert.deepEqual(f.closed, []);
            }
        }
        const f = fixture({
            lstat: () => {
                throw failure("EACCES");
            },
        });
        assert.deepEqual(readManagedExternalUrlPolicy(f.fs, "linux"), strict);
    });

    it("retains managed mode when its file is missing, unreadable or a symlink", () => {
        for (const code of ["ENOENT", "EACCES", "ELOOP"]) {
            const f = fixture({
                open: () => {
                    throw failure(code);
                },
            });
            assert.deepEqual(readManagedExternalUrlPolicy(f.fs, "linux"), strict);
        }
    });

    it("rejects non-root, writable or non-regular files and still closes their descriptor", () => {
        for (const metadata of [
            info("file", 1000, 0o644),
            info("file", 0, 0o664),
            info("file", 0, 0o646),
            info("directory"),
            info("fifo"),
            info("symlink"),
            info("file", 0, 0o644, -1),
            info("file", 0, 0o644, Number.POSITIVE_INFINITY),
        ]) {
            const f = fixture({ fstat: () => metadata });
            assert.deepEqual(readManagedExternalUrlPolicy(f.fs, "linux"), strict);
            assert.equal(f.bytesRead(), 0);
            assert.deepEqual(f.closed, [42]);
        }
    });

    it("bounds initial sizes and a file that grows after fstat", () => {
        const tooLarge = fixture({ fstat: () => info("file", 0, 0o644, MAX_MANAGED_POLICY_BYTES + 1) });
        assert.deepEqual(readManagedExternalUrlPolicy(tooLarge.fs, "linux"), strict);
        assert.equal(tooLarge.bytesRead(), 0);
        const grown = fixture({ fstat: () => info("file", 0, 0o644, 1) }, new Uint8Array(MAX_MANAGED_POLICY_BYTES * 2));
        assert.deepEqual(readManagedExternalUrlPolicy(grown.fs, "linux"), strict);
        assert.equal(grown.bytesRead(), MAX_MANAGED_POLICY_BYTES + 1);
    });

    it("rejects invalid JSON, invalid UTF-8, and read errors", () => {
        for (const content of [new TextEncoder().encode("{"), new Uint8Array([0xff])]) {
            const f = fixture({}, content);
            assert.deepEqual(readManagedExternalUrlPolicy(f.fs, "linux"), strict);
            assert.deepEqual(f.closed, [42]);
        }
        const f = fixture({
            read: () => {
                throw failure("EIO");
            },
        });
        assert.deepEqual(readManagedExternalUrlPolicy(f.fs, "linux"), strict);
        assert.deepEqual(f.closed, [42]);
    });

    it("returns the same immutable process snapshot on repeated production reads", () => {
        const first = getManagedExternalUrlPolicy();
        assert.equal(getManagedExternalUrlPolicy(), first);
        assert.ok(Object.isFrozen(first));
        assert.ok(Object.isFrozen(first.domains));
    });
});

describe("managed config integration", () => {
    for (const options of [
        { managed: true, enabled: true, domains: ["github.com"], invalid: false },
        { managed: true, enabled: false, domains: ["github.com"], invalid: false, safeMode: true },
        { managed: true, enabled: true, domains: [], invalid: true, missingProfile: true },
        { managed: false, enabled: true, domains: [], invalid: false },
    ]) {
        it(`guards reads, writes and migration: ${JSON.stringify(options)}`, () => {
            const child = spawnSync(
                process.execPath,
                [
                    "--experimental-strip-types",
                    "--import",
                    "./tests/register-ts.mjs",
                    "./tests/support/managed-config-fixture.mjs",
                    JSON.stringify(options),
                ],
                { cwd: process.cwd(), encoding: "utf8", timeout: 10000 },
            );
            assert.equal(child.status, 0, child.stderr || child.stdout);
        });
    }
});
