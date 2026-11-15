import type { Component, ParentProps } from "solid-js";
import { onCleanup, onMount, Show } from "solid-js";
import { isSettingsManaged } from "../settings.js";
import classes from "./ManagedSettingsSection.module.css";

const CONTROL_SELECTOR =
    "button, input, textarea, select, a, [role='button'], [role='switch'], [role='checkbox'], [role='radio'], [role='tab'], [role='slider'], [role='combobox'], [role='textbox'], [contenteditable]";
const NAVIGATION_SELECTOR = "[data-parent-settings-navigation]";
const READONLY_INPUT_TYPES = new Set(["text", "search", "url", "tel", "email", "password", "number"]);

/** Read-only settings still permit searching and expanding panels to inspect values. */
export function ManagedSettingsSection(props: ParentProps) {
    let content: HTMLDivElement | undefined;
    let observer: MutationObserver | undefined;
    const listeners: Array<[string, EventListener]> = [];

    const isNavigation = (target: Element) => {
        const navigation = target.closest(NAVIGATION_SELECTOR);
        return navigation !== null && content?.contains(navigation) === true;
    };

    const disableControls = () => {
        if (!content || !isSettingsManaged()) return;
        for (const control of content.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)) {
            if (isNavigation(control)) continue;
            if (
                control instanceof HTMLTextAreaElement ||
                (control instanceof HTMLInputElement && READONLY_INPUT_TYPES.has(control.type))
            ) {
                control.readOnly = true;
                control.setAttribute("aria-readonly", "true");
                control.setAttribute("data-parent-settings-readonly", "true");
                continue;
            }
            control.setAttribute("aria-disabled", "true");
            control.setAttribute("tabindex", "-1");
            if (
                control instanceof HTMLButtonElement ||
                control instanceof HTMLInputElement ||
                control instanceof HTMLTextAreaElement ||
                control instanceof HTMLSelectElement
            ) {
                control.disabled = true;
            }
            if (control.hasAttribute("contenteditable")) control.setAttribute("contenteditable", "false");
        }
    };

    onMount(() => {
        if (!content || !isSettingsManaged()) return;
        disableControls();
        observer = new MutationObserver(disableControls);
        observer.observe(content, { childList: true, subtree: true });

        // Some Shelter controls use divs and delegated listeners instead of native
        // inputs. Capture their activation before the control's own handler runs.
        const preventChange: EventListener = (event) => {
            if (!isSettingsManaged() || !(event.target instanceof Element) || isNavigation(event.target)) return;
            if (
                event.target.closest("[data-parent-settings-readonly]") &&
                ["click", "auxclick", "dblclick", "keydown"].includes(event.type)
            ) {
                return;
            }
            if (event instanceof KeyboardEvent && !["Enter", " "].includes(event.key)) return;
            event.preventDefault();
            event.stopImmediatePropagation();
        };
        for (const name of ["click", "auxclick", "dblclick", "beforeinput", "input", "change", "keydown"]) {
            content.addEventListener(name, preventChange, true);
            listeners.push([name, preventChange]);
        }

        const preventEarlyActivation: EventListener = (event) => {
            if (!isSettingsManaged() || !(event.target instanceof Element) || isNavigation(event.target)) return;
            if (event.target.closest("[data-parent-settings-readonly]")) return;
            if (!event.target.closest(CONTROL_SELECTOR)) return;
            if (
                event instanceof KeyboardEvent &&
                ![
                    "Enter",
                    " ",
                    "ArrowUp",
                    "ArrowDown",
                    "ArrowLeft",
                    "ArrowRight",
                    "Home",
                    "End",
                    "PageUp",
                    "PageDown",
                ].includes(event.key)
            ) {
                return;
            }
            event.preventDefault();
            event.stopImmediatePropagation();
        };
        for (const name of ["pointerdown", "mousedown", "touchstart", "keydown", "keyup"]) {
            content.addEventListener(name, preventEarlyActivation, true);
            listeners.push([name, preventEarlyActivation]);
        }
    });

    onCleanup(() => {
        observer?.disconnect();
        for (const [name, listener] of listeners) content?.removeEventListener(name, listener, true);
    });

    return (
        <section data-parent-managed-settings={isSettingsManaged() ? "true" : "false"}>
            <Show when={isSettingsManaged()}>
                <div class={classes.notice} role="note" data-parent-settings-notice>
                    <strong>Managed by your parent</strong>
                    <p>You can view these settings. Ask your parent to change them.</p>
                    <Show when={shelter.plugin.store.settings?.settingsPolicyInvalid === true}>
                        <p>The device policy could not be loaded. Settings remain locked until your parent fixes it.</p>
                    </Show>
                </div>
            </Show>
            <div ref={content}>{props.children}</div>
        </section>
    );
}

export function managedSettingsPage(Page: Component): Component {
    return () => (
        <ManagedSettingsSection>
            <Page />
        </ManagedSettingsSection>
    );
}
