interface TranscriptionJob<Result> {
    cancelled: boolean;
    started: boolean;
    completion: Promise<Result | undefined>;
    cancellation?: Promise<unknown>;
}

/** Keep one transcription in flight; previews are dropped, never queued, while busy. */
export class DictationTranscriber<Result> {
    private active: TranscriptionJob<Result> | undefined;
    private readonly invoke: (audio: ArrayBuffer) => Promise<Result>;
    private readonly cancel: () => Promise<unknown>;

    constructor(invoke: (audio: ArrayBuffer) => Promise<Result>, cancel: () => Promise<unknown>) {
        this.invoke = invoke;
        this.cancel = cancel;
    }

    tryTranscribe(readAudio: () => Promise<ArrayBuffer>): Promise<Result | undefined> | undefined {
        if (this.active) return;
        const job: TranscriptionJob<Result> = {
            cancelled: false,
            started: false,
            completion: Promise.resolve(undefined),
        };
        this.active = job;
        job.completion = this.run(job, readAudio);
        return job.completion;
    }

    /** Cancellation acknowledgement alone does not mean the decoder has finished. */
    cancelAndWait(): Promise<void> {
        const job = this.active;
        if (!job) return Promise.resolve();
        job.cancelled = true;
        if (job.started && !job.cancellation) {
            job.cancellation = Promise.resolve()
                .then(() => this.cancel())
                .catch(() => {});
        }
        return job.completion.then(
            () => {},
            () => {},
        );
    }

    private async run(job: TranscriptionJob<Result>, readAudio: () => Promise<ArrayBuffer>) {
        try {
            const audio = await readAudio();
            if (job.cancelled) return;
            job.started = true;
            const result = await this.invoke(audio);
            return job.cancelled ? undefined : result;
        } finally {
            // A delayed cancellation must never arrive after the next job starts.
            if (job.cancellation) await job.cancellation;
            if (this.active === job) this.active = undefined;
        }
    }
}
