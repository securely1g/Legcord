# Omarchy Mobile fork

This branch builds Legcord 1.3.1-omarchy.8. It retains the existing `legcord`
profile and login, and packages the application as `legcord-mobile-git` on Arch.
Fork builds use manual updates so an upstream binary cannot replace the patch.

## Mobile layout

Enable **Mobile Mode** in Legcord settings and restart. Mobile mode selects a
native, opaque window and avoids desktop titlebar injection. The saved desktop
window style is preserved for when mobile mode is disabled.

The bundled stylesheet increases message text and touch targets on narrow
windows, independently of Quick CSS. Windows can fit displays down to 320 logical
pixels wide. On narrow screens, navigation shows the server rail and channel
sidebar across the window, with the chat panel hidden. Select a server, then a
channel to open full-width chat; its menu button returns to navigation. Direct
messages work the same way. This remains Discord's experimental mobile web interface, not
the native Android/iOS app.

Mobile mode hides the App Launcher button from the message composer.

## External links and embeds

Links in this fork cannot launch an external browser, including links to
`github.com`. Discord's own infrastructure remains available for login, chat,
attachments, and calls. The external embed allowlist is enabled and empty by
default, so third-party embeds such as YouTube players are blocked. External
media proxied through Discord's CDN is checked against its original site;
uploaded Discord attachments and avatars remain available. Blocked iframe,
video, and audio players are unloaded to stop existing playback. These rules
are separate from the Content Security Policy (CSP) setting.

Open **Legcord Settings → Networking** to change **Restrict external embeds** or
edit **Allowed embed domains**. Enter hostnames separated by lines or commas,
choose **Save embed domains**, and restart Legcord to clear content that was
already loaded. Entries match exact hostnames and allow HTTPS only:
`github.com` does not allow `gist.github.com`, `api.github.com`, or other
subdomains unless they are listed separately. An empty list blocks all external
embeds while leaving Discord's infrastructure available. Invalid entries are
shown as an error and cannot be saved. Adding a domain or turning off the embed
filter does not allow links to open an external browser.

Without a parent policy, the profile's `storage/settings.json` stores the embed
options as `externalUrlAllowlistEnabled` and `externalUrlAllowlist`.

### Parent-managed settings (Linux)

An administrator can manage all Legcord preferences outside the user's profile at
the fixed path `/etc/legcord/policy.json`. Install the restrictive example with
a root-owned directory and file:

```sh
sudo install -d -o root -g root -m 0755 /etc/legcord
sudo install -o root -g root -m 0644 \
    /usr/share/doc/legcord-mobile-git/parent-policy.json.example /etc/legcord/policy.json
```

From a source checkout, use `packaging/parent-policy.json.example` as the input
file instead.

The version 2 example blocks external embeds and makes all Legcord settings
parent-managed. Its `settings` object contains administrator overrides, and
`language` selects the Legcord interface language:

```json
{
    "version": 2,
    "externalUrlAllowlistEnabled": true,
    "externalUrlAllowlist": [],
    "language": "en-US",
    "settings": {
        "mobileMode": true,
        "quickCss": false,
        "useSystemCssEditor": false,
        "mods": [],
        "automaticUpdates": false
    }
}
```

Restart Legcord after installing or editing the policy. Every Legcord settings
page then shows **Managed by your parent**. Values can be inspected, searched,
and copied; preference changes and editor, folder, file-picker, backup,
plugin, keybind, and advanced diagnostic actions are blocked. The main process
rejects direct IPC writes as well as individual/bulk configuration writes.
The CSS system-editor route cannot start Foot or a file manager.

For version 2, preferences come from application defaults plus the root-owned
`settings` overrides, never from the daily user's profile. Omitted values use
managed defaults: mobile mode and setup-complete are on; Quick CSS, process
scanning, and the invite websocket are off. An administrator may copy selected
existing preferences into `settings` before enabling management. Only known,
typed settings are accepted. Keep the external embed values at the document's
top level, and do not put derived `*PolicyManaged`/`*PolicyInvalid` metadata
inside `settings`. Unknown or mistyped entries invalidate the whole document.

