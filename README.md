# Beam

Send text and files straight to your other computers on the same network: end-to-end encrypted, peer-to-peer, and nothing stored in between.
Runs on Windows, macOS and Linux (Electron).

- **Quick send from anywhere.** Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd> (<kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd> on macOS) to open a small floating box. Type, paste or drop files, then press <kbd>Enter</kbd>.
- **Finds devices automatically** over UDP broadcast. If your network blocks broadcasts, you can add a device by IP address.
- **Direct TCP between devices.** No server, relay or cloud, so nothing is stored on the network. Files are streamed in 256 KB encrypted chunks, with backpressure.
- **End-to-end encrypted and authenticated.** Each device has its own key pair. You pair two devices once by comparing a 6-digit code.

## Getting started

```bash
npm install
npm start
```

Do this on two computers that are on the same Wi-Fi or LAN:

1. Each computer lists the other under **Devices**. Click **Pair** on one of them.
2. Both screens show a 6-digit code. If the codes match, confirm on **both** devices.
3. You're done. Press the shortcut, pick the device (<kbd>Alt</kbd>+<kbd>1..9</kbd>), type or attach, and press <kbd>Enter</kbd>.

Received files go to `Downloads/Beam` (you can change this in Settings). Received text appears under **Activity** and in a notification. You can also have it copied to the clipboard automatically.

### Quick-send popup keys

| Key | Action |
| --- | --- |
| <kbd>Enter</kbd> | Send |
| <kbd>Shift</kbd>+<kbd>Enter</kbd> | New line |
| <kbd>Ctrl/⌘</kbd>+<kbd>O</kbd> | Attach files |
| <kbd>Ctrl/⌘</kbd>+<kbd>V</kbd> | Paste files or a screenshot |
| <kbd>Alt</kbd>+<kbd>1..9</kbd> | Choose target device |
| <kbd>Esc</kbd> | Close |

You can also drag files onto the popup. To change the shortcut, open **Settings**, click the shortcut box and press a new combination.

## Updates

Installed copies check GitHub Releases for a newer version about 15 seconds after launch, then every 4 hours.

- **Windows:** the update downloads in the background and installs silently when you quit Beam. You can also install it right away: click **Restart to update** in the sidebar, the tray menu or Settings. Beam won't restart while a transfer is in progress.
- **macOS:** this works the same way, but only for builds signed with a Developer ID certificate, because macOS only applies updates to properly signed apps. Ad-hoc signed builds (the default when the CI has no certificate) can only *check*. They show "Version x.y.z is available", and **Download…** opens the releases page.
- **Settings → Updates** has a **Check for updates** button and an **Install updates automatically** toggle. With the toggle off, Beam still tells you about new versions but waits for you to click **Download**.
- Development runs (`npm start`) never update themselves.

How a release reaches users:

1. Bump `version` in `package.json`, then commit.
2. Tag the commit `v<version>` (for example `git tag v1.0.1 && git push --tags`). CI checks that the tag matches `package.json`.
3. CI builds and attaches the installers plus `latest.yml` / `latest-mac.yml` to a **draft** release. Updaters ignore drafts, so nothing ships until you click **Publish**.

The repository must be **public**, since installed apps read releases without a token. For a self-hosted feed, put the build output (installers + `latest*.yml`) on any HTTPS server and start Beam with `BEAM_UPDATE_URL=https://your.server/path/`.

## Building installers

### GitHub Actions

`.github/workflows/build.yml` builds on every push to `main`, on pull requests, and on demand from the Actions tab:

| Job | Runner | Output (artifact) |
| --- | --- | --- |
| Windows x64 | `windows-latest` | `Beam-Setup-x.y.z.exe` (NSIS) + `latest.yml`, after `npm test` passes |
| macOS Apple silicon (arm64 only) | `macos-14` | `Beam-x.y.z-arm64.dmg`, plus the `.zip` and `latest-mac.yml` used by the updater |

To publish a release, push a tag such as `v1.0.0`. The installers are then attached to a **draft** GitHub Release for you to review and publish.

**macOS signing.** If you haven't added signing secrets, the Mac app is *ad-hoc* signed. Apple silicon requires at least that much before it will run an app. Gatekeeper still blocks downloaded ad-hoc apps, so on first launch, right-click the app → **Open**, or run `xattr -cr /Applications/Beam.app`. To sign properly and notarize, add these repository secrets:

| Secret | Value |
| --- | --- |
| `MAC_CERT_P12_BASE64` | Developer ID Application certificate (.p12), base64-encoded |
| `MAC_CERT_PASSWORD` | Password for the .p12 |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Optional. Turns on notarization. |

The Windows installer is unsigned, so SmartScreen shows a warning the first time it runs.

### Locally

