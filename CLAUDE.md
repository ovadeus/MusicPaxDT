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
ai/ (LLMProvider trait + anthropic/openai/gemini/ollama + mirror engine).
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
  Google Gemini (generativelanguage.googleapis.com, key in the x-goog-api-key
  header), or Ollama (http://localhost:11434). Model is user-configurable; see
  https://docs.claude.com/en/api for current Anthropic model IDs. Keys in OS
  keychain via keyring, never plaintext. Try free fingerprint/MusicBrainz before
  any paid LLM call; show cost estimate and a spend cap for cloud providers.

## Roadmap (build in order; one milestone per focused session)
- M1  Local playback: import + library + play + VU meter.  ✅ done (2026-06-12)
- M2  Receiver/stereo-stack: line-in capture (turntable/cassette/CD/aux),  ✅ done (2026-06-12)
      RIAA EQ toggle, tone stack, source routing, recording of OWNED sources.
- M3  Internet radio (Radio Browser) ✅ done (2026-06-13) — browse/search +
      inline STREAM_PLAYABLE playback via webview <audio> + add-to-library.
- M3b Direct streams ✅ done (2026-06-13) — "Stream" source: paste any direct
      audio/video URL (Archive.org etc.) → import_direct_stream validates by
      extension (else HEAD content-type), STREAM_PLAYABLE source_kind="stream",
      music-note icon. Plays inline via DirectStreamPlayer (<video> for audio+
      video; seekable, real VU when CORS allows). Still to do: podcasts/RSS + CC
      catalogs (Bandcamp/FMA/Jamendo).
- M5a (pulled forward 2026-06-12 by owner): YouTube embed lane + Mirror Engine
      v1 (Spotify playlist / text list → official YouTube embeds, heuristic
      matching, keyless search fallback) + playlists mixing OWNED and
      STREAM_PLAYABLE + Integrations settings (keyring). LLM match-ranking
      still lands with M5.
- M-live Go Live broadcaster ✅ done (2026-06-13) — Icecast2 SOURCE client
      (audio/broadcast.rs) that tees the engine's unified output mix (post-volume
      stereo in build_stream_for), MP3-encodes (reuses sinks::build_mp3_encoder),
      and streams to Radio King / any Icecast mount. Survives track changes (worker
      drains whichever bcast_cons is registered) and pads idle/underrun with
      silence to keep the connection alive. Only OWNED + line-in air; STREAM_PLAYABLE
      (YouTube/radio) is in the webview, never in the tee. Creds: live.* in settings,
      source password in keychain (radioking_source_password). Recommended setup:
      RØDECaster mixes mic+music in hardware → its program is the aux/line-in source.
      TODO: Shoutcast handshake, AAC/Ogg, Radio King stats API (listeners/metadata).
      Live Media (2026-09-13): the on-air list is one user-chosen local folder
      (setting live.media_dir; commands live_media_dir/set_live_media_dir/
      rescan_live_media/list_live_media). A "Live" source shows exactly the OWNED
      tracks under it (db::list_tracks_under, exact prefix — not LIKE). Files join
      the main library as normal OWNED tracks; the Live view is a filtered query.
      Deliberately a hard line, not per-track airability: streaming sources' terms
      forbid re-broadcasting, so aggregated playlists are never in the live view.
      Go Live is an inline accordion under the header (not a modal).
- M5b AI playlist builder ✅ done (2026-09-10) — third top-bar quick-add button
      (YouTube / Spotify / AI) opens BuildPlaylistWithAIModal ("Build Playlist
      With a Text Prompt", track count 1–50, default 25). ai_build_playlist
      (commands/streams.rs) has the configured LlmProvider draft {name, tracks}
      via ai::suggest_playlist, then runs the shared mirror_listed_tracks loop —
      the same youtube::channel_authority ranking (Topic / official artist /
      VEVO first) and mirror-progress events as a pasted Spotify list. Gemini
      added as a fourth LlmProvider (gemini_api_key in keychain, default
      gemini-2.5-flash); provider, model and key are the existing Settings →
      Integrations → AI provider controls, shared with cleanup and the Assistant.
- M4  DJ mode: dual decks, crossfader, EQ, tempo, hot cues, loops; BPM/key.
- M5  AI subsystem (Anthropic/OpenAI/Ollama) + fingerprint pipeline + Mirror
      Engine + embedded YouTube playback lane.
- M6  SoundCloud (browse/link), AV capture (DVD/movies), MIDI/HID controllers,
      plugin SDK, theme marketplace.

## Build notes
- Every new #[tauri::command] MUST also be listed in
  src-tauri/permissions/default.toml. The release UI is served from
  http://localhost (YouTube embeds need an HTTP referrer), which Tauri's ACL
  treats as remote — unlisted commands fail with "not allowed. Plugin not
  found".
- Metadata enrichment (ai/, enrich/, sources/musicbrainz.rs) runs free→paid:
  MusicBrainz text → Chromaprint(fpcalc)+AcoustID → LLM(cleanup)→MusicBrainz
  confirm. Keys (AcoustID, Anthropic/OpenAI/Gemini) in keychain via net::keyring_*.
  fpcalc is an external binary resolved from settings→PATH→known paths (incl.
  Picard); bundle it as a Tauri sidecar for distribution. LLM spend is capped
  per batch (enrich.spend_cap_usd, default $1); free tiers ignore the cap.
  Network/keychain unit tests are #[ignore]; run with --include-ignored.
- Cargo.lock pins transitive `time` to 0.3.47. time 0.3.48 (2026-06-12) breaks
  tauri-utils/cookie with E0119 coherence errors on stable Rust. If a lockfile
  regen breaks the build there: `cargo update time --precise 0.3.47`.
- Run `cargo test -- --include-ignored` for the live audio tests (needs an
  output device); plain `cargo test` skips them.

## .mpx import
- MusicPax `.mpx` playlist files are plain UTF-8 JSON (current export). Parser
  is sources/mpx.rs; import_mpx_playlist command maps tracks → STREAM_PLAYABLE
  (youtube) / LINK_ONLY (spotify, soundcloud) library rows + a new playlist,
  sorted by position, deduped by URL within the import. Legacy AES `.mpx`
  (magic `MPAX`) is detected and reported, not decrypted (would need aes/md5
  deps — ask before adding).

## License
GPLv3 or MPL-2.0 (decide before adding copyleft-incompatible deps). Honor
attribution for SoundCloud, MusicBrainz, AcoustID, Cover Art Archive.