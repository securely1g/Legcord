const { ipcRenderer } = require("electron");

import type { Settings } from "../../@types/settings.js";
import { addStyle } from "../../common/dom.js";
import { sleep } from "../../common/sleep.js";
import { getWindowChrome } from "../../common/windowChrome.js";

const mobileMode = ipcRenderer.sendSync("getConfig", "mobileMode") as Settings["mobileMode"];
const windowStyle = ipcRenderer.sendSync("getConfig", "windowStyle") as Settings["windowStyle"];
const transparency = ipcRenderer.sendSync("getConfig", "transparency") as Settings["transparency"];
const os = ipcRenderer.sendSync("getOS") as string;
const chrome = getWindowChrome({ mobileMode, windowStyle, transparency }, os);

if (mobileMode) {
    document.addEventListener("DOMContentLoaded", () => {
        document.documentElement.setAttribute("data-legcord-mobile", "true");
        addStyle("legcord://assets/css/mobile.css");
    });
}

if (chrome.usesOverlayChrome) {
    document.addEventListener("DOMContentLoaded", () => {
        document.body.setAttribute("legcord-platform", os);
        addStyle("legcord://assets/css/baseTitlebar.css");
        sleep(500);
        switch (os) {
            case "darwin":
                // breaks traffic lights with bar__ and hidden__ classes
                // document.body.setAttribute("class", "platform-osx");
                addStyle("legcord://assets/css/darwinTitlebar.css");
                break;
            case "win32":
                document.body.setAttribute("class", "platform-win");
                addStyle("legcord://assets/css/winTitlebar.css");
                break;
            case "linux":
                document.body.setAttribute("class", "platform-linux");
                addStyle("legcord://assets/css/linuxTitlebar.css");
                break;
            default:
                break;
        }
    });
}
