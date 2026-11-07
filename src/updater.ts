import { platform } from "node:os";
import type { AllPublishOptions } from "builder-util-runtime";
import { app } from "electron";
import { AppImageUpdater, DebUpdater, MacUpdater } from "electron-updater";

const isOmarchyBuild = app.getVersion().includes("-omarchy.");
const updateProvider: AllPublishOptions = {
    provider: "github",
    repo: "Legcord",
    owner: isOmarchyBuild ? "securely1g" : "Legcord",
};

// Fork builds are deployed as local packages until signed release assets are published.
if (isOmarchyBuild) {
    console.log("Omarchy build: install updates from the fork manually.");
}

if (!isOmarchyBuild && platform() === "darwin") {
    const autoUpdater = new MacUpdater(updateProvider);
    autoUpdater.checkForUpdatesAndNotify();
}

if (!isOmarchyBuild && platform() === "linux") {
    const appimage = new AppImageUpdater(updateProvider);
    const deb = new DebUpdater(updateProvider);

    deb.on("update-downloaded", (_e) => {
        deb.quitAndInstall();
    });
    appimage.on("update-downloaded", (_e) => {
        appimage.quitAndInstall();
    });

    deb.checkForUpdatesAndNotify();
    appimage.checkForUpdatesAndNotify();
}
