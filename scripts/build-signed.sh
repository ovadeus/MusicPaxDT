#!/usr/bin/env bash
#
# Build a SIGNED + NOTARIZED + STAPLED universal MUSICPAX DMG.
#
# Signing uses the "Developer ID Application" identity from tauri.conf.json
# (already in the login keychain). Notarization needs YOUR Apple credentials —
# supply them via the environment or a git-ignored .env.notary file (see
# RELEASE.md). This script never prints secret values.
#
# Two credential options (pick one):
#   A) App Store Connect API key (recommended):
#        APPLE_API_ISSUER=<issuer-uuid>
#        APPLE_API_KEY=<key-id>
#        APPLE_API_KEY_PATH=/absolute/path/AuthKey_<key-id>.p8
#   B) Apple ID + app-specific password:
#        APPLE_ID=<your-apple-id-email>
#        APPLE_PASSWORD=<app-specific-password>
#        APPLE_TEAM_ID=PS6476ZWK5
#
set -euo pipefail
cd "$(dirname "$0")/.."

# Load credentials from a git-ignored file if present (keeps secrets out of the
# shell history and the repo). See .env.notary.example.
if [[ -f .env.notary ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env.notary
  set +a
fi

have_api_key=0
have_apple_id=0
[[ -n "${APPLE_API_ISSUER:-}" && -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_KEY_PATH:-}" ]] && have_api_key=1
[[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]] && have_apple_id=1

if [[ "$have_api_key" -eq 0 && "$have_apple_id" -eq 0 ]]; then
  cat >&2 <<'MSG'
✗ No notarization credentials found.

Provide ONE of these sets (in your shell env or a git-ignored .env.notary):

  App Store Connect API key (recommended):
    APPLE_API_ISSUER, APPLE_API_KEY, APPLE_API_KEY_PATH

  Apple ID + app-specific password:
    APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID   (Team ID: PS6476ZWK5)

See RELEASE.md for how to create either one. Without them the app can be
signed but NOT notarized, so other Macs would still warn on first open.
MSG
  exit 1
fi

if [[ "$have_api_key" -eq 1 ]]; then
  echo "→ Notarizing with an App Store Connect API key (key id: ${APPLE_API_KEY})."
else
  echo "→ Notarizing with Apple ID: ${APPLE_ID} (team ${APPLE_TEAM_ID})."
fi

# The in-app updater needs every release signed with the updater key too, or
# installed copies can't verify (and so won't install) the new version.
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  cat >&2 <<'MSG'
✗ TAURI_SIGNING_PRIVATE_KEY is not set, so no updater artifacts would be built
  and installed apps could never update to this release. Add to .env.notary:
    TAURI_SIGNING_PRIVATE_KEY=/absolute/path/to/musicpax-updater.key
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD=
MSG
  exit 1
fi
echo "→ Updater artifacts will be signed (key file: ${TAURI_SIGNING_PRIVATE_KEY})."

echo "→ Building signed + notarized universal DMG (this takes several minutes)…"
npm run tauri build -- --target universal-apple-darwin

DMG="$(/bin/ls -t src-tauri/target/universal-apple-darwin/release/bundle/dmg/*.dmg 2>/dev/null | head -1 || true)"
APP="src-tauri/target/universal-apple-darwin/release/bundle/macos/MUSICPAX.app"

echo
echo "=== Verification ==="
if [[ -d "$APP" ]]; then
  echo "• codesign:"; codesign --verify --deep --strict --verbose=2 "$APP" 2>&1 | sed 's/^/    /' || true
  echo "• Gatekeeper (spctl):"; spctl -a -t exec -vv "$APP" 2>&1 | sed 's/^/    /' || true
fi
if [[ -n "$DMG" ]]; then
  echo "• staple ticket:"; xcrun stapler validate "$DMG" 2>&1 | sed 's/^/    /' || true
  echo "• updater manifest:"
  ./scripts/updater-manifest.sh "${RELEASE_NOTES:-}" 2>&1 | sed 's/^/    /'
  echo
  echo "✓ Done: $DMG"
else
  echo "✗ No DMG found — check the build output above."
  exit 1
fi
