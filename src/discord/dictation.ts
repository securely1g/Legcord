import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";

export const DICTATION_MAX_BYTES = 8 * 1024 * 1024;
export const DICTATION_MAX_SECONDS = 60;
const FFMPEG = "/usr/bin/ffmpeg";
const WHISPER = "/usr/bin/whisper-cli";

type ErrorCode =
    | "INVALID_SENDER"
    | "INVALID_AUDIO"
    | "BUSY"
    | "CANCELLED"
    | "TIMEOUT"
    | "UNAVAILABLE"
    | "TRANSCRIPTION_FAILED"
    | "NO_SPEECH";
type Failure = { ok: false; error: ErrorCode; message: string };
export type DictationResult = { ok: true; text: string } | Failure;
export type DictationStatus = { ok: true; available: true; maxDurationSeconds: number; maxBytes: number } | Failure;

const messages: Record<ErrorCode, string> = {
    INVALID_SENDER: "Dictation is only available in the main Discord window.",
    INVALID_AUDIO: "The recording is empty, too large, or not supported.",
    BUSY: "A recording is already being transcribed.",
    CANCELLED: "Dictation cancelled.",
    TIMEOUT: "Transcription took too long. Try a shorter recording.",
    UNAVAILABLE: "Local dictation needs whisper-cli, ffmpeg, and the base speech model installed.",
    TRANSCRIPTION_FAILED: "The recording could not be transcribed. Please try again.",
    NO_SPEECH: "No speech was detected. Please check your microphone and try again.",
};

function failure(error: ErrorCode): Failure {
    return { ok: false, error, message: messages[error] };
}

class DictationError extends Error {
    readonly code: ErrorCode;

    constructor(code: ErrorCode) {
        super(code);
        this.code = code;
    }
}

/** Audio data is the only renderer-controlled input; paths and process arguments stay in main. */
export function validateDictationAudio(value: unknown): value is ArrayBuffer {
    if (!(value instanceof ArrayBuffer) || value.byteLength < 4 || value.byteLength > DICTATION_MAX_BYTES) {
        return false;
    }
    const header = new Uint8Array(value, 0, 4);
    return header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3;
}

/** Reject silence/near-silence before Whisper; this is an energy check, not speech recognition. */
export function hasAudibleDictationPcm(wav: Buffer): boolean {
    if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
        return false;
    }
    let validFormat = false;
    for (let offset = 12; offset + 8 <= wav.length; ) {
        const kind = wav.toString("ascii", offset, offset + 4);
        const size = wav.readUInt32LE(offset + 4);
        const start = offset + 8;
        if (start + size > wav.length) return false;
        if (kind === "fmt ") {
            validFormat =
                size >= 16 &&
                wav.readUInt16LE(start) === 1 &&
                wav.readUInt16LE(start + 2) === 1 &&
                wav.readUInt32LE(start + 4) === 16_000 &&
                wav.readUInt16LE(start + 14) === 16;
        } else if (kind === "data") {
            if (!validFormat || size % 2 !== 0) return false;
            // Require at least 100ms above -60dB across 20ms windows. Subtract DC offset
            // so a stuck microphone or a brief pop cannot qualify as a recording.
            let audibleWindows = 0;
            for (let position = start; position + 640 <= start + size; position += 640) {
                let sum = 0;
                let squares = 0;
                for (let sample = position; sample < position + 640; sample += 2) {
                    const value = wav.readInt16LE(sample) / 32768;
                    sum += value;
                    squares += value * value;
                }
                const energy = squares / 320 - (sum / 320) ** 2;
                if (energy > 0.001 ** 2 && ++audibleWindows >= 5) return true;
            }
            return false;
        }
        offset = start + size + (size % 2);
    }
    return false;
}

export function isDictationSender(
    event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">,
    contents: BrowserWindow["webContents"],
): boolean {
    if (contents.isDestroyed() || event.sender !== contents || event.senderFrame !== contents.mainFrame) {
        return false;
    }
    try {
        const url = new URL(event.senderFrame.url);
        return (
            url.protocol === "https:" &&
            !url.port &&
            !url.username &&
            !url.password &&
            ["discord.com", "ptb.discord.com", "canary.discord.com"].includes(url.hostname)
        );
    } catch {
        return false;
    }
}

export type DictationProcessRunner = (
    executable: string,
    args: readonly string[],
    signal: AbortSignal,
) => Promise<void>;

/** Wait for close even after cancellation, so private files cannot outlive a running decoder. */
export const runDictationProcess: DictationProcessRunner = (executable, args, signal) =>
    new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(new Error("cancelled"));
            return;
        }
        const child = spawn(executable, args, { stdio: "ignore", shell: false });
        let killTimer: NodeJS.Timeout | undefined;
        const stop = () => {
            child.kill("SIGTERM");
            killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
            killTimer.unref();
        };
        const cleanup = () => {
            signal.removeEventListener("abort", stop);
            clearTimeout(killTimer);
        };
        signal.addEventListener("abort", stop, { once: true });
        child.once("error", () => {
            cleanup();
            reject(new Error("process unavailable"));
        });
        child.once("close", (code) => {
            cleanup();
            if (signal.aborted || code !== 0) reject(new Error("process failed"));
            else resolve();
        });
        if (signal.aborted) stop();
    });

interface DictationOptions {
    runProcess?: DictationProcessRunner;
    available?: () => Promise<boolean>;
    timeoutMs?: number;
    temporaryRoot?: string;
}

