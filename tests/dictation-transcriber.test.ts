import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DictationTranscriber } from "../src/common/dictationTranscriber.ts";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

const audio = () => Promise.resolve(new ArrayBuffer(4));

describe("live dictation transcription scheduling", () => {
    it("drops preview snapshots while busy without reading or queueing them", async () => {
        const result = deferred<string>();
        let calls = 0;
        const transcriber = new DictationTranscriber(
            async () => {
                calls++;
                return result.promise;
            },
            async () => {},
        );
        const first = transcriber.tryTranscribe(audio);
        await Promise.resolve();
        assert.equal(calls, 1);
        assert.equal(
            transcriber.tryTranscribe(() => {
                throw new Error("A stale snapshot should never be read");
            }),
            undefined,
        );
        result.resolve("live preview");
        assert.equal(await first, "live preview");
        assert.equal(calls, 1);
        assert.equal(await transcriber.tryTranscribe(audio), "live preview");
        assert.equal(calls, 2);
    });

    it("waits for both decoding and cancellation before starting a final transcript", async () => {
        for (const firstToFinish of ["decoder", "cancellation"] as const) {
            const result = deferred<string>();
            const cancellation = deferred<void>();
            let cancellations = 0;
            const transcriber = new DictationTranscriber(
                () => result.promise,
                () => {
                    cancellations++;
                    return cancellation.promise;
                },
            );
            const preview = transcriber.tryTranscribe(audio);
            await Promise.resolve();
            const stopped = transcriber.cancelAndWait();
            void transcriber.cancelAndWait();
            await Promise.resolve();
            assert.equal(cancellations, 1);
            if (firstToFinish === "decoder") result.resolve("stale preview");
            else cancellation.resolve();
            await Promise.resolve();
            await Promise.resolve();
            assert.equal(transcriber.tryTranscribe(audio), undefined);
            result.resolve("stale preview");
            cancellation.resolve();
            assert.equal(await preview, undefined);
            await stopped;
            assert.equal(await transcriber.tryTranscribe(audio), "stale preview");
        }
    });

    it("cancels a pending audio snapshot before it can reach the decoder", async () => {
        const snapshot = deferred<ArrayBuffer>();
        let calls = 0;
        let cancellations = 0;
        const transcriber = new DictationTranscriber(
            async () => {
                calls++;
                return "text";
            },
            async () => {
                cancellations++;
            },
        );
        const preview = transcriber.tryTranscribe(() => snapshot.promise);
        const cancelled = transcriber.cancelAndWait();
        assert.equal(transcriber.tryTranscribe(audio), undefined);
        snapshot.resolve(new ArrayBuffer(4));
        assert.equal(await preview, undefined);
        await cancelled;
        assert.equal(calls, 0);
        assert.equal(cancellations, 0);
        assert.equal(await transcriber.tryTranscribe(audio), "text");
    });

    it("cannot send a late cancel when successful completion races with cancellation", async () => {
        const result = deferred<string>();
        const cancellation = deferred<void>();
        let cancellations = 0;
        const transcriber = new DictationTranscriber(
            () => result.promise,
            () => {
                cancellations++;
                return cancellation.promise;
            },
        );
        const preview = transcriber.tryTranscribe(audio);
        await Promise.resolve();
        let stopped: Promise<void> | undefined;
        const completionRace = result.promise.then(() => {
            stopped = transcriber.cancelAndWait();
        });
        result.resolve("completed preview");
        await completionRace;
        assert.equal(await preview, "completed preview");
        assert.equal(cancellations, 0);
        await stopped;
        assert.equal(await transcriber.tryTranscribe(audio), "completed preview");
    });

    it("releases the slot after a failed preview or failed cancellation", async () => {
        const result = deferred<string>();
        const transcriber = new DictationTranscriber(
            () => result.promise,
            async () => {
                throw new Error("Cancellation IPC unavailable");
            },
        );
        const preview = transcriber.tryTranscribe(audio);
        await Promise.resolve();
        const cancelled = transcriber.cancelAndWait();
        result.reject(new Error("Decoder unavailable"));
        await assert.rejects(preview as Promise<unknown>, /Decoder unavailable/);
        await cancelled;
        const next = transcriber.tryTranscribe(audio);
        assert.ok(next);
        await assert.rejects(next, /Decoder unavailable/);
    });
});
