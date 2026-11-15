import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { normalizeAllowedDomains } from "./externalUrlPolicy.js";
import { freezeManagedValue, validManagedSettings } from "./managedSettingsSchema.js";

export const MANAGED_EXTERNAL_URL_POLICY_DIRECTORY = "/etc/legcord";
export const MANAGED_EXTERNAL_URL_POLICY_PATH = "/etc/legcord/policy.json";
export const MAX_MANAGED_POLICY_BYTES = 64 * 1024;

export interface ManagedExternalUrlPolicy {
    readonly managed: boolean;
    readonly enabled: boolean;
    readonly domains: readonly string[];
    readonly invalid: boolean;
}

export interface ManagedSettingsPolicy {
    readonly managed: boolean;
    readonly invalid: boolean;
    readonly settings: Readonly<Record<string, unknown>>;
    readonly language: string;
}

interface ManagedPolicies {
    readonly external: ManagedExternalUrlPolicy;
    readonly settings: ManagedSettingsPolicy;
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
const unmanagedSettings: ManagedSettingsPolicy = Object.freeze({
    managed: false,
    invalid: false,
    settings: Object.freeze({}),
    language: "en-US",
});
const invalidSettings: ManagedSettingsPolicy = Object.freeze({
    managed: true,
    invalid: true,
    settings: Object.freeze({}),
    language: "en-US",
});
const invalidPolicies: ManagedPolicies = Object.freeze({ external: invalidPolicy, settings: invalidSettings });
const unmanagedPolicies: ManagedPolicies = Object.freeze({ external: unmanagedPolicy, settings: unmanagedSettings });

/** Invalid administrator documents never grant the user control or partial hosts. */
function parseManagedPolicies(document: unknown): ManagedPolicies {
    if (!document || typeof document !== "object" || Array.isArray(document)) return invalidPolicies;
    const value = document as Record<string, unknown>;
    const keys = Object.keys(value);
    const allSettings = value.version === 2;
    const allowedKeys = [
        "version",
        "externalUrlAllowlistEnabled",
        "externalUrlAllowlist",
        ...(allSettings ? ["settings", "language"] : []),
    ];
    if (
        (!allSettings && value.version !== 1) ||
        (allSettings ? !validManagedSettings(value.settings) : keys.length !== 3) ||
        (allSettings &&
            value.language !== undefined &&
            (typeof value.language !== "string" || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value.language))) ||
        typeof value.externalUrlAllowlistEnabled !== "boolean" ||
        !Array.isArray(value.externalUrlAllowlist) ||
        value.externalUrlAllowlist.length > 256 ||
        !keys.every((key) => allowedKeys.includes(key)) ||
        !value.externalUrlAllowlist.every((entry) => normalizeAllowedDomains([entry]).length === 1)
    ) {
        return invalidPolicies;
    }
    return Object.freeze({
        external: Object.freeze({
            managed: true,
            enabled: value.externalUrlAllowlistEnabled,
            domains: Object.freeze(normalizeAllowedDomains(value.externalUrlAllowlist)),
            invalid: false,
        }),
        settings: allSettings
            ? Object.freeze({
                  managed: true,
                  invalid: false,
                  settings: freezeManagedValue(structuredClone(value.settings as Record<string, unknown>)),
                  language: typeof value.language === "string" ? value.language : "en-US",
              })
            : unmanagedSettings,
    });
}

export function parseManagedExternalUrlPolicy(document: unknown): ManagedExternalUrlPolicy {
    return parseManagedPolicies(document).external;
}

export function parseManagedSettingsPolicy(document: unknown): ManagedSettingsPolicy {
    return parseManagedPolicies(document).settings;
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
function readManagedPolicies(fileSystem: ManagedPolicyFileSystem, platform: string): ManagedPolicies {
    if (platform !== "linux") return unmanagedPolicies;
    let fd: number | undefined;
    try {
        const etc = fileSystem.lstat("/etc");
        if (!trustedOwnerAndMode(etc) || !etc.isDirectory()) return invalidPolicies;
        let directory: PolicyFileInfo;
        try {
            directory = fileSystem.lstat(MANAGED_EXTERNAL_URL_POLICY_DIRECTORY);
        } catch (error) {
            return isMissing(error) ? unmanagedPolicies : invalidPolicies;
        }
        if (!trustedOwnerAndMode(directory) || !directory.isDirectory()) return invalidPolicies;
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
            return invalidPolicies;
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
        if (length > MAX_MANAGED_POLICY_BYTES) return invalidPolicies;
        const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
        return parseManagedPolicies(JSON.parse(text));
    } catch {
        return invalidPolicies;
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

export function readManagedExternalUrlPolicy(
    fileSystem: ManagedPolicyFileSystem,
    platform: string,
): ManagedExternalUrlPolicy {
    return readManagedPolicies(fileSystem, platform).external;
}

export function readManagedSettingsPolicy(
    fileSystem: ManagedPolicyFileSystem,
    platform: string,
): ManagedSettingsPolicy {
    return readManagedPolicies(fileSystem, platform).settings;
}

let cachedPolicies: ManagedPolicies | undefined;

function getManagedPolicies(): ManagedPolicies {
    if (!cachedPolicies) {
        cachedPolicies = readManagedPolicies(systemFileSystem, process.platform);
        if (cachedPolicies.external.invalid) {
            console.warn(
                "[Managed policy] Invalid or unavailable system policy; settings and external embeds remain blocked.",
            );
        }
    }
    return cachedPolicies;
}

/** One immutable system-policy snapshot per process; administrator edits need restart. */
export function getManagedExternalUrlPolicy(): ManagedExternalUrlPolicy {
    return getManagedPolicies().external;
}

export function getManagedSettingsPolicy(): ManagedSettingsPolicy {
    return getManagedPolicies().settings;
}
