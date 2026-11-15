const { ipcRenderer, webFrame } = require("electron");

import type { ModBundle } from "../../../@types/ModBundle.js";
import { managedShelterSettingsGuardScript } from "../managedShelter.js";
import { buildManagedShelterBootstrap } from "../managedShelterStartup.js";

const requiredPlugins: Record<string, [string, { isVisible: boolean; allowedActions: Record<string, true> }]> = {
    "legcord-arrpc": ["legcord://plugins/rpc/", { isVisible: false, allowedActions: {} }],
    "legcord-settings": ["legcord://plugins/settings/", { isVisible: false, allowedActions: {} }],
    "legcord-power": ["legcord://plugins/power/", { isVisible: false, allowedActions: {} }],
    "legcord-screenshare": ["legcord://plugins/screenshare/", { isVisible: false, allowedActions: {} }],
    "legcord-titlebar": ["legcord://plugins/titlebar/", { isVisible: false, allowedActions: {} }],
};
if (process.platform === "darwin") {
    requiredPlugins["legcord-touchbar"] = [
        "legcord://plugins/touchbar/",
        { isVisible: true, allowedActions: { toggle: true } },
    ];
}
async function inject() {
    try {
        const managed = ipcRenderer.sendSync("getConfig", "settingsPolicyManaged") === true;
        await ipcRenderer.invoke("getShelterBundle").then(async (bundle: ModBundle) => {
            if (bundle?.enabled) {
                if (managed) {
                    if (typeof bundle.js !== "string" || !bundle.js) {
                        throw new Error("Parent-managed Shelter package runtime is unavailable.");
                    }
                    await webFrame.executeJavaScript(
                        buildManagedShelterBootstrap(
                            bundle.js,
                            requiredPlugins,
                            managedShelterSettingsGuardScript(true),
                        ),
                    );
                } else {
                    await webFrame.executeJavaScript(`(()=>{
                const SHELTER_INJECTOR_PLUGINS = ${JSON.stringify(requiredPlugins)};
                ${bundle.js}
            })()`);
                }
            }
        });
    } catch (e) {
        console.error(e);
    }
}
inject();
