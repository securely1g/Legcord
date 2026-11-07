import { sendDictationTranscript } from "../../common/dictationSend.js";

const { ipcRenderer } = require("electron");

type DictationStatus =
    | { ok: true; available: true; maxDurationSeconds: number; maxBytes: number }
    | { ok: false; error: string; message: string };
type TranscriptResult = { ok: true; text: string } | { ok: false; error: string; message: string };
type Phase = "idle" | "requesting" | "recording" | "transcribing" | "error" | "result";
type Capture = {
    textarea: HTMLTextAreaElement;
    route: string;
    revision: number;
    invalidated: boolean;
    chunks: Blob[];
    bytes: number;
    started: number;
    stream?: MediaStream;
    recorder?: MediaRecorder;
    timer?: ReturnType<typeof setTimeout>;
    audio?: ArrayBuffer;
};

if (ipcRenderer.sendSync("getConfig", "mobileMode")) {
    document.addEventListener("DOMContentLoaded", () => {
        void installDictation();
    });
}

async function installDictation() {
    const textareaSelector =
        'form[class*="form_"] [class*="channelBottomBarArea_"] [class*="channelTextArea_"] textarea';
    const contextSelector = '[class*="replyBar_"], [class*="channelAttachmentArea_"], [class*="messageEditorCompact_"]';
    const revisions = new WeakMap<HTMLTextAreaElement, number>();
    let phase: Phase = "idle";
    let current: Capture | undefined;
    let available = false;
    let maxDuration = 60;
    let maxBytes = 8 * 1024 * 1024;
    let ownInput = false;
    let message = "Checking local speech recognition…";
    let transcript = "";
    let noticeTimer: ReturnType<typeof setTimeout> | undefined;

    const mic = document.createElement("button");
    mic.type = "button";
    mic.className = "legcord-dictation-mic";
    mic.innerHTML =
        '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3" fill="currentColor"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
    const panel = document.createElement("section");
    panel.className = "legcord-dictation-panel";
    panel.setAttribute("aria-label", "Voice message transcription");
    panel.hidden = true;
    const status = document.createElement("div");
    status.className = "legcord-dictation-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const preview = document.createElement("textarea");
    preview.className = "legcord-dictation-transcript";
    preview.readOnly = true;
    preview.setAttribute("aria-label", "Transcribed message");
    const actions = document.createElement("div");
    actions.className = "legcord-dictation-actions";

    function action(label: string, handler: () => void) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.addEventListener("click", (event) => {
            if (event.isTrusted) handler();
        });
        actions.append(button);
        return button;
    }

    const stop = action("Stop & send", () => finishRecording());
    const cancel = action("Cancel", () => cancelCapture());
    const retry = action("Retry transcription", () => {
        if (current?.audio) void transcribe(current);
    });
    const copy = action("Copy text", () => {
        void navigator.clipboard.writeText(transcript).then(
            () => {
                message = "Transcript copied.";
                render();
            },
            () => {
                preview.focus();
                preview.select();
                message = "Select and copy the transcript below.";
                render();
            },
        );
    });
    const dismiss = action("Dismiss", () => cancelCapture());
    panel.append(status, preview, actions);
    document.body.append(panel);

    function activeTextarea() {
        return document.querySelector<HTMLTextAreaElement>(textareaSelector);
    }

    function route() {
        return /^\/channels\/(?:@me|\d+)\/\d+$/.test(location.pathname) ? location.pathname : "";
    }

    function hasDraftContext(textarea: HTMLTextAreaElement) {
        const form = textarea.closest("form");
        if (!form) return true;
        if (form.querySelector('[class*="replyBar_"], [class*="messageEditorCompact_"]')) return true;
        if (
            [...form.querySelectorAll('[class*="channelAttachmentArea_"], [class*="floatingBars_"]')].some(
                (element) => element.children.length > 0 || Boolean(element.textContent?.trim()),
            )
        )
            return true;
        return [...form.querySelectorAll<HTMLInputElement>('input[type="file"]')].some(
            (input) => (input.files?.length ?? 0) > 0,
        );
    }

    function sameTarget(capture: Capture) {
        return (
            current === capture &&
            !capture.invalidated &&
            route() === capture.route &&
            capture.textarea.isConnected &&
            activeTextarea() === capture.textarea &&
            !capture.textarea.disabled &&
            !capture.textarea.readOnly &&
            !hasDraftContext(capture.textarea)
        );
    }

    function cleanMedia(capture: Capture) {
        clearTimeout(capture.timer);
        for (const track of capture.stream?.getTracks() ?? []) track.stop();
        delete capture.stream;
    }

    function cancelCapture() {
        const previous = current;
        current = undefined;
        clearTimeout(noticeTimer);
        if (previous) {
            if (previous.recorder?.state !== "inactive") previous.recorder?.stop();
            cleanMedia(previous);
            previous.chunks.length = 0;
            delete previous.audio;
        }
        if (phase === "transcribing") void ipcRenderer.invoke("dictation-cancel").catch(() => {});
        phase = "idle";
        message = "";
        transcript = "";
        render();
    }

    function fail(text: string) {
        phase = "error";
        message = text;
        render();
    }

    function render() {
        const textarea = activeTextarea();
        const busy = phase === "requesting" || phase === "recording" || phase === "transcribing";
        mic.disabled =
            phase !== "recording" &&
            (busy ||
                !available ||
                !route() ||
                !textarea ||
                textarea.value !== "" ||
                textarea.disabled ||
                textarea.readOnly ||
                hasDraftContext(textarea));
        mic.dataset.recording = String(phase === "recording");
        const label =
            phase === "recording"
                ? "Stop recording, transcribe and send"
                : textarea && (textarea.value !== "" || hasDraftContext(textarea))
                  ? "Clear your draft, attachments and reply before recording"
                  : "Record a message, then stop to transcribe and send";
        mic.title = !available ? message : label;
        mic.setAttribute("aria-label", mic.title);
        mic.setAttribute("aria-pressed", String(phase === "recording"));
        panel.hidden = phase === "idle";
        const text =
            phase === "recording" && current
                ? `Recording ${Math.floor((Date.now() - current.started) / 1000)}s / ${maxDuration}s. Stop to transcribe and send.`
                : message;
        if (status.textContent !== text) status.textContent = text;
        preview.hidden = !transcript;
        if (preview.value !== transcript) preview.value = transcript;
        stop.hidden = phase !== "recording";
        cancel.hidden = !busy;
        retry.hidden = phase !== "error" || !current?.audio;
        copy.hidden = !transcript;
        dismiss.hidden = busy;
    }

    function sync() {
        const textarea = activeTextarea();
        const composer = textarea?.closest('[class*="channelTextArea_"]');
        const controls = composer?.querySelector('[class*="buttons_"]');
        if (controls && mic.parentElement !== controls) controls.prepend(mic);
        else if (!controls) mic.remove();
        if (current && (route() !== current.route || textarea !== current.textarea)) {
            current.invalidated = true;
            if (phase === "recording") finishRecording();
            else if (phase === "requesting") {
                cancelCapture();
                fail("Recording cancelled because the channel changed.");
            }
        }
        if (current && hasDraftContext(current.textarea)) current.invalidated = true;
        render();
    }

    document.addEventListener("input", (event) => {
        if (ownInput || !(event.target instanceof HTMLTextAreaElement) || !event.target.matches(textareaSelector))
            return;
        revisions.set(event.target, (revisions.get(event.target) ?? 0) + 1);
        if (current?.textarea === event.target) current.invalidated = true;
        render();
    });
    document.addEventListener("change", (event) => {
        if (
            current &&
            event.target instanceof HTMLInputElement &&
            event.target.type === "file" &&
            current.textarea.closest("form")?.contains(event.target)
        ) {
            current.invalidated = true;
            render();
        }
    });

    async function startRecording() {
        const textarea = activeTextarea();
        const channel = route();
        if (
            !available ||
            !textarea ||
            textarea.value !== "" ||
            !channel ||
            textarea.disabled ||
            textarea.readOnly ||
            hasDraftContext(textarea)
        )
            return;
        cancelCapture();
        const capture: Capture = {
            textarea,
            route: channel,
            revision: revisions.get(textarea) ?? 0,
            invalidated: false,
            chunks: [],
            bytes: 0,
            started: Date.now(),
        };
        current = capture;
        phase = "requesting";
        message = "Allow the microphone to record your message.";
        render();
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            if (!sameTarget(capture)) {
                for (const track of stream.getTracks()) track.stop();
                if (current === capture) fail("The composer changed. Recording was cancelled.");
                return;
            }
            capture.stream = stream;
            const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
                ? "audio/webm;codecs=opus"
                : "audio/webm";
            const recorder = new MediaRecorder(stream, { mimeType });
            capture.recorder = recorder;
            recorder.addEventListener("dataavailable", (event) => {
                if (current !== capture || event.data.size === 0) return;
                capture.bytes += event.data.size;
                if (capture.bytes > maxBytes) {
                    cancelCapture();
                    fail("Recording is too large. Try a shorter message.");
                } else capture.chunks.push(event.data);
            });
            recorder.addEventListener("error", () => {
                if (current !== capture) return;
                cancelCapture();
                fail("The microphone could not record. Check its connection and try again.");
            });
            recorder.addEventListener("stop", () => {
                cleanMedia(capture);
                if (current !== capture) return;
                void (async () => {
                    capture.audio = await new Blob(capture.chunks, { type: mimeType }).arrayBuffer();
                    capture.chunks.length = 0;
                    if (current === capture) await transcribe(capture);
                })().catch(() => {
                    if (current === capture) fail("Recording could not be read. Please try again.");
                });
            });
            recorder.start(1000);
            capture.started = Date.now();
            capture.timer = setTimeout(() => finishRecording(), maxDuration * 1000);
            phase = "recording";
            render();
        } catch (error) {
            cleanMedia(capture);
            if (current !== capture) return;
            fail(
                error instanceof DOMException && error.name === "NotAllowedError"
                    ? "Microphone access was denied. Allow microphone access and try again."
                    : "No usable microphone was found. Connect one and try again.",
            );
        }
    }

    function finishRecording() {
        if (phase !== "recording" || !current?.recorder) return;
        phase = "transcribing";
        message = "Transcribing on this device…";
        current.recorder.stop();
        cleanMedia(current);
        render();
    }

    async function transcribe(capture: Capture) {
        if (current !== capture || !capture.audio) return;
        phase = "transcribing";
        message = "Transcribing on this device…";
        render();
        try {
            const result = (await ipcRenderer.invoke("dictation-transcribe", capture.audio)) as TranscriptResult;
            if (current !== capture) return;
            if (!result.ok) {
                fail(result.message || "Transcription failed. Try again.");
                return;
            }
            transcript = result.text.trim();
            if (!transcript) {
                fail("No speech was detected. Try recording again.");
                return;
            }
            const resultState = await sendDictationTranscript(
                {
                    isCurrentTarget: () => sameTarget(capture),
                    draftRevision: () => revisions.get(capture.textarea) ?? 0,
                    readDraft: () => capture.textarea.value,
                    writeDraft: (text) => {
                        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
                        if (!setter) throw new Error("Textarea value setter unavailable");
                        setter.call(capture.textarea, text);
                    },
                    notifyInput: () => {
                        ownInput = true;
                        try {
                            capture.textarea.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
                        } finally {
                            ownInput = false;
                        }
                    },
                    waitForRender: () => new Promise((resolve) => setTimeout(resolve, 250)),
                    sendButton: () => {
                        const composer = capture.textarea.closest('[class*="channelTextArea_"]');
                        const button = composer
                            ?.querySelector('svg[class*="sendIcon_"]')
                            ?.closest<HTMLElement>('[role="button"]');
                        if (!button || button.getAttribute("aria-disabled") === "true") return;
                        return () => button.click();
                    },
                },
                capture.revision,
                transcript,
            );
            if (current !== capture) return;
            delete capture.audio;
            phase = "result";
            if (resultState === "sent") {
                transcript = "";
                message = "Message sent.";
                noticeTimer = setTimeout(() => {
                    if (current === capture && phase === "result") cancelCapture();
                }, 4000);
            } else if (resultState === "draft") {
                message = "Transcript is in the composer. Sending was not confirmed; review it there before sending.";
            } else {
                message = "The channel or draft changed. Your transcript was kept here and was not sent.";
            }
            render();
        } catch {
            if (current === capture) {
                fail(
                    transcript
                        ? "Sending failed. Your transcript is kept here; you can copy it."
                        : "Transcription failed. Retry, or record a new message.",
                );
            }
        }
    }

    mic.addEventListener("click", (event) => {
        if (!event.isTrusted) return;
        event.preventDefault();
        event.stopPropagation();
        if (phase === "recording") finishRecording();
        else void startRecording();
    });
    const observer = new MutationObserver((records) => {
        const form = current?.textarea.closest("form");
        if (
            current &&
            form &&
            records.some(
                (record) =>
                    form.contains(record.target) &&
                    [...record.addedNodes, ...record.removedNodes].some(
                        (node) =>
                            node instanceof Element &&
                            (node.matches(contextSelector) || node.querySelector(contextSelector)),
                    ),
            )
        ) {
            current.invalidated = true;
        }
        sync();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const interval = setInterval(sync, 250);
    window.addEventListener("popstate", sync);
    window.addEventListener("pagehide", () => {
        cancelCapture();
        observer.disconnect();
        clearInterval(interval);
    });
    sync();
    try {
        const result = (await ipcRenderer.invoke("dictation-status")) as DictationStatus;
        if (result.ok) {
            available = true;
            maxDuration = Math.max(1, Math.min(60, result.maxDurationSeconds));
            maxBytes = Math.max(1, Math.min(8 * 1024 * 1024, result.maxBytes));
            message = "";
        } else fail(result.message || "Local speech recognition is unavailable.");
    } catch {
        fail("Local speech recognition is unavailable.");
    }
    render();
}
