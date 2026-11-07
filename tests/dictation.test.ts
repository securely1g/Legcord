import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import {
    DICTATION_MAX_BYTES,
    type DictationProcessRunner,
    DictationService,
    hasAudibleDictationPcm,
    isDictationSender,
    runDictationProcess,
    validateDictationAudio,
} from "../src/discord/dictation.ts";

function audio(size = 8): ArrayBuffer {
    const bytes = new Uint8Array(size);
    bytes.set([0x1a, 0x45, 0xdf, 0xa3]);
    return bytes.buffer;
}

function pcmWav(sample: (index: number) => number = (index) => Math.sin(index / 7) * 3000): Buffer {
    // Include odd-sized JUNK with padding, like the metadata chunks ffmpeg may emit.
    const count = 8000;
    const wav = Buffer.alloc(54 + count * 2);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write("WAVEJUNK", 8);
    wav.writeUInt32LE(1, 16);
    wav.write("fmt ", 22);
    wav.writeUInt32LE(16, 26);
    wav.writeUInt16LE(1, 30);
    wav.writeUInt16LE(1, 32);
    wav.writeUInt32LE(16000, 34);
    wav.writeUInt32LE(32000, 38);
    wav.writeUInt16LE(2, 42);
    wav.writeUInt16LE(16, 44);
    wav.write("data", 46);
    wav.writeUInt32LE(count * 2, 50);
    for (let index = 0; index < count; index++) wav.writeInt16LE(Math.round(sample(index)), 54 + index * 2);
    return wav;
}