/** One service instance is registered for the main window, bounding CPU use to one job. */
export class DictationService {
    private active: { controller: AbortController; timedOut: boolean } | undefined;
    private readonly model: string;
    private readonly runProcess: DictationProcessRunner;
    private readonly available: () => Promise<boolean>;
    private readonly timeoutMs: number;
    private readonly temporaryRoot: string;

    constructor(userData: string, options: DictationOptions = {}) {
        this.model = path.join(userData, "speech", "ggml-base.bin");
        this.runProcess = options.runProcess ?? runDictationProcess;
        this.timeoutMs = options.timeoutMs ?? 90_000;
        this.temporaryRoot = options.temporaryRoot ?? tmpdir();
        this.available =
            options.available ??
            (async () => {
                if (process.platform !== "linux") return false;
                try {
                    await Promise.all([
                        access(FFMPEG, constants.X_OK),
                        access(WHISPER, constants.X_OK),
                        access(this.model, constants.R_OK),
                    ]);
                    return (await stat(this.model)).isFile();
                } catch {
                    return false;
                }
            });
    }

    async status(): Promise<DictationStatus> {
        if (!(await this.available())) return failure("UNAVAILABLE");
        return {
            ok: true,
            available: true,
            maxDurationSeconds: DICTATION_MAX_SECONDS,
            maxBytes: DICTATION_MAX_BYTES,
        };
    }

    cancel(): void {
        this.active?.controller.abort();
    }

    async transcribe(audio: unknown): Promise<DictationResult> {
        if (!validateDictationAudio(audio)) return failure("INVALID_AUDIO");
        if (this.active) return failure("BUSY");
        const job = { controller: new AbortController(), timedOut: false };
        this.active = job;
        const { signal } = job.controller;
        const timer = setTimeout(() => {
            job.timedOut = true;
            job.controller.abort();
        }, this.timeoutMs);
        let directory: string | undefined;
        let result: DictationResult = failure("TRANSCRIPTION_FAILED");
        const checkCancelled = () => {
            if (signal.aborted) throw new Error("cancelled");
        };
        try {
            if (!(await this.available())) throw new DictationError("UNAVAILABLE");
            checkCancelled();
            directory = await mkdtemp(path.join(this.temporaryRoot, "legcord-dictation-"));
            await chmod(directory, 0o700);
            const input = path.join(directory, "recording.webm");
            const wav = path.join(directory, "recording.wav");
            const output = path.join(directory, "transcript");
            await writeFile(input, Buffer.from(audio), { mode: 0o600 });
            checkCancelled();
            await this.runProcess(
                FFMPEG,
                [
                    "-nostdin",
                    "-v",
                    "error",
                    "-protocol_whitelist",
                    "file,pipe",
                    "-f",
                    "matroska",
                    "-i",
                    input,
                    "-t",
                    String(DICTATION_MAX_SECONDS),
                    "-map_metadata",
                    "-1",
                    "-vn",
                    "-ac",
                    "1",
                    "-ar",
                    "16000",
                    "-c:a",
                    "pcm_s16le",
                    wav,
                ],
                signal,
            );
            checkCancelled();
            if ((await stat(wav)).size > DICTATION_MAX_SECONDS * 16_000 * 2 + 65_536) {
                throw new DictationError("INVALID_AUDIO");
            }
            if (!hasAudibleDictationPcm(await readFile(wav))) throw new DictationError("NO_SPEECH");
            checkCancelled();
            await this.runProcess(
                WHISPER,
                [
                    "-m",
                    this.model,
                    "-f",
                    wav,
                    "-l",
                    "auto",
                    "-t",
                    "4",
                    "-ng",
                    "-nt",
                    "-np",
                    "-nf",
                    "-sns",
                    "-otxt",
                    "-of",
                    output,
                ],
                signal,
            );
            checkCancelled();
            const resultFile = `${output}.txt`;
            if ((await stat(resultFile)).size > 64 * 1024) throw new DictationError("TRANSCRIPTION_FAILED");
            const text = (await readFile(resultFile, "utf8")).trim();
            checkCancelled();
            if (!text) throw new DictationError("NO_SPEECH");
            result = { ok: true, text };
        } catch (error) {
            result = failure(error instanceof DictationError ? error.code : "TRANSCRIPTION_FAILED");
        } finally {
            clearTimeout(timer);
            try {
                if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 3 });
            } catch {
                result = failure("TRANSCRIPTION_FAILED");
            } finally {
                if (this.active === job) this.active = undefined;
            }
        }
        if (job.timedOut) return failure("TIMEOUT");
        if (signal.aborted) return failure("CANCELLED");
        return result;
    }
}

export function registerDictationIpc(ipc: IpcMain, window: BrowserWindow, userData: string): void {
    const service = new DictationService(userData);
    const valid = (event: IpcMainInvokeEvent) => isDictationSender(event, window.webContents);
    ipc.handle("dictation-status", (event) => (valid(event) ? service.status() : failure("INVALID_SENDER")));
    ipc.handle("dictation-transcribe", (event, audio: unknown) =>
        valid(event) ? service.transcribe(audio) : failure("INVALID_SENDER"),
    );
    ipc.handle("dictation-cancel", (event) => {
        if (!valid(event)) return failure("INVALID_SENDER");
        service.cancel();
        return { ok: true };
    });
    window.webContents.on("destroyed", () => service.cancel());
    window.webContents.on("render-process-gone", () => service.cancel());
    window.webContents.on("did-start-navigation", (details) => {
        if (details.isMainFrame && !details.isSameDocument) service.cancel();
    });
}
