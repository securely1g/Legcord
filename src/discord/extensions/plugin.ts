import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { platform } from "node:os";
import { app, session } from "electron";
import { getManagedSettingsPolicy } from "../../common/managedExternalUrlPolicy.js";

const extensionFolder = `${app.getPath("userData")}/extensions`;

let prefix = "";

if (!getManagedSettingsPolicy().managed && !existsSync(extensionFolder)) {
    mkdirSync(extensionFolder);
    console.log("Created missing extensions folder");
}
await app.whenReady().then(() => {
    if (getManagedSettingsPolicy().managed) return;
    readdirSync(extensionFolder).forEach(async (file) => {
        try {
            // NOTE - The below type assertion is just what we need from the chrome manifest
            if (platform() === "win32") prefix = "file://";
            const manifest = (await import(`${prefix}${extensionFolder}/${file}/manifest.json`, {
                with: { type: "json" },
            })) as { name: string; author: string; type: "json" };

            void session.defaultSession.loadExtension(`${extensionFolder}/${file}`); // NOTE - Awaiting this will cause plugins to not inject
            console.log(`[Mod loader] Loaded ${manifest.name} made by ${manifest.author}`);
        } catch (err) {
            console.error(err);
        }
    });
});
