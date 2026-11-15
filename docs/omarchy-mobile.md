# Omarchy Mobile fork

This branch builds Legcord 1.3.1-omarchy.6. It retains the existing `legcord`
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

The profile's `storage/settings.json` stores the embed options as
`externalUrlAllowlistEnabled` and `externalUrlAllowlist`. These restrictions
apply inside Legcord; they do not prevent browsing in other applications or
prevent someone who can edit the settings from changing the embed allowlist.

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