```bash
npm run dist:win     # NSIS installer, x64   -> dist/Beam-Setup-x.y.z.exe
npm run dist:mac     # DMG, Apple silicon    (must be built on macOS)
npm run dist:linux   # AppImage + .deb       (build on Linux)
```

## Security design

| Concern | How Beam handles it |
| --- | --- |
| Identity | Each device generates an Ed25519 key pair on first start. The private key never leaves the device and is encrypted at rest with the OS keystore (DPAPI / Keychain / libsecret) through Electron `safeStorage`. |
| Key exchange | Every connection uses fresh X25519 ephemeral keys (forward secrecy). Both sides sign the full handshake transcript (role, both identity keys, both ephemeral keys, names) with their Ed25519 keys (mutual authentication). |
| Encryption | AES-256-GCM. Each direction has its own HKDF-SHA256 key. Nonces are implicit 64-bit counters, so any replayed, reordered, dropped or modified frame fails authentication and the connection is closed. |
| Pairing / MITM | A 6-digit code is derived from the handshake transcript. The initiator first sends a hash commitment to its keys, so an attacker in the middle can't search for colliding codes; each attempt has a one-in-a-million chance. Both users must confirm. After pairing, keys are pinned. |
| Authorization | Devices that aren't paired can only send a pairing request. Everything else is rejected before any data is processed. **Forget** revokes a device immediately. |
| Integrity | Each file is checked with SHA-256 end to end. Files are written to a `.beampart` temp file and only renamed after they verify. |
| Untrusted input | Remote file names are sanitized (no path traversal, no reserved Windows names) and never overwrite existing files. Frame size, text size and file count are all capped, and stalled or unauthenticated connections time out. |
| Discovery | Broadcast beacons contain only a display name, a public fingerprint and a port. They are never trusted: the handshake verifies that the device at an address really has the expected identity. |
| Local data | The activity history (`history.json` in the app's data folder) keeps sent and received **text in plain text** on each device, so you can copy it later. **Activity → Clear** deletes it. This copy stays on your own disk; nothing is stored on the network. |
| Updates | Downloaded over HTTPS from GitHub Releases and checked against the SHA-512 in `latest.yml` before installing. That check catches corruption, but it can't protect against a compromised GitHub account: the hash comes from the same release. Signing the Windows installer adds a publisher check; on macOS, Squirrel only installs updates signed by the same Developer ID as the running app. |
| App hardening | `contextIsolation`, `sandbox`, no `nodeIntegration`, a strict CSP, navigation and new windows blocked. File bytes never cross IPC; the main process streams from disk. |

Wire protocol: see `src/core/handshake.js` (handshake) and `src/core/node.js` (messages).

## Things to know

- **Firewall prompt on first launch.** Windows Defender Firewall and macOS ask whether Beam may accept incoming connections. Allow it on **private** networks. If you click Cancel, the device can still send but can't receive. To fix that, allow Beam in the firewall settings.
- **Ports:** UDP 47811 (discovery) and TCP 47812 (transfers). If 47812 is taken, Beam picks a free port and advertises it.
- **Linux global shortcut:** works on X11. On Wayland, most compositors don't allow apps to grab global shortcuts. Bind a system shortcut to open the Beam window instead, or use the tray icon. *Start at login* is not available on Linux; add Beam to your desktop's autostart instead.
- **Networks with client isolation** (many guest and public Wi-Fi networks) block device-to-device traffic. Beam can't work on them, and that is by design.
- Folders aren't sent directly. Zip them first.
- **Windows notifications** usually don't show when you run from source (`npm start`), because Windows needs a Start-menu shortcut that matches the app ID. They do show once Beam is installed with the installer.

## Development

```bash
npm test               # protocol/crypto/transfer tests (plain Node, no Electron)
npm run test:e2e       # launches two real app instances, pairs them via the UI, sends text + a 20 MiB file
npm run start:second   # run a second instance with its own identity (for testing on one machine)
npm run icons          # regenerate icons
```

`--beam-profile=<dir>` gives an instance its own identity and data, and `--beam-port=<n>` sets its TCP port.

> If `npm start` prints `Cannot read properties of undefined (reading 'setPath')`, your shell has `ELECTRON_RUN_AS_NODE=1` set (some IDEs and tools export it). Unset it and try again.

```
src/core/      networking + crypto, no Electron dependency (tested with node --test)
  identity.js    Ed25519 identities and fingerprints
  handshake.js   authenticated key exchange and the pairing code
  framing.js     length-prefixed frames + AES-GCM channel
  node.js        server/client: pairing, offers, text and file streaming
  discovery.js   UDP broadcast presence
src/main/      Electron main process: tray, global shortcut, windows, IPC, storage
src/preload/   the only bridge between UI and main (contextBridge)
src/renderer/  main window + quick-send popup (plain HTML/CSS/JS)
```
