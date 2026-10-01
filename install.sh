#!/usr/bin/env bash
# Installs the Open Remote helper (native messaging host) for Chromium-based
# browsers on macOS and Linux.
#
#   ./install.sh                  allow the IDs listed in host/extension-ids.txt
#   ./install.sh <extension-id>…  also allow these extension IDs
#   ./install.sh --uninstall      remove the helper registration
set -euo pipefail

HOST_NAME="io.github.shidiqadm.openremote"
LEGACY_HOST_NAMES=("com.atvremote.host")
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_DIR="$ROOT/host"
LAUNCHER="$HOST_DIR/open-remote-host.sh"

case "$(uname -s)" in
  Darwin)
    BASE="$HOME/Library/Application Support"
    BROWSER_DIRS=(
      "Google/Chrome" "Google/Chrome Beta" "Google/Chrome Canary" "Chromium"
      "BraveSoftware/Brave-Browser" "Microsoft Edge" "Vivaldi" "Arc/User Data"
    )
    ;;
  Linux)
    BASE="${XDG_CONFIG_HOME:-$HOME/.config}"
    BROWSER_DIRS=(
      "google-chrome" "google-chrome-beta" "google-chrome-unstable" "chromium"
      "BraveSoftware/Brave-Browser" "microsoft-edge" "vivaldi"
    )
    ;;
  *)
    echo "Unsupported OS. On Windows run install.ps1 instead." >&2
    exit 1
    ;;
esac

remove_manifests() {
  for dir in "${BROWSER_DIRS[@]}"; do
    for name in "$@"; do
      rm -f "$BASE/$dir/NativeMessagingHosts/$name.json"
    done
  done
}

if [[ "${1:-}" == "--uninstall" ]]; then
  remove_manifests "$HOST_NAME" "${LEGACY_HOST_NAMES[@]}"
  rm -rf "$HOST_DIR/.venv" "$LAUNCHER"
  echo "Helper removed. Pairing keys are kept in your app data folder (OpenRemote); delete it to unpair everything."
  exit 0
fi

# Allowed extension IDs: the list file plus any given on the command line.
EXT_IDS=()
while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%%#*}"
  line="$(echo "$line" | tr -d '[:space:]')"
  [[ -n "$line" ]] && EXT_IDS+=("$line")
done < "$HOST_DIR/extension-ids.txt"
EXT_IDS+=("$@")
if [[ ${#EXT_IDS[@]} -eq 0 ]]; then
  echo "No extension IDs in host/extension-ids.txt or on the command line." >&2
  exit 1
fi
for id in "${EXT_IDS[@]}"; do
  if [[ ! "$id" =~ ^[a-p]{32}$ ]]; then
    echo "Not a valid extension ID: $id" >&2
    exit 1
  fi
done

# Find Python 3.10+.
PYTHON=""
for candidate in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$candidate" >/dev/null 2>&1 &&
     "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
    PYTHON="$(command -v "$candidate")"
    break
  fi
done
if [[ -z "$PYTHON" ]]; then
  echo "Python 3.10 or newer is required." >&2
  echo "macOS: brew install python   ·   Debian/Ubuntu: sudo apt install python3 python3-venv" >&2
  exit 1
fi
echo "Using $PYTHON ($("$PYTHON" --version))"

echo "Creating virtual environment…"
"$PYTHON" -m venv "$HOST_DIR/.venv"
"$HOST_DIR/.venv/bin/python" -m pip install --quiet --upgrade pip
"$HOST_DIR/.venv/bin/python" -m pip install --quiet -r "$HOST_DIR/requirements.txt"

cat > "$LAUNCHER" <<LAUNCH
#!/bin/sh
exec "$HOST_DIR/.venv/bin/python" "$HOST_DIR/open_remote_host.py" "\$@"
LAUNCH
chmod +x "$LAUNCHER"

MANIFEST="$("$HOST_DIR/.venv/bin/python" - "$HOST_NAME" "$LAUNCHER" "${EXT_IDS[@]}" <<'PY'
import json, sys
name, path, *ids = sys.argv[1:]
print(json.dumps({
    "name": name,
    "description": "Open Remote helper for Android TV / Google TV",
    "path": path,
    "type": "stdio",
    "allowed_origins": [f"chrome-extension://{i}/" for i in dict.fromkeys(ids)],
}, indent=2))
PY
)"

remove_manifests "${LEGACY_HOST_NAMES[@]}"
installed=0
for dir in "${BROWSER_DIRS[@]}"; do
  # Always register for Chrome; others only if that browser is present.
  if [[ "$dir" == "Google/Chrome" || "$dir" == "google-chrome" || -d "$BASE/$dir" ]]; then
    mkdir -p "$BASE/$dir/NativeMessagingHosts"
    printf '%s\n' "$MANIFEST" > "$BASE/$dir/NativeMessagingHosts/$HOST_NAME.json"
    echo "Registered for: $dir"
    installed=$((installed + 1))
  fi
done

echo
echo "Done. Helper registered for $installed browser location(s)."
echo "Allowed extension IDs: ${EXT_IDS[*]}"
echo "Note: if you move this folder, run ./install.sh again."
