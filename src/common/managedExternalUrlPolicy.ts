import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { normalizeAllowedDomains } from "./externalUrlPolicy.js";

export const MANAGED_EXTERNAL_URL_POLICY_DIRECTORY = "/etc/legcord";
export const MANAGED_EXTERNAL_URL_POLICY_PATH = "/etc/legcord/policy.json";
export const MAX_MANAGED_POLICY_BYTES = 64 * 1024;

export interface ManagedExternalUrlPolicy {
    readonly managed: boolean;
    readonly enabled: boolean;
    readonly domains: readonly string[];
    readonly invalid: boolean;
}

interface PolicyFileInfo {
    uid: number;
    mode: number;
    size: number;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
}

/** Filesystem seam for isolated tests; production always uses the fixed /etc path. */
export interface ManagedPolicyFileSystem {
    lstat(path: string): PolicyFileInfo;
    open(path: string, flags: number): number;
    fstat(fd: number): PolicyFileInfo;
    read(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number;
    close(fd: number): void;
}

const systemFileSystem: ManagedPolicyFileSystem = {
    lstat: lstatSync,
    open: openSync,
    fstat: fstatSync,
    read: readSync,
    close: closeSync,
};

const unmanagedPolicy: ManagedExternalUrlPolicy = Object.freeze({
    managed: false,
    enabled: true,
    domains: Object.freeze([] as string[]),
    invalid: false,
});
const invalidPolicy: ManagedExternalUrlPolicy = Object.freeze({
    managed: true,
    enabled: true,
    domains: Object.freeze([] as string[]),
    invalid: true,
});

/** Invalid administrator documents never grant the user control or partial hosts. */
export function parseManagedExternalUrlPolicy(document: unknown): ManagedExternalUrlPolicy {
    if (!document || typeof document !== "object" || Array.isArray(document)) return invalidPolicy;
    const value = document as Record<string, unknown>;
    const keys = Object.keys(value);
    if (
        keys.length !== 3 ||
        value.version !== 1 ||
        typeof value.externalUrlAllowlistEnabled !== "boolean" ||
        !Array.isArray(value.externalUrlAllowlist) ||
        value.externalUrlAllowlist.length > 256 ||
        !keys.every((key) => ["version", "externalUrlAllowlistEnabled", "externalUrlAllowlist"].includes(key)) ||
        !value.externalUrlAllowlist.every((entry) => normalizeAllowedDomains([entry]).length === 1)
    ) {
        return invalidPolicy;
    }
    return Object.freeze({
        managed: true,
        enabled: value.externalUrlAllowlistEnabled,
        domains: Object.freeze(normalizeAllowedDomains(value.externalUrlAllowlist)),
        invalid: false,
    });
}

function trustedOwnerAndMode(info: PolicyFileInfo): boolean {
    return info.uid === 0 && (info.mode & 0o022) === 0 && !info.isSymbolicLink();
}

function isMissing(error: unknown): boolean {
    return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

/**
 * Only an absent trusted /etc/legcord directory means unmanaged. Once that
 * directory exists, a missing, unreadable or unsafe policy locks to an empty
 * allowlist. Neither profiles nor command-line/environment paths participate.
 */
export function readManagedExternalUrlPolicy(
    fileSystem: ManagedPolicyFileSystem,
    platform: string,
): ManagedExternalUrlPolicy {
    if (platform !== "linux") return unmanagedPolicy;
    let fd: number | undefined;
    try {
        const etc = fileSystem.lstat("/etc");
        if (!trustedOwnerAndMode(etc) || !etc.isDirectory()) return invalidPolicy;
        let directory: PolicyFileInfo;
        try {
            directory = fileSystem.lstat(MANAGED_EXTERNAL_URL_POLICY_DIRECTORY);
        } catch (error) {
            return isMissing(error) ? unmanagedPolicy : invalidPolicy;
        }
        if (!trustedOwnerAndMode(directory) || !directory.isDirectory()) return invalidPolicy;
        // NOFOLLOW refuses symlinks; NONBLOCK avoids a raced FIFO hanging startup.
        fd = fileSystem.open(
            MANAGED_EXTERNAL_URL_POLICY_PATH,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        const file = fileSystem.fstat(fd);
        if (
            !trustedOwnerAndMode(file) ||
            !file.isFile() ||
            !Number.isSafeInteger(file.size) ||
            file.size < 0 ||
            file.size > MAX_MANAGED_POLICY_BYTES
        ) {
            return invalidPolicy;
        }
        // Read through the descriptor we checked, bounded even if an admin is
        // concurrently replacing/growing the file. Decode UTF-8 without repair.
        const buffer = new Uint8Array(MAX_MANAGED_POLICY_BYTES + 1);
        let length = 0;
        while (length < buffer.length) {
            const count = fileSystem.read(fd, buffer, length, buffer.length - length, length);
            if (count === 0) break;
            length += count;
        }
        if (length > MAX_MANAGED_POLICY_BYTES) return invalidPolicy;
        const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
        return parseManagedExternalUrlPolicy(JSON.parse(text));
    } catch {
        return invalidPolicy;
    } finally {
        if (fd !== undefined) {
            try {
                fileSystem.close(fd);
            } catch {
                // Descriptor cleanup cannot make an already restrictive policy permissive.
            }
        }
    }
}

let cachedPolicy: ManagedExternalUrlPolicy | undefined;

/** One immutable system-policy snapshot per process; administrator edits need restart. */
export function getManagedExternalUrlPolicy(): ManagedExternalUrlPolicy {
    if (!cachedPolicy) {
        cachedPolicy = readManagedExternalUrlPolicy(systemFileSystem, process.platform);
        if (cachedPolicy.invalid) {
            console.warn("[Managed policy] Invalid or unavailable system policy; external embeds remain blocked.");
        }
    }
    return cachedPolicy;
}
