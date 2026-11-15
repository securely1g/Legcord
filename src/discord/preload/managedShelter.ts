/** The built-in section key used by the pinned Shelter settings integration. */
const SHELTER_SETTINGS_SECTION = "shelter_shelter_section";

/** Filter the native settings model without changing Discord or Legcord sections. */
export function removeBuiltInShelterSettings(root: unknown): boolean {
    try {
        if (!root || typeof root !== "object" || !("key" in root) || root.key !== "$Root") return false;
        if (!("layout" in root) || !Array.isArray(root.layout)) return false;
        const pending: unknown[] = [root];
        const visited = new Set<object>();
        let changed = false;
        while (pending.length && visited.size < 10000) {
            const node = pending.pop();
            if (!node || typeof node !== "object" || visited.has(node)) continue;
            visited.add(node);
            if (!("layout" in node) || !Array.isArray(node.layout)) continue;
            for (let i = node.layout.length - 1; i >= 0; i--) {
                const child = node.layout[i];
                if (child && typeof child === "object" && "key" in child && child.key === "shelter_shelter_section") {
                    node.layout.splice(i, 1);
                    changed = true;
                } else {
                    pending.push(child);
                }
            }
        }
        return changed;
    } catch {
        // An unexpected upstream layout must not break chat startup. The DOM
        // guard below independently hides and blocks the known native entry.
        return false;
    }
}

/** Self-contained renderer function, serialized only after TypeScript compilation. */
function installManagedShelterSettingsGuard(filterLayout: (root: unknown) => boolean): void {
    const rootFrom = (node: unknown): unknown => {
        try {
            const visited = new Set<object>();
            let current = node;
            while (current && typeof current === "object" && !visited.has(current) && visited.size < 1000) {
                visited.add(current);
                if (!("parent" in current) || !current.parent) return current;
                current = current.parent;
            }
        } catch {
            // An unexpected model is handled by the entry-point guard.
        }
        return undefined;
    };

    // Shelter creates this hook synchronously during its pinned bundle's
    // startup. Queue after its own callback, which inserts native sections.
    const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, "buildLayout");
    if (descriptor?.configurable && descriptor.get) {
        const originalGet = descriptor.get;
        Object.defineProperty(Object.prototype, "buildLayout", {
            ...descriptor,
            get() {
                const result = originalGet.call(this);
                queueMicrotask(() => filterLayout(rootFrom(this)));
                return result;
            },
        });
    }

    type Fiber = {
        return?: Fiber;
        pendingProps?: { partialRoot?: unknown };
        memoizedProps?: { partialRoot?: unknown };
        memoizedState?: Hook;
    };
    type Hook = { next?: Hook; memoizedState?: unknown; queue?: { dispatch?: (value: unknown) => void } };

    const isBuiltInEntry = (element: Element) => {
        const key = element.getAttribute("data-settings-sidebar-item") ?? "";
        return key.includes("shelter_shelter-settings_panel") || key.includes("shelter_shelter-settings_sidebar_item");
    };

    const filterLiveLayout = (element: HTMLElement) => {
        try {
            const fiberKey = Object.keys(element).find((key) => key.startsWith("__reactFiber$"));
            if (!fiberKey) return;
            let fiber = (element as unknown as Record<string, Fiber>)[fiberKey];
            const seen = new Set<Fiber>();
            while (fiber && !seen.has(fiber) && seen.size < 1000) {
                seen.add(fiber);
                if (fiber.pendingProps?.partialRoot || fiber.memoizedProps?.partialRoot) {
                    let root: unknown;
                    const dispatches: Array<(value: unknown) => void> = [];
                    const hooks = new Set<Hook>();
                    for (
                        let hook = fiber.memoizedState;
                        hook && !hooks.has(hook) && hooks.size < 1000;
                        hook = hook.next
                    ) {
                        hooks.add(hook);
                        if (Array.isArray(hook.memoizedState)) {
                            const candidate = hook.memoizedState[0];
                            if (candidate?.key === "$Root" && Array.isArray(candidate.layout)) root = candidate;
                        }
                        if (hook.memoizedState instanceof Set && typeof hook.queue?.dispatch === "function") {
                            dispatches.push(hook.queue.dispatch);
                        }
                    }
                    if (root && dispatches.length >= 2 && filterLayout(root)) {
                        // This is the same harmless state-clone refresh used by
                        // the pinned integration when sections are registered.
                        dispatches[0]((current: unknown) => (current instanceof Set ? new Set(current) : current));
                        return;
                    }
                }
                fiber = fiber.return as Fiber;
            }
        } catch {
            // Unknown React internals fall back to the native entry guard.
        }
    };

    const inspectEntries = () => {
        for (const entry of document.querySelectorAll<HTMLElement>("[data-settings-sidebar-item]")) {
            if (isBuiltInEntry(entry)) {
                entry.hidden = true;
                entry.inert = true;
                entry.setAttribute("aria-hidden", "true");
                entry.style.setProperty("display", "none", "important");
            }
            filterLiveLayout(entry);
        }
    };
    const preventEntry = (event: Event) => {
        if (!(event.target instanceof Element)) return;
        const entry = event.target.closest("[data-settings-sidebar-item]");
        if (!entry || !isBuiltInEntry(entry)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
    };
    document.addEventListener("click", preventEntry, true);
    document.addEventListener("keydown", preventEntry, true);
    inspectEntries();
    new MutationObserver(inspectEntries).observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-settings-sidebar-item"],
    });
}

/** Append directly after the pinned vendor bundle, before its startup microtasks. */
export function managedShelterSettingsGuardScript(managed = true): string {
    if (!managed) return "";
    return `;(${installManagedShelterSettingsGuard.toString()})(${removeBuiltInShelterSettings.toString()});`;
}

export { SHELTER_SETTINGS_SECTION };
