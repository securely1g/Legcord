import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type DictationComposer, sendDictationTranscript } from "../src/common/dictationSend.ts";

function mockComposer() {
    const state = { current: true, revision: 0, draft: "", sends: 0, available: true, clearOnSend: true };
    const composer: DictationComposer = {
        isCurrentTarget: () => state.current,
        draftRevision: () => state.revision,
        readDraft: () => state.draft,
        writeDraft: (text) => {
            state.draft = text;
        },
        notifyInput: () => {},
        waitForRender: async () => {},
        sendButton: () =>
            state.available
                ? () => {
                      state.sends++;
                      if (state.clearOnSend) state.draft = "";
                  }
                : undefined,
    };
    return { composer, state };
}

describe("dictation send guard", () => {
    it("sends once into the original empty composer", async () => {
        const { composer, state } = mockComposer();
        assert.equal(await sendDictationTranscript(composer, 0, "Hello"), "sent");
        assert.equal(state.sends, 1);
        assert.equal(state.draft, "");
    });

    it("preserves a transcript when the channel or composer changed", async () => {
        const { composer, state } = mockComposer();
        state.current = false;
        assert.equal(await sendDictationTranscript(composer, 0, "Hello"), "preserved");
        assert.equal(state.draft, "");
        assert.equal(state.sends, 0);
    });

    it("does not overwrite a draft, including one typed then erased", async () => {
        const { composer, state } = mockComposer();
        state.draft = "My draft";
        assert.equal(await sendDictationTranscript(composer, 0, "Hello"), "preserved");
        assert.equal(state.draft, "My draft");
        state.draft = "";
        state.revision++;
        assert.equal(await sendDictationTranscript(composer, 0, "Hello"), "preserved");
        assert.equal(state.draft, "");
        assert.equal(state.sends, 0);
    });

    it("rechecks navigation and draft edits after notifying React", async () => {
        for (const change of ["navigation", "draft"] as const) {
            const { composer, state } = mockComposer();
            composer.waitForRender = async () => {
                if (change === "navigation") state.current = false;
                else {
                    state.draft = "User changed this";
                    state.revision++;
                }
            };
            assert.equal(await sendDictationTranscript(composer, 0, "Hello"), "preserved");
            assert.equal(state.sends, 0);
            if (change === "draft") assert.equal(state.draft, "User changed this");
        }
    });

    it("leaves a usable draft when the send control is unavailable", async () => {
        const { composer, state } = mockComposer();
        state.available = false;
        assert.equal(await sendDictationTranscript(composer, 0, "Hello"), "draft");
        assert.equal(state.draft, "Hello");
        assert.equal(state.sends, 0);
    });

    it("never retries a click when sending cannot be confirmed", async () => {
        const { composer, state } = mockComposer();
        state.clearOnSend = false;
        assert.equal(await sendDictationTranscript(composer, 0, "Hello"), "draft");
        assert.equal(state.sends, 1);
    });
});