async function temporaryTest(run: (directory: string) => Promise<void>) {
    const directory = await mkdtemp(path.join(tmpdir(), "legcord-dictation-test-"));
    try {
        await run(directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

describe("dictation boundaries", () => {
    it("recognizes decoded PCM chunks while rejecting silence, near-silence, DC offset and isolated clicks", () => {
        assert.equal(hasAudibleDictationPcm(pcmWav()), true);
        assert.equal(hasAudibleDictationPcm(pcmWav(() => 0)), false);
        assert.equal(hasAudibleDictationPcm(pcmWav((index) => Math.sin(index / 7) * 8)), false);
        assert.equal(hasAudibleDictationPcm(pcmWav(() => 1000)), false);
        assert.equal(hasAudibleDictationPcm(pcmWav((index) => (index === 1000 ? 32000 : 0))), false);
        const truncated = pcmWav().subarray(0, 64);
        assert.equal(hasAudibleDictationPcm(truncated), false);
        const stereo = pcmWav();
        stereo.writeUInt16LE(2, 32);
        assert.equal(hasAudibleDictationPcm(stereo), false);
    });

    it("accepts bounded WebM bytes and rejects commands, arbitrary views, empty and oversized data", () => {
        for (const value of [
            null,
            "$(touch /tmp/unsafe)",
            { path: "/etc/passwd" },
            new Uint8Array(8),
            new ArrayBuffer(0),
            new ArrayBuffer(8),
        ]) {
            assert.equal(validateDictationAudio(value), false);
        }
        assert.equal(validateDictationAudio(audio()), true);
        assert.equal(validateDictationAudio(audio(DICTATION_MAX_BYTES)), true);
        assert.equal(validateDictationAudio(audio(DICTATION_MAX_BYTES + 1)), false);
    });

    it("accepts only the owning main frame on exact HTTPS Discord origins", () => {
        const frame = { url: "https://discord.com/channels/@me" };
        const contents = { isDestroyed: () => false, mainFrame: frame } as unknown as BrowserWindow["webContents"];
        const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
        for (const host of ["discord.com", "ptb.discord.com", "canary.discord.com"]) {
            frame.url = `https://${host}/channels/@me`;
            assert.equal(isDictationSender(event, contents), true);
        }
        for (const url of [
            "http://discord.com/",
            "https://discord.com.evil.test/",
            "https://evil.discord.com/",
            "https://discord.com:444/",
            "https://name@discord.com/",
            "file:///discord.com",
            "invalid",
        ]) {
            frame.url = url;
            assert.equal(isDictationSender(event, contents), false, url);
        }
        frame.url = "https://discord.com/channels/@me";
        assert.equal(
            isDictationSender({ ...event, senderFrame: { url: frame.url } } as IpcMainInvokeEvent, contents),
            false,
        );
        assert.equal(isDictationSender({ ...event, sender: {} } as IpcMainInvokeEvent, contents), false);
        assert.equal(isDictationSender({ ...event, senderFrame: null } as IpcMainInvokeEvent, contents), false);
    });
});

describe("local dictation lifecycle", () => {
    it("uses fixed decoders and private files, returns multilingual text, and removes audio/transcript", async () => {
        await temporaryTest(async (directory) => {
            const calls: { executable: string; args: readonly string[] }[] = [];
            const runProcess: DictationProcessRunner = async (executable, args) => {
                calls.push({ executable, args });
                const folders = await readdir(directory);
                assert.equal(folders.length, 1);
                const work = path.join(directory, folders[0]);
                assert.equal((await stat(work)).mode & 0o777, 0o700);
                assert.equal((await stat(path.join(work, "recording.webm"))).mode & 0o777, 0o600);
                if (executable.endsWith("whisper-cli")) {
                    const output = args[args.indexOf("-of") + 1];
                    await writeFile(`${output}.txt`, "  Hello. 你好。\n", "utf8");
                } else {
                    await writeFile(args.at(-1) as string, pcmWav());
                }
            };
            const service = new DictationService("/trusted/profile", {
                temporaryRoot: directory,
                available: async () => true,
                runProcess,
            });
            assert.deepEqual(await service.transcribe(audio()), { ok: true, text: "Hello. 你好。" });
            assert.equal(calls[0].executable, "/usr/bin/ffmpeg");
            assert.equal(calls[0].args[calls[0].args.indexOf("-f") + 1], "matroska");
            assert.equal(calls[0].args[calls[0].args.indexOf("-t") + 1], "60");
            assert.equal(calls[1].executable, "/usr/bin/whisper-cli");
            assert.equal(calls[1].args[calls[1].args.indexOf("-m") + 1], "/trusted/profile/speech/ggml-base.bin");
            assert.equal(calls[1].args[calls[1].args.indexOf("-l") + 1], "auto");
            assert.deepEqual(await readdir(directory), []);
        });
    });

    it("reserves the single job before asynchronous setup and cancels without running a decoder", async () => {
        let finishAvailability: (value: boolean) => void = () => {};
        let calls = 0;
        const service = new DictationService("/trusted/profile", {
            available: () =>
                new Promise((resolve) => {
                    finishAvailability = resolve;
                }),
            runProcess: async () => {
                calls += 1;
            },
        });
        const first = service.transcribe(audio());
        const second = await service.transcribe(audio());
        assert.equal(second.ok, false);
        if (!second.ok) assert.equal(second.error, "BUSY");
        service.cancel();
        finishAvailability(true);
        const result = await first;
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error, "CANCELLED");
        assert.equal(calls, 0);
    });

    for (const reason of ["cancel", "timeout"] as const) {
        it(`${reason} aborts the running decoder, prevents Whisper launch, and cleans up`, async () => {
            await temporaryTest(async (directory) => {
                let started: () => void = () => {};
                const ready = new Promise<void>((resolve) => {
                    started = resolve;
                });
                let runs = 0;
                const service = new DictationService("/trusted/profile", {
                    temporaryRoot: directory,
                    timeoutMs: reason === "timeout" ? 25 : 5000,
                    available: async () => true,
                    runProcess: async (_executable, _args, signal) => {
                        runs += 1;
                        await new Promise<void>((_resolve, reject) => {
                            signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
                            started();
                        });
                    },
                });
                const pending = service.transcribe(audio());
                await ready;
                if (reason === "cancel") service.cancel();
                const result = await pending;
                assert.equal(result.ok, false);
                if (!result.ok) assert.equal(result.error, reason === "cancel" ? "CANCELLED" : "TIMEOUT");
                assert.equal(runs, 1);
                assert.deepEqual(await readdir(directory), []);
            });
        });
    }

    it("redacts decoder failures and releases the job for retry", async () => {
        await temporaryTest(async (directory) => {
            let runs = 0;
            const service = new DictationService("/trusted/profile", {
                temporaryRoot: directory,
                available: async () => true,
                runProcess: async () => {
                    runs += 1;
                    throw new Error("private recording and /secret/path");
                },
            });
            const result = await service.transcribe(audio());
            assert.equal(result.ok, false);
            if (!result.ok) assert.equal(result.error, "TRANSCRIPTION_FAILED");
            assert.equal(JSON.stringify(result).includes("secret"), false);
            await service.transcribe(audio());
            assert.equal(runs, 2);
            assert.deepEqual(await readdir(directory), []);
        });
    });

    it("rejects silent recordings before launching Whisper and rejects empty transcripts", async () => {
        await temporaryTest(async (directory) => {
            let silent = true;
            let whisperRuns = 0;
            const service = new DictationService("/trusted/profile", {
                temporaryRoot: directory,
                available: async () => true,
                runProcess: async (executable, args) => {
                    if (executable.endsWith("ffmpeg")) {
                        await writeFile(args.at(-1) as string, silent ? pcmWav(() => 0) : pcmWav());
                    } else {
                        whisperRuns += 1;
                        await writeFile(`${args[args.indexOf("-of") + 1]}.txt`, "  \n");
                    }
                },
            });
            const silence = await service.transcribe(audio());
            assert.equal(silence.ok, false);
            if (!silence.ok) assert.equal(silence.error, "NO_SPEECH");
            assert.equal(whisperRuns, 0);
            silent = false;
            const empty = await service.transcribe(audio());
            assert.equal(empty.ok, false);
            if (!empty.ok) assert.equal(empty.error, "NO_SPEECH");
            assert.equal(whisperRuns, 1);
            assert.deepEqual(await readdir(directory), []);
        });
    });

    it("reports missing installation before writing a recording", async () => {
        const service = new DictationService("/trusted/profile", { available: async () => false });
        const status = await service.status();
        assert.equal(status.ok, false);
        if (!status.ok) assert.equal(status.error, "UNAVAILABLE");
        const result = await service.transcribe(audio());
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error, "UNAVAILABLE");
    });

    it("does not launch a subprocess when already cancelled", async () => {
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(runDictationProcess("/not-an-executable", [], controller.signal), /cancelled/);
    });

    it("reaps a cancelled decoder even when it ignores graceful termination", { timeout: 5000 }, async () => {
        await temporaryTest(async (directory) => {
            const marker = path.join(directory, "child-ready");
            const controller = new AbortController();
            const pending = runDictationProcess(
                process.execPath,
                [
                    "--input-type=module",
                    "-e",
                    'import { writeFileSync } from "node:fs"; process.on("SIGTERM", () => {}); writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);',
                    marker,
                ],
                controller.signal,
            );
            const stopped = assert.rejects(pending, /process failed/);
            let pid: number | undefined;
            try {
                for (let attempt = 0; attempt < 200; attempt++) {
                    try {
                        pid = Number(await readFile(marker, "utf8"));
                        break;
                    } catch {
                        await new Promise((resolve) => setTimeout(resolve, 5));
                    }
                }
                assert.ok(pid);
            } finally {
                controller.abort();
                await stopped;
            }
            assert.throws(() => process.kill(pid as number, 0), { code: "ESRCH" });
        });
    });
});
