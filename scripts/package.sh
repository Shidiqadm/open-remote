#!/usr/bin/env bash
# Builds the Chrome Web Store upload: dist/open-remote-<version>.zip
#
# The store rejects a manifest with a "key" field (it assigns its own ID), so
# the key used for the fixed development ID is stripped from the packaged copy.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="$ROOT/dist/build"
VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$ROOT/extension/manifest.json")"
ZIP="$ROOT/dist/open-remote-$VERSION.zip"

rm -rf "$BUILD" "$ZIP"
mkdir -p "$BUILD"
rsync -a --exclude '.*' "$ROOT/extension/" "$BUILD/"

python3 - "$BUILD/manifest.json" <<'PY'
import json, sys
path = sys.argv[1]
manifest = json.load(open(path))
manifest.pop("key", None)
json.dump(manifest, open(path, "w"), indent=2)
PY

(cd "$BUILD" && zip -qr -X "$ZIP" .)
rm -rf "$BUILD"
echo "Built $ZIP"
unzip -l "$ZIP"
