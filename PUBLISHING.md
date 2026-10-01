# Chrome Web Store publishing checklist

Tracks what's needed to publish Open Remote. Items marked **(blocker)** will
cause a rejection or a broken install for store users if skipped.

## Done

- [x] Neutral product name, "Open Remote". The TV brands appear only in the
      description, plus a non-affiliation note in `NOTICE`.
- [x] Store packages are built without the manifest `key`: run `scripts/package.sh`
      and upload `dist/open-remote-<version>.zip`.
- [x] Allowed extension IDs live in one file, `host/extension-ids.txt`, read by
      both installers.
- [x] The setup screen links to the helper install instructions instead of a
      local folder.
- [x] `homepage_url`, `LICENSE` (MIT) and `NOTICE` (third-party credits).
- [x] Manifest summary is 116 characters (limit 132).
- [x] Permissions kept to the minimum: `nativeMessaging`, `storage`, `sidePanel`.
- [x] `minimum_chrome_version` 116, which `chrome.sidePanel.open` needs.
- [x] Code review fixes: UI port reconnects after the service worker stops;
      the helper serializes connect/disconnect/pairing; the private key is
      `0600` in a `0700` folder; installers fail loudly; Caps Lock can't
      trigger power.

## 1. Developer account

- [ ] Register at the Chrome Web Store Developer Dashboard (one-time $5 fee).
- [ ] Turn on 2-Step Verification on the Google account (required to publish).
- [ ] Verify the contact email.
- [ ] Complete the trader / non-trader declaration (EU Digital Services Act).
      Traders must show an address and phone number publicly.

## 2. First upload → store ID (blocker)

- [ ] Run `scripts/package.sh` and upload the zip as a new item. Don't submit
      for review yet; uploading is enough to get the ID.
- [ ] Copy the store-assigned extension ID from the dashboard into
      `host/extension-ids.txt`, then commit and push. Without this the store
      build can't reach the helper.
- [ ] Copy the item's **public key** (Package tab → "View public key") into
      the `key` field of `extension/manifest.json`. The unpacked dev build
      then has the same ID as the store build, and you can drop the old dev ID
      from `host/extension-ids.txt`.
- [ ] Re-run `./install.sh` locally and test the store build (install it from
      the dashboard's test or unlisted link).

## 3. Helper distribution (biggest gap)

Store users must install the helper separately. Today that means downloading
the repo, having Python 3.10+ and running a script. That's fine for a beta,
too much friction for a public launch.

- [ ] Publish GitHub Releases. Even a plain source zip with versioned notes is better than `main.zip`.
- [ ] Build standalone helper binaries with PyInstaller, so users don't need
      Python (macOS arm64 + x64, Windows x64, Linux x64). The `zeroconf`
      dependency is LGPL: bundling it is fine, but keep its license text and
      note how to swap it in the release.
- [ ] macOS: a `.pkg` installer that writes the native-messaging manifests,
      signed with a Developer ID and notarized. That needs the Apple Developer
      Program ($99/year); without it, Gatekeeper blocks the installer.
- [ ] Windows: an `.exe` or `.msi` installer (e.g. Inno Setup) that writes the
      registry keys. Sign it with an Authenticode certificate, or SmartScreen
      will warn.
- [ ] Point the "Get the helper" button in `extension/remote.html` at the
      Releases page, ideally picking the user's OS.
- [ ] Optional: make the extension check the helper's `hello` version and
      prompt the user to update.

## 4. Store listing assets

- [ ] Detailed description: what it does, supported devices (Android TV,
      Google TV, Chromecast with Google TV, Mi Box, Shield…), and **that a
      helper app is required**, with its link. Saying this up front avoids a
      "misleading functionality" rejection.
- [ ] Category: Tools. Language: English.
- [ ] Store icon: 128×128 PNG (`extension/icons/icon128.png`). Check the
      artwork is about 96×96 with transparent padding, and consider a cleaner
      final icon.
- [ ] Screenshots: 1–5 at **1280×800** (or 640×400). Suggested set: remote
      (dark), remote (light), device picker, pairing screen, shortcuts sheet.
- [ ] Small promo tile: 440×280.
- [ ] Optional: marquee tile 1400×560, YouTube demo video.
- [ ] Support URL: https://github.com/Shidiqadm/open-remote/issues

## 5. Privacy tab

- [ ] Single purpose: "Control Android TV / Google TV devices on the user's
      local network from the browser."
- [ ] Permission justifications:
  - [ ] `nativeMessaging`: talks to the companion helper, which sends remote
        commands to the TV over the local network. Browsers can't open the TLS
        sockets the TV protocol requires.
  - [ ] `storage`: remembers the user's TVs (name + local IP) and the last
        connected TV.
  - [ ] `sidePanel`: lets the remote stay open in the side panel while browsing.
- [ ] Remote code: **No**.
- [ ] Data usage: no data collected or transmitted off the device. Tick no
      categories, then complete the three certifications.
- [ ] Privacy policy: host a one-page policy (e.g. `docs/privacy.md` via
      GitHub Pages) stating the above, and add the URL. Reviewers often ask
      for one on `nativeMessaging` extensions.

## 6. Distribution and review

- [ ] Visibility: **Unlisted** for a beta, then Public. Regions: all. Price: free.
- [ ] Submit for review. Expect a few days; `nativeMessaging` usually gets a
      manual review.
- [ ] If rejected, fix whatever the email cites. The usual causes are a
      missing helper disclosure, vague permission justifications, and
      trademark use.

## 7. After publishing

- [ ] Update the README's "Install the extension" section with the store link.
- [ ] Optional: publish to Microsoft Edge Add-ons (free, same zip) and add
      Edge's assigned ID to `host/extension-ids.txt`.
- [ ] For each release: bump `version` in `extension/manifest.json`, run
      `scripts/package.sh`, upload, submit.
