#!/usr/bin/env bash
#
# Write the tauri-plugin-updater manifest (latest.json) next to the updater
# artifacts a signed build produces. Installed apps fetch this file from the
# latest GitHub release to learn that a newer version exists, where to get it,
# and the signature to verify it against.
#
#   scripts/updater-manifest.sh ["release notes"]
#
# Requires a build made with TAURI_SIGNING_PRIVATE_KEY set (see RELEASE.md);
# without it Tauri produces no .tar.gz/.sig and installed apps can't update.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
DIR="src-tauri/target/universal-apple-darwin/release/bundle/macos"
TAR="$DIR/MUSICPAX.app.tar.gz"
SIG="$TAR.sig"
OUT="$DIR/latest.json"
NOTES="${1:-MUSICPAX $VERSION}"
URL="https://github.com/ovadeus/MusicPaxDT/releases/download/v$VERSION/MUSICPAX.app.tar.gz"

if [[ ! -f "$TAR" || ! -f "$SIG" ]]; then
  echo "✗ No updater artifacts in $DIR — was TAURI_SIGNING_PRIVATE_KEY set for the build?" >&2
  exit 1
fi

# One universal artifact serves every Mac; the updater looks up the running
# machine's own target key, so list it under all three.
python3 - "$VERSION" "$SIG" "$URL" "$NOTES" "$OUT" <<'PY'
import datetime, json, sys
version, sig_path, url, notes, out = sys.argv[1:]
entry = {"signature": open(sig_path).read().strip(), "url": url}
manifest = {
    "version": version,
    "notes": notes,
    "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "platforms": {k: entry for k in ("darwin-universal", "darwin-aarch64", "darwin-x86_64")},
}
with open(out, "w") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
PY

echo "✓ $OUT"
echo "  Release assets to upload with the DMG:"
echo "    $TAR"
echo "    $SIG"
echo "    $OUT"
