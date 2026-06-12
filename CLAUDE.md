# STACK — Project Memory for Claude Code

Local-first, open-source desktop music & entertainment system.
Library/aggregator + DJ tool + vintage-receiver (real line-in). Cross-platform.

## Stack (locked)
Tauri 2 (Rust) + React/TypeScript/Vite. Audio: cpal, symphonia, rubato, rtrb,
lofty. DB: rusqlite (bundled + FTS5). Net: reqwest + tokio. Secrets: keyring.
NOT Electron. NOT Web Audio as the core engine.

## Hard rules (enforce in code)
1. Capability flag on every track: OWNED | STREAM_PLAYABLE | LINK_ONLY.
   - OWNED → decode/mix/record. STREAM_PLAYABLE → play inline only, no DSP/record.
   - LINK_ONLY → open externally. The mixer MUST reject non-OWNED tracks.
2. No DRM circumvention. No Spotify audio. YouTube = official IFrame embed only.
   No yt-dlp / downloading in the core, ever.
3. Local-first: full offline function for OWNED content.
4. Pluggable: SourceAdapter trait for sources, LLMProvider trait for AI. Core is
   vendor-agnostic.

## Architecture
Frontend (React) ⇄ Tauri IPC ⇄ Rust core.
Rust modules: audio/ (engine, decode, meters, later: mixer, input, riaa,
resample), library/ (db, model, scan), sources/ (adapter trait + per-source),
ai/ (LLMProvider trait + anthropic/openai/ollama + mirror engine).
Frontend: HiFi (receiver) mode and DJ mode share one library table. All Tauri
calls go through src/lib/ipc.ts.

## Realtime audio rules
Audio callback is allocation-free and lock-free. Decode on a worker thread, hand
PCM to the audio thread via rtrb. No unwrap() in non-test paths; Result +
thiserror.

## External services (when implemented)
- Identification: Chromaprint → AcoustID → MusicBrainz (NOT the LLM). LLM only
  for tag cleanup, genre/mood, NL search, set-building, match-ranking.
- Mirror Engine: list (Spotify URL / Apple link / text / CSV) → YouTube Data API
  v3 search (user's key) → LLM picks best match (prefer official-audio/"Topic"
  channels, match duration ±few s) → store as STREAM_PLAYABLE YouTube embed.
  Handle embed-disabled/region/age by falling back to next match or LINK_ONLY;
  re-resolve dead videos.
- LLM: Anthropic Messages API (https://api.anthropic.com/v1/messages), OpenAI,
  or Ollama (http://localhost:11434). Model is user-configurable; see
  https://docs.claude.com/en/api for current Anthropic model IDs. Keys in OS
  keychain via keyring, never plaintext. Try free fingerprint/MusicBrainz before
  any paid LLM call; show cost estimate and a spend cap for cloud providers.

## Roadmap (build in order; one milestone per focused session)
- M1  Local playback: import + library + play + VU meter.  ✅ done (2026-06-12)
- M2  Receiver/stereo-stack: line-in capture (turntable/cassette/CD/aux),  ✅ done (2026-06-12)
      RIAA EQ toggle, tone stack, source routing, recording of OWNED sources.
- M3  Internet radio + podcasts/RSS + CC catalogs (Bandcamp/FMA/Jamendo).  ← next
- M4  DJ mode: dual decks, crossfader, EQ, tempo, hot cues, loops; BPM/key.
- M5  AI subsystem (Anthropic/OpenAI/Ollama) + fingerprint pipeline + Mirror
      Engine + embedded YouTube playback lane.
- M6  SoundCloud (browse/link), AV capture (DVD/movies), MIDI/HID controllers,
      plugin SDK, theme marketplace.

## Build notes
- Cargo.lock pins transitive `time` to 0.3.47. time 0.3.48 (2026-06-12) breaks
  tauri-utils/cookie with E0119 coherence errors on stable Rust. If a lockfile
  regen breaks the build there: `cargo update time --precise 0.3.47`.
- Run `cargo test -- --include-ignored` for the live audio tests (needs an
  output device); plain `cargo test` skips them.

## License
GPLv3 or MPL-2.0 (decide before adding copyleft-incompatible deps). Honor
attribution for SoundCloud, MusicBrainz, AcoustID, Cover Art Archive.