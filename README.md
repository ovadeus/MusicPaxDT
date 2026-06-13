# STACK

A local-first, open-source music & entertainment system — part library/aggregator,
part DJ tool, part vintage receiver. Cross-platform (Windows, macOS, Linux) on
Tauri 2 with a Rust audio backend.

**Status: Milestone 2** — local library with import, search, and decoded
playback, plus the receiver stage: line-in capture (phono/tape/CD/aux) with
RIAA de-emphasis, a bass/treble tone stack, per-source input routing, and
recording of your own line-in signal straight into the library.

## The capability rule

Every track carries a capability flag, enforced in the engine — not just the UI:

| Flag | Meaning | Allowed |
|---|---|---|
| `OWNED` | Local files, line-in, ripped CDs, CC catalogs | decode, mix, record |
| `STREAM_PLAYABLE` | Internet radio, YouTube embeds | inline playback only — no DSP, no recording |
| `LINK_ONLY` | Sources that won't embed | open externally / preview |

The audio engine refuses to load a non-`OWNED` track into a playback deck
(`EngineHandle::load` returns a capability-gate error). There is no DRM
circumvention anywhere in this codebase, ever: no stream ripping, no audio
capture from other apps, no downloaders.

## Stack

- **Shell:** [Tauri 2](https://tauri.app) (Rust backend + system webview)
- **Frontend:** React + TypeScript + Vite (strict mode; all IPC through `src/lib/ipc.ts`)
- **Audio I/O:** [cpal](https://crates.io/crates/cpal) · **Decode:** [symphonia](https://crates.io/crates/symphonia) · **Resample:** [rubato](https://crates.io/crates/rubato) · **RT buffer:** [rtrb](https://crates.io/crates/rtrb)
- **Tags:** [lofty](https://crates.io/crates/lofty) · **DB:** [rusqlite](https://crates.io/crates/rusqlite) (bundled SQLite + FTS5)
- **Recording encoders:** [mp3lame-encoder](https://crates.io/crates/mp3lame-encoder) (LAME, LGPL) · [flacenc](https://crates.io/crates/flacenc) (pure Rust)

The realtime audio callback is allocation-free and lock-free: a decode thread
feeds f32 PCM through an rtrb ring buffer; the callback only pops samples and
touches atomics (volume, position, peak/RMS meters).

## Build & run

Prerequisites: [Rust](https://rustup.rs) (stable), [Node.js](https://nodejs.org) ≥ 20,
and the [Tauri 2 platform prerequisites](https://tauri.app/start/prerequisites/)
(Xcode CLT on macOS; WebView2 on Windows; webkit2gtk on Linux).

```sh
npm install
npm run tauri dev      # development app
npm run tauri build    # release bundle
```

Tests (the playback test plays a quiet 2-second tone and needs an output device):

```sh
cd src-tauri
cargo test                            # unit tests
cargo test -- --include-ignored       # + live audio pipeline test
cargo clippy --all-targets            # lints (clean)
```

First launch creates the SQLite library (with FTS5 full-text index) under the
per-user app-data directory, e.g. `~/Library/Application Support/org.stack.app/stack.db`
on macOS. Click **Import Folder** to scan a directory recursively; tags are read
with lofty, untagged files fall back to their file name, and re-imports dedupe
by file path. Double-click a track to play it.

> **macOS:** the first time you select a line-in source, macOS asks for
> microphone (audio-input) permission — capture is silent until you allow it.
> If you denied it, re-enable under System Settings → Privacy & Security →
> Microphone.

> **Note:** `Cargo.lock` pins the transitive `time` crate to 0.3.47.
> `time` 0.3.48 (2026-06-12) trips an E0119 coherence error in `tauri-utils`
> and `cookie` on current stable Rust. If you regenerate the lockfile and the
> build breaks there, re-pin: `cargo update time --precise 0.3.47`.

## Milestone 1 scope

- ✅ Library: recursive folder import, lofty tag reading, dedupe by uri
- ✅ Search (SQLite FTS5, prefix matching) and sortable columns
- ✅ Capability icon on every track row; engine-level OWNED-only gate
- ✅ Playback: symphonia decode → rubato resample → rtrb → cpal, with
  play/pause/stop/seek/volume and safe mid-session output-device switching
- ✅ Real peak/RMS VU meters driven by engine events (`vu-levels`, `position`,
  `playback-state`)

## Milestone 2 scope (receiver)

- ✅ Line-in monitoring: cpal input stream → relay thread (DSP + resample) →
  the same lock-free output path; Phono/Tape/CD/Aux source buttons are live
- ✅ RIAA de-emphasis for turntables without a phono preamp — bilinear-mapped
  75/318/3180 µs curve with a per-rate optimized correction zero (≤ ~0.3 dB
  error across 20 Hz – 20 kHz); engages automatically on Phono, toggleable
- ✅ Tone stack: ±12 dB bass (120 Hz) and treble (8 kHz) RBJ shelves, applied
  live without interrupting the stream
- ✅ Source routing: each receiver input remembers its capture device
  (persisted in settings)
- ✅ Recording: the post-DSP, pre-volume signal is teed to a recorder thread
  at the input's native rate; stopping inserts the file into the library as
  an OWNED `line_in` track
- ✅ Recording formats (Settings → Recording): **MP3** (128–320 kbps CBR, via
  LAME), **WAV** (16/24-bit PCM or 32-bit float), **AIFF** (16/24-bit), and
  **FLAC** (16/24-bit). Notes: MP3 takes inputs up to 48 kHz; FLAC encodes
  when you stop, so it suits takes up to roughly a vinyl side
- ✅ Settings area (gear icon): app-wide key-value settings persisted in the
  library DB — recording format/quality now, more sections in later
  milestones
- ✅ VU meters, transport, and volume work identically for live input

Later milestones: internet radio, DJ decks & mixer, YouTube embeds (official
IFrame player only), AI integrations — all behind the same `SourceAdapter`
trait and capability gate.

## Repository layout

```
src/                  React/TS frontend (lib/ipc.ts is the only invoke() surface)
src-tauri/src/
  commands.rs         Tauri command handlers (IPC surface)
  audio/              engine (cpal host thread), decode (symphonia), meters,
                      input (line-in capture + recorder), riaa (RIAA + tone DSP)
  library/            db (rusqlite + FTS5 migrations), model, scan (walkdir + lofty)
  sources/            SourceAdapter trait + Local files adapter
```
