export interface DictationComposer {
    isCurrentTarget(): boolean;
    draftRevision(): number;
    readDraft(): string;
    writeDraft(text: string): void;
    notifyInput(): void;
    waitForRender(): Promise<void>;
    sendButton(): (() => void) | undefined;
}

export type DictationSendResult = "sent" | "preserved" | "draft";

/** Send only into the exact empty composer that the user started recording in. */
export async function sendDictationTranscript(
    composer: DictationComposer,
    initialRevision: number,
    text: string,
): Promise<DictationSendResult> {
    if (!text.trim()) return "preserved";
    if (!composer.isCurrentTarget() || composer.draftRevision() !== initialRevision || composer.readDraft() !== "") {
        return "preserved";
    }

    composer.writeDraft(text);
    composer.notifyInput();
    await composer.waitForRender();

    // React may replace the composer, or the user may type/navigate while it renders.
    if (!composer.isCurrentTarget() || composer.draftRevision() !== initialRevision || composer.readDraft() !== text) {
        return "preserved";
    }
    const send = composer.sendButton();
    if (!send) return "draft";
    send();
    await composer.waitForRender();

    // Never click twice: a slow network must not create duplicate messages.
    return composer.isCurrentTarget() && composer.readDraft() === "" ? "sent" : "draft";
}
