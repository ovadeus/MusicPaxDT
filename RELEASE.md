# Releasing MUSICPAX (signed + notarized universal DMG)

The app is configured to build a **universal** (Intel + Apple Silicon), **signed**,
and **notarized** DMG that opens with **no Gatekeeper warnings** on any Mac.

## What's already wired up (in the repo)

- `src-tauri/tauri.conf.json` → `bundle.macOS`: Developer ID signing identity
  (`Developer ID Application: David Meyers (PS6476ZWK5)`), Hardened Runtime,
  entitlements, min macOS 10.15.
- `src-tauri/entitlements.plist`: Hardened-Runtime microphone/line-in entitlement.
- `scripts/build-signed.sh`: one command to build + sign + notarize + staple, then
  verify.

The **signing certificate** is already in the login keychain. You only need to
supply **notarization credentials** once — these are secrets, so they live in a
git-ignored `.env.notary` (never committed).

## One-time: create a notarization credential

Pick **one** (Option B is fastest):

### Option A — App Store Connect API key (best for automation)
1. App Store Connect → **Users and Access → Integrations → App Store Connect API**.
2. Generate a **Team key** with the **Developer** role (accept the API terms if
   prompted). Name it e.g. `MUSICPAX Notary`.
3. **Download the `.p8` once** and note the **Key ID** and **Issuer ID**.
4. Move the file somewhere safe, e.g. `~/.appstoreconnect/AuthKey_<KEYID>.p8`.

### Option B — Apple ID + app-specific password (simplest)
1. [appleid.apple.com](https://appleid.apple.com) → **Sign-In & Security →
   App-Specific Passwords** → **+** → name it `MUSICPAX notarization`.
2. Copy the generated password (looks like `abcd-efgh-ijkl-mnop`).

## One-time: create `.env.notary`

    cp .env.notary.example .env.notary

Edit `.env.notary` and fill in the option you chose (Team ID is `PS6476ZWK5`).
This file is git-ignored.

## Build

    ./scripts/build-signed.sh

Output: `src-tauri/target/universal-apple-darwin/release/bundle/dmg/MUSICPAX_<version>_universal.dmg`

The script verifies the signature, Gatekeeper assessment, and the stapled ticket.
Notarization typically adds 1–5 minutes while Apple processes the upload.

## Distributing

Testers just open the DMG and drag the app to Applications — **no `xattr` step
needed** once the build is notarized. To cut a new version, bump `version` in
`package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`.

## In-app updates

Installed copies check the latest GitHub release for `latest.json`, download
and verify the new build in the background, then show a "Relaunch to update"
card. For that to work every release needs, alongside the DMG:

    MUSICPAX.app.tar.gz        the update itself (signed + notarized app inside)
    MUSICPAX.app.tar.gz.sig    its updater signature
    latest.json                version, notes, download URL, signature

`./scripts/build-signed.sh` produces all three (it refuses to build without
`TAURI_SIGNING_PRIVATE_KEY` in `.env.notary`, because a release without them
strands every installed copy). Set `RELEASE_NOTES` to put notes in the card.
Then upload everything together:

    gh release create vX.Y.Z \
      src-tauri/target/universal-apple-darwin/release/bundle/dmg/MUSICPAX_X.Y.Z_universal.dmg \
      src-tauri/target/universal-apple-darwin/release/bundle/macos/MUSICPAX.app.tar.gz \
      src-tauri/target/universal-apple-darwin/release/bundle/macos/MUSICPAX.app.tar.gz.sig \
      src-tauri/target/universal-apple-darwin/release/bundle/macos/latest.json \
      --title "MUSICPAX X.Y.Z" --notes "..."

**Publish as a full release, not a prerelease.** The updater fetches
`releases/latest/download/latest.json`, and GitHub's `latest` skips prereleases.

The private key lives outside the repo (`~/.tauri/musicpax-updater.key`).
Back it up: if it is lost, no installed copy can ever update again.
