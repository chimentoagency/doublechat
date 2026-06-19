# DoubleChat

A local LAN video call app built for body doubling — staying focused by working alongside someone else in a shared virtual presence. No accounts, no third-party servers, no data leaving your network.

## How it works

One person acts as the **host** and runs the signaling server embedded in the app. The other person **joins** by entering the host's local IP address. Once connected, audio and video travel directly between the two devices over your LAN via WebRTC.

## Features

- Peer-to-peer video and audio — nothing routed through external servers
- Pop-out floating window (Document PiP) that stays on top of other windows
- Always-on-top toggle for the main window
- Mute mic and stop video controls
- Auto-update: new releases install silently in the background

## Requirements

- Windows 10 or 11
- Both computers on the same local network
- A Chromium-based browser engine (Edge/WebView2 — pre-installed on Windows 10/11)

## Installation

Download the latest installer from the [Releases](../../releases/latest) page and run it. Future updates install automatically.

## Usage

1. **Host**: open DoubleChat and click **I'm the Host**. The app shows your LAN address (e.g. `192.168.1.5:3717`).
2. **Guest**: open DoubleChat, click **I'm Joining**, and enter the host's address.
3. The call starts automatically once both are connected.

The host's address only works on the same local network.

## Building from source

**Prerequisites**

- [Node.js](https://nodejs.org) (LTS)
- [Rust](https://rustup.rs)

```
git clone https://github.com/chimentoagency/doublechat.git
cd doublechat
npm install
npm run generate-icons
npm run tauri build
```

The installer is output to `src-tauri/target/release/bundle/nsis/`.

## Releasing an update

Push a version tag and GitHub Actions handles the rest:

```
git tag v1.x.x
git push origin v1.x.x
```

The workflow builds the Windows installer, publishes a GitHub Release, and uploads the update manifest. Both running installs pick it up automatically.

## License

MIT License with Commons Clause — free to use, modify, and distribute. Selling this software or a service derived primarily from it is not permitted. See [LICENSE](LICENSE) for full terms.