Profile edits, new/portable profiles, backup restores, command-line settings,
and safe mode cannot override the parent snapshot. User Chromium extensions,
runtime plugins, profile themes, Quick CSS, and JavaScript/editor keybind
actions do not run while settings are managed. Their files remain intact.
Unsupported customization overrides (nonempty mods, enabled plugins, Quick CSS,
system editors, executable keybinds, dangerous-switch bypasses, and automatic
updates) invalidate a version 2 policy rather than enable user-writable code.
The mandatory Shelter integration is pinned inside the installed app, with
its source revision, license and checksum in `assets/vendor/`. Managed startup
disables stored Shelter user plugins and updates before core initialization,
locks plugin mutation APIs, and removes Shelter’s own plugin/import settings
page. Script/manifest/data content remains stored; the plugin enable/update
flags and developer-mode state are deliberately disabled. Back up the profile’s
IndexedDB while Legcord is closed before upgrading if supervised rollback of
that state may be needed.

Developer tools are disabled. Normal chat, microphone dictation, mute/deafen,
and window controls remain available.

Existing version 1 embed-only policies remain supported and manage only the
embed settings. Upgrade the policy to version 2 with a `settings` object to
manage all Legcord preferences. Discord's own account, privacy, and server
settings are separate from Legcord preferences.

Use administrator access, for example `sudoedit /etc/legcord/policy.json`, to
change the policy, then restart Legcord. Entries still require exact HTTPS
hostnames. Setting `externalUrlAllowlistEnabled` to `false` in this administrator
file turns off embed filtering while keeping its controls read-only. Browser
launches remain blocked independently of the embed policy.

The policy directory and file must belong to root and must not be writable by
group or other users. Symlinks are rejected. If `/etc/legcord` exists but the
file is missing, unreadable, insecure, or invalid, Legcord keeps management
active, locks all settings with restrictive defaults, and blocks all external
embeds. The settings page reports that the
policy needs the parent's attention. Do not make the user's entire Legcord
profile root-owned; login data and ordinary chat state must remain writable.

When `/etc/legcord` does not exist, the settings remain user-managed. To return
to that mode, an administrator must remove the policy file and its empty
directory, then restart Legcord.

These restrictions protect this installed client. An account with sudo/root
access can replace the policy or application, and another client or browser
can bypass an app-specific policy. Use a non-admin daily account and broader
device restrictions when those routes must also be controlled. Enabling this
policy does not change account privileges.

## Local voice dictation

In a channel with an empty message box, tap the microphone and speak. A live
transcript appears in the recording panel and updates as you continue. Updates
arrive after a short processing delay and may revise earlier words; they are
previews and do not change the message box or send messages. Choose **Stop & Send**
to finish recognition of the entire recording and send its text to the same
channel automatically. Cancel discards the recording and its preview. If the channel or
draft changes, automatic sending is blocked and the transcript is retained for
recovery. Recordings are limited to 60 seconds.

Linux dictation requires `/usr/bin/whisper-cli`, `/usr/bin/ffmpeg`, and the
multilingual Whisper base model in the Legcord profile's `speech/ggml-base.bin`.
No transcription API key or cloud speech service is used. Temporary recordings
and conversion files are removed after processing; recognized text is sent to
Discord only through its normal composer. Speech recognition can make mistakes.

On Arch, install the dependencies and the checksum-pinned model:

```sh
sudo pacman -S --needed whisper-cpp ffmpeg
bash packaging/install-dictation-model.sh
```

The model is about 142 MiB. The installer uses the default Linux Legcord profile;
custom profile locations require placing the model in that profile manually.
The VM viewer must have access to the host microphone for live speech input.
The local VM launcher follows the host's selected microphone, including a
Bluetooth headset, when its `microphone-source` setting is `auto`.

## Build and package

Use Node 26 or newer and the pnpm version specified in `package.json`:

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm test
pnpm package:mobile
```

This creates `dist/mobile-build.sha256` with checksums of the packaged resources.
Keep the checkout and build output together when copying them to an Arch machine.
Then run:

```sh
cd packaging/arch
makepkg --cleanbuild --force
sudo pacman -U legcord-mobile-git-*.pkg.tar.zst
```

The package uses system Electron 44, preserves `/usr/bin/legcord` and the desktop
launcher, and conflicts with the original `legcord-bin` package. Keep the original
package file for rollback. Reinstall it with `pacman -U` after closing Legcord;
the profile remains in place. The previous VM Quick CSS workaround should be
backed up and removed when deploying this build to avoid duplicate styling.

## Validation scope

Regression coverage includes mobile window policy, narrow display bounds,
dictation input/origin limits, serial preview jobs, cancellation, and guarded
sending with a fake composer. Validate live preview/microphone/stop/cancel states
and the final layout in the VM.
Use a local test composer for automatic-send tests so testing does not post into
real conversations. Windows/macOS dictation is not implemented in this fork.
