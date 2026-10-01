# Open Remote

A browser extension that controls any Android TV, Google TV or Chromecast with
Google TV on your Wi-Fi, the same way the Google TV phone app does. It works in
Chrome, Brave, Edge, Arc, Vivaldi and other Chromium browsers.

- Finds TVs on your network automatically, or connects by IP
- One-time pairing with the code shown on the TV
- D-pad, OK, back, home, power, input, settings, Assistant, volume, channel and media keys
- Type into the TV's search box from your keyboard
- One-click app launch (YouTube, Netflix, Prime Video, Disney+, Spotify, Plex)
- Full keyboard control, plus browser-wide shortcuts that work with the popup closed
- Popup or side panel, light and dark themes

## How it works

The TV speaks the **Android TV Remote protocol v2**: TLS with client
certificates on ports 6466 (commands) and 6467 (pairing). Browser extensions
can't open raw TLS sockets, so Open Remote has two parts:

```
extension/  popup + side-panel UI  ──native messaging──▶  host/  helper app  ──TLS──▶  TV
```

The helper uses [`androidtvremote2`](https://github.com/tronikos/androidtvremote2)
(the library behind Home Assistant's Android TV Remote integration) and
`zeroconf` for discovery. It only connects to TVs on your local network and
sends nothing anywhere else.

## Install the helper

Requires Python 3.10 or newer.

1. [Download this repository](https://github.com/Shidiqadm/open-remote/archive/refs/heads/main.zip)
   (or `git clone` it) and put it somewhere permanent. The helper is
   registered by absolute path.
2. Run the installer from that folder:
   - macOS / Linux: `./install.sh`
   - Windows: `powershell -ExecutionPolicy Bypass -File install.ps1`
3. Back in the extension, press **Check again**.

If you move the folder, run the installer again.

## Install the extension

- **From the Chrome Web Store**: coming soon.
- **From source**: open `chrome://extensions`, turn on **Developer mode**,
  click **Load unpacked** and pick the `extension` folder. The development
  build has the fixed ID `pfkkbaibkdbpjhofkgpfhlklpjechffc` (set by the `key`
  in `manifest.json`), which the helper already allows.

## Use

1. Click the toolbar icon (or press **Alt+Shift+R**) and pick your TV.
2. The first time, the TV shows a 6-character code. Type it in to pair.
   Pairing is remembered, and the extension reconnects to the last TV by itself.
3. Use the on-screen remote, or the keyboard (press `?` in the remote for this list):

| Key | Action | Key | Action |
| --- | --- | --- | --- |
| Arrows | D-pad | Enter | OK (hold for long press) |
| Esc / Backspace | Back | H | Home (hold for menu) |
| Space | Play / pause | [ / ] | Rewind / fast-forward |
| , / . | Previous / next | + / − or Shift+↑/↓ | Volume |
| M | Mute | PgUp / PgDn | Channel |
| K | Type on TV | A | Apps |
| 1–6 | Launch app | I / S / G | Input / Settings / Assistant |
| Shift+P | Power | ? | Shortcut list |

### Browser-wide shortcuts

These work without opening the remote. Set a shortcut's scope to **Global** in
`chrome://extensions/shortcuts` to make it work when the browser isn't focused.

| Default | Action |
| --- | --- |
| Alt+Shift+R (⌥⇧R) | Open the remote |
| Alt+Shift+↑ / ↓ | Volume up / down (the new level shows on the toolbar icon) |
| Alt+Shift+Space | Play / pause |

Mute, power, home, back, OK, the D-pad and the media keys can also be bound
there. A red `!` on the toolbar icon means the TV couldn't be reached.

### App shortcuts

Edit the `APPS` list at the top of `extension/remote.js`. An entry can be a
deep link (`https://www.netflix.com/title`) or an Android package name
(`com.spotify.tv.android`).

## Development

- `host/extension-ids.txt` lists the extension IDs the helper accepts. Both
  installers read it.
- `scripts/package.sh` builds `dist/open-remote-<version>.zip` for the Chrome
  Web Store. It strips the development `key` from the manifest.
- Store publishing steps: [PUBLISHING.md](PUBLISHING.md).

## Troubleshooting

- **"Install the helper app" keeps showing.** The helper isn't registered for
  this browser, or the extension's ID isn't allowed. Run
  `./install.sh <your-extension-id>`. You can find the ID on `chrome://extensions`.
- **No TVs found.** The TV must be on the same network, and some routers block
  mDNS between Wi-Fi and Ethernet. Connect by IP instead.
- **Logs**: `host.log` in `~/Library/Application Support/OpenRemote` (macOS),
  `~/.config/OpenRemote` (Linux) or `%APPDATA%\OpenRemote` (Windows). The same
  folder holds the pairing certificate. Delete it to unpair everything.
- **Uninstall**: `./install.sh --uninstall` or `install.ps1 -Uninstall`.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for third-party components.
