import { createMemo, createSignal, createUniqueId, Show } from "solid-js";
import type { Settings } from "../../../@types/settings.js";
import { normalizeAllowedDomains } from "../../../common/externalUrlPolicy.js";
import { setConfig } from "../settings.js";
import classes from "./ExternalUrlAllowlist.module.css";

const {
    plugin: { store },
    ui: { SwitchItem, Button, ButtonSizes, Divider },
} = shelter;

export function ExternalUrlAllowlist() {
    const settings = store.settings as Settings;
    const t = store.i18n;
    const id = createUniqueId();
    const [draft, setDraft] = createSignal((settings.externalUrlAllowlist ?? []).join("\n"));
    const [saved, setSaved] = createSignal(false);
    const managed = () => settings.externalUrlPolicyManaged === true;
    const managedDomains = () => (settings.externalUrlAllowlist ?? []).join("\n");
    const entries = createMemo(() =>
        draft()
            .split(/[\s,]+/)
            .filter(Boolean),
    );
    const invalidEntries = createMemo(() => entries().filter((entry) => normalizeAllowedDomains([entry]).length !== 1));

    function save() {
        if (managed() || invalidEntries().length) return;
        const domains = normalizeAllowedDomains(entries());
        setConfig("externalUrlAllowlist", domains, true);
        setDraft(domains.join("\n"));
        setSaved(true);
    }

    return (
        <div class={classes.item}>
            <Show when={managed()}>
                <div class={classes.managedNotice} id={`${id}-managed`}>
                    <p class={classes.managedTitle}>
                        {t["settings-externalUrlAllowlist-managed"] ?? "Managed by your parent"}
                    </p>
                    <p class={classes.note}>
                        {t["settings-externalUrlAllowlist-managed-desc"] ??
                            "These settings are managed on this device. Ask your parent to change the allowed sites."}
                    </p>
                    <Show when={settings.externalUrlPolicyInvalid}>
                        <p class={classes.error} role="status">
                            {t["settings-externalUrlAllowlist-managed-invalid"] ??
                                "The parent policy could not be loaded. External embeds stay blocked until your parent fixes it."}
                        </p>
                    </Show>
                </div>
            </Show>
            <SwitchItem
                note={
                    t["settings-externalUrlAllowlistEnabled-desc"] ??
                    "Block external embeds except the domains listed below. Discord's own services stay available. Links always stay inside Legcord and cannot launch a browser, even for listed domains."
                }
                value={settings.externalUrlAllowlistEnabled ?? true}
                disabled={managed()}
                aria-describedby={managed() ? `${id}-managed` : undefined}
                onChange={(enabled: boolean) => {
                    if (!managed()) setConfig("externalUrlAllowlistEnabled", enabled, true);
                }}
            >
                {t["settings-externalUrlAllowlistEnabled"] ?? "Restrict external embeds"}
            </SwitchItem>
            <label class={classes.title} for={id}>
                {t["settings-externalUrlAllowlist"] ?? "Allowed embed domains"}
            </label>
            <p class={classes.note} id={`${id}-note`}>
                {managed()
                    ? (t["settings-externalUrlAllowlist-managed-domains-desc"] ??
                      "The allowed sites are read-only. An empty list blocks all external embeds. Browser launches remain blocked.")
                    : (t["settings-externalUrlAllowlist-desc"] ??
                      "Enter exact hostnames, separated by lines or commas. HTTPS only; subdomains need their own entry. An empty list blocks all external embeds. Save changes, then restart Legcord to clear content already loaded.")}
            </p>
            <textarea
                class={classes.editor}
                id={id}
                rows={4}
                value={managed() ? managedDomains() : draft()}
                readOnly={managed()}
                spellcheck={false}
                autocapitalize="off"
                aria-invalid={invalidEntries().length > 0}
                aria-describedby={`${id}-note ${id}-error`}
                onInput={(event) => {
                    if (managed()) {
                        event.currentTarget.value = managedDomains();
                        return;
                    }
                    setDraft(event.currentTarget.value);
                    setSaved(false);
                }}
            />
            <div id={`${id}-error`} class={classes.error} role="alert">
                <Show when={invalidEntries().length > 0}>
                    {t["settings-externalUrlAllowlist-invalid"] ??
                        "Use hostnames only, such as github.com. URLs, wildcards, paths, and ports are not allowed."}
                </Show>
            </div>
            <Button
                class={classes.saveButton}
                size={ButtonSizes.MEDIUM}
                disabled={managed() || invalidEntries().length > 0}
                onClick={save}
            >
                {t["settings-externalUrlAllowlist-save"] ?? "Save embed domains"}
            </Button>
            <Show when={saved()}>
                <p class={classes.note} role="status">
                    {t["settings-externalUrlAllowlist-saved"] ??
                        "Saved. Restart Legcord to clear content already loaded."}
                </p>
            </Show>
            <Divider />
        </div>
    );
}
