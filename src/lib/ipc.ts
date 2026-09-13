// The only place the app talks to Tauri. Components import from here —
// never call invoke() directly.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AudioDevice,
  EngineStatus,
  ApprovedEdit,
  EnrichIntegrationStatus,
  EnrichProgress,
  EnrichProposeReport,
  FolderInfo,
  ImportResult,
  IntegrationStatus,
  LineInSource,
  MetadataSuggestion,
  MirrorProgress,
  MirrorReport,
  NowPlaying,
  PlaybackState,
  PlaylistInfo,
  RadioStation,
  RecordingState,
  SortSpec,
  Track,
  VuLevels,
} from "./types";

export function importFolder(path: string): Promise<ImportResult> {
  return invoke<ImportResult>("import_folder", { path });
}

export function listTracks(opts: {
  query?: string;
  sort?: SortSpec;
  limit?: number;
  offset?: number;
  mediaType?: string | null;
}): Promise<Track[]> {
  return invoke<Track[]>("list_tracks", {
    query: opts.query || null,
    sort: opts.sort ? `${opts.sort.field}:${opts.sort.dir}` : null,
    limit: opts.limit ?? null,
    offset: opts.offset ?? null,
    mediaType: opts.mediaType ?? null,
  });
}

/// Ids of local-file tracks whose file is no longer on disk.
export function checkMissingFiles(): Promise<number[]> {
  return invoke<number[]>("check_missing_files");
}

/// Repoint a track to a relocated file.
export function relinkTrack(trackId: number, newPath: string): Promise<Track> {
  return invoke<Track>("relink_track", { trackId, newPath });
}

export function updateTrackMetadata(
  trackId: number,
  fields: {
    title: string | null;
    artist: string | null;
    album: string | null;
    year: number | null;
    genre: string | null;
    mediaType?: string | null;
    /// Swap the source URI (STREAM_PLAYABLE YouTube only). Omit/blank to leave
    /// it unchanged; validated + normalized server-side.
    uri?: string | null;
  },
): Promise<Track> {
  return invoke<Track>("update_track_metadata", { trackId, ...fields });
}

/// Favorite / unfavorite a track (heart toggle). Stored as rating >= 1.
export function setTrackFavorite(trackId: number, favorite: boolean): Promise<void> {
  return invoke<void>("set_track_favorite", { trackId, favorite });
}

export function deleteTrack(trackId: number): Promise<void> {
  return invoke<void>("delete_track", { trackId });
}

/// Bulk-delete tracks from the library in one transaction. Returns the number
/// of rows actually removed. Audio files on disk are not touched.
export function deleteTracks(trackIds: number[]): Promise<number> {
  return invoke<number>("delete_tracks", { trackIds });
}

export function readImageDataUrl(path: string): Promise<string> {
  return invoke<string>("read_image_data_url", { path });
}

export interface ArtistBio {
  extract: string;
  thumbnail: string | null;
  url: string | null;
  title: string;
}

export function artistBio(artist: string): Promise<ArtistBio | null> {
  return invoke<ArtistBio | null>("artist_bio", { artist });
}

/// Curator override for an artist's bio. Empty `extract` clears it (reverts to
/// the Wikipedia summary).
export function setArtistBio(artist: string, extract: string): Promise<void> {
  return invoke<void>("set_artist_bio", { artist, extract });
}

export function getAudioDevices(): Promise<AudioDevice[]> {
  return invoke<AudioDevice[]>("get_audio_devices");
}

export function setOutputDevice(id: string): Promise<void> {
  return invoke<void>("set_output_device", { id });
}

export function loadTrack(trackId: number): Promise<void> {
  return invoke<void>("load_track", { trackId });
}

export function recordPlay(trackId: number): Promise<void> {
  return invoke<void>("record_play", { trackId });
}

export function play(): Promise<void> {
  return invoke<void>("play");
}

export function pause(): Promise<void> {
  return invoke<void>("pause");
}

export function stop(): Promise<void> {
  return invoke<void>("stop");
}

export function seek(positionMs: number): Promise<void> {
  return invoke<void>("seek", { positionMs: Math.max(0, Math.round(positionMs)) });
}

export function setVolume(level: number): Promise<void> {
  return invoke<void>("set_volume", { level });
}

export function nowPlaying(): Promise<NowPlaying | null> {
  return invoke<NowPlaying | null>("now_playing");
}

// --- receiver: line-in sources, DSP, recording ---------------------------

export function getAudioInputDevices(): Promise<AudioDevice[]> {
  return invoke<AudioDevice[]>("get_audio_input_devices");
}

export function startLineIn(
  source: LineInSource,
  inputDevice?: string,
): Promise<EngineStatus> {
  return invoke<EngineStatus>("start_line_in", {
    source,
    inputDevice: inputDevice ?? null,
  });
}

export function setInputDevice(
  source: LineInSource,
  deviceId: string,
): Promise<EngineStatus> {
  return invoke<EngineStatus>("set_input_device", { source, deviceId });
}

export function setRiaa(on: boolean): Promise<EngineStatus> {
  return invoke<EngineStatus>("set_riaa", { on });
}

export function setTone(bassDb: number, trebleDb: number): Promise<EngineStatus> {
  return invoke<EngineStatus>("set_tone", { bassDb, trebleDb });
}

export function setInputGain(db: number): Promise<EngineStatus> {
  return invoke<EngineStatus>("set_input_gain", { db });
}

/// MusicPax public feed (musicpax.com) — read-only metadata, infinite scroll.
export interface FeedItem {
  id: number;
  title: string | null;
  artist: string | null;
  album: string | null;
  year: string | null;
  sourceType: string | null;
  sourceUrl: string | null;
  streamUrl: string | null;
  thumbnail: string | null;
  coverImage: string | null;
  duration: number | null;
  category: string | null;
  dateAdded: string | null;
  playCount: number | null;
  username: string | null;
}

export interface FeedPage {
  data: FeedItem[];
  pagination: {
    currentPage: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
}

export function musicPaxFeed(
  page: number,
  limit: number,
  category: string | null,
): Promise<FeedPage> {
  return invoke<FeedPage>("musicpax_feed", { page, limit, category: category ?? null });
}

/// The three player sizes: the full app, the floating mini card, and the
/// super-compact micro bar. Mini and micro are always-on-top and fixed-size.
export type WindowSize = "full" | "mini" | "micro";

/// Resize the window to one of the player sizes.
export function setWindowSize(size: WindowSize): Promise<void> {
  return invoke<void>("set_window_size", { size });
}

/// Toggle the engine's visualizer audio tap (emits `audio-spectrum` while on).
export function setVisualizer(active: boolean): Promise<void> {
  return invoke<void>("set_visualizer", { active });
}

/// Real per-band spectrum of the engine output mix (OWNED / line-in audio).
export function onAudioSpectrum(cb: (bands: number[]) => void): Promise<UnlistenFn> {
  return listen<number[]>("audio-spectrum", (e) => cb(e.payload));
}

/// Capture a system-audio loopback input device for the visualizer (so YouTube
/// and anything else on the machine can be visualized). Emits `audio-spectrum`.
export function startVizCapture(device: string | null): Promise<void> {
  return invoke<void>("start_viz_capture", { device: device ?? null });
}

export function stopVizCapture(): Promise<void> {
  return invoke<void>("stop_viz_capture");
}

/// No-install system-audio capture via ScreenCaptureKit (macOS 13+). Rejects
/// with a permission message if Screen Recording isn't granted.
export function startScreenAudio(): Promise<void> {
  return invoke<void>("start_screen_audio");
}

export function stopScreenAudio(): Promise<void> {
  return invoke<void>("stop_screen_audio");
}

export function engineStatus(): Promise<EngineStatus> {
  return invoke<EngineStatus>("engine_status");
}

export function startRecording(): Promise<string> {
  return invoke<string>("start_recording");
}

export function stopRecording(): Promise<Track> {
  return invoke<Track>("stop_recording");
}

// --- settings -------------------------------------------------------------

export function getSettings(): Promise<Record<string, string>> {
  return invoke<Record<string, string>>("get_settings");
}

export function setSetting(key: string, value: string): Promise<void> {
  return invoke<void>("set_setting", { key, value });
}

export function recordingFormatLabel(): Promise<string> {
  return invoke<string>("recording_format_label");
}

// --- metadata enrichment ---------------------------------------------------

export function enrichIntegrationStatus(): Promise<EnrichIntegrationStatus> {
  return invoke<EnrichIntegrationStatus>("enrich_integration_status");
}

export function setAcoustidKey(key: string): Promise<void> {
  return invoke<void>("set_acoustid_key", { key });
}

export function setAnthropicKey(key: string): Promise<void> {
  return invoke<void>("set_anthropic_key", { key });
}

export function setOpenaiKey(key: string): Promise<void> {
  return invoke<void>("set_openai_key", { key });
}

export function setGeminiKey(key: string): Promise<void> {
  return invoke<void>("set_gemini_key", { key });
}

export function proposeEnrichment(
  trackIds: number[],
): Promise<EnrichProposeReport> {
  return invoke<EnrichProposeReport>("propose_enrichment", { trackIds });
}

/// Look up tags for one track using the (possibly edited) title/artist shown in
/// the edit modal. Returns a single suggestion, or null when nothing matched.
export function lookupTrackTags(
  trackId: number,
  title: string,
  artist: string,
): Promise<MetadataSuggestion | null> {
  return invoke<MetadataSuggestion | null>("lookup_track_tags", {
    trackId,
    title,
    artist,
  });
}

/// AI Assistant — natural-language bulk edits proposed by the configured LLM.
export interface AssistantChange {
  trackId: number;
  field: "title" | "artist" | "album" | "year" | "genre";
  from: string | null;
  to: string | null;
  trackLabel: string;
}

/// The configured AI provider's label, or null if none is set up.
export function aiAssistantStatus(): Promise<string | null> {
  return invoke<string | null>("ai_assistant_status");
}

/// Models installed in a local Ollama (GET {host}/api/tags).
export function ollamaModels(host: string): Promise<string[]> {
  return invoke<string[]>("ollama_models", { host });
}

/// Propose per-field edits for a natural-language instruction. Nothing is
/// written; review then apply via applyEnrichment.
export function aiAssistantPropose(prompt: string): Promise<AssistantChange[]> {
  return invoke<AssistantChange[]>("ai_assistant_propose", { prompt });
}

export function applyEnrichment(edits: ApprovedEdit[]): Promise<number> {
  return invoke<number>("apply_enrichment", { edits });
}

/// "Clean Track Data": dissect messy YouTube-style titles into proper
/// title/artist/year fields (heuristic first, LLM if configured). Returns
/// proposals for the same review dialog as Enrich; nothing is written yet.
export function cleanTrackMetadata(
  trackIds: number[],
): Promise<EnrichProposeReport> {
  return invoke<EnrichProposeReport>("clean_track_metadata", { trackIds });
}

export function enrichCostEstimate(count: number): Promise<number> {
  return invoke<number>("enrich_cost_estimate", { count });
}

export function onEnrichProgress(
  cb: (p: EnrichProgress) => void,
): Promise<UnlistenFn> {
  return listen<EnrichProgress>("enrich-progress", (e) => cb(e.payload));
}

export interface ApplyProgress {
  done: number;
  total: number;
}

/// Progress while approved enrichment edits are being written (cover-art
/// downloads make a big batch slow).
export function onApplyProgress(
  cb: (p: ApplyProgress) => void,
): Promise<UnlistenFn> {
  return listen<ApplyProgress>("enrich-apply-progress", (e) => cb(e.payload));
}

// --- streams, mirror, playlists -------------------------------------------

export function importStreamUrl(url: string): Promise<Track> {
  return invoke<Track>("import_stream_url", { url });
}

export interface YtSearchResult {
  videoId: string;
  title: string;
  channel: string;
  durationMs: number | null;
  published: string | null;
  url: string;
}

export type YtSort = "relevance" | "date" | "views" | "rating";

export function youtubeSearch(
  query: string,
  sort: YtSort = "relevance",
): Promise<YtSearchResult[]> {
  return invoke<YtSearchResult[]>("youtube_search", { query, sort });
}

export function mirrorPlaylist(input: string): Promise<MirrorReport> {
  return invoke<MirrorReport>("mirror_playlist", { input });
}

/// Build a playlist from a text prompt: the configured AI provider drafts an
/// Artist - Title list (1–100 tracks), then it is mirrored to official YouTube
/// embeds exactly like `mirrorPlaylist` — same `mirror-progress` events.
export function aiBuildPlaylist(prompt: string, count: number): Promise<MirrorReport> {
  return invoke<MirrorReport>("ai_build_playlist", { prompt, count });
}

/// Import a direct audio/video URL (e.g. an Archive.org file) as a
/// STREAM_PLAYABLE library track (source_kind "stream").
export function importDirectStream(url: string): Promise<Track> {
  return invoke<Track>("import_direct_stream", { url });
}

export function onMirrorProgress(
  cb: (p: MirrorProgress) => void,
): Promise<UnlistenFn> {
  return listen<MirrorProgress>("mirror-progress", (e) => cb(e.payload));
}

// --- self-healing library (dead-link repair) ------------------------------

export interface RepairReport {
  checked: number;
  dead: number;
  healed: number;
  stillDead: number;
  healedTitles: string[];
}

export interface RepairProgress {
  phase: "checking" | "repairing";
  done: number;
  total: number;
  healed: number;
}

/// Health-check every STREAM_PLAYABLE YouTube track and re-resolve the dead
/// ones (removed/private) to a working replacement via the Mirror Engine.
export function repairStreams(): Promise<RepairReport> {
  return invoke<RepairReport>("repair_streams");
}

export function onRepairProgress(
  cb: (p: RepairProgress) => void,
): Promise<UnlistenFn> {
  return listen<RepairProgress>("repair-progress", (e) => cb(e.payload));
}

export interface ReResolveResult {
  healed: boolean;
  newUri: string | null;
  message: string;
}

/// Re-resolve one YouTube track to a working replacement — used to auto-heal
/// the instant the embed reports the video is unplayable.
export function reresolveStream(trackId: number): Promise<ReResolveResult> {
  return invoke<ReResolveResult>("reresolve_stream", { trackId });
}

// --- external control (tray, global hotkey, macOS media keys) --------------

/// Playback commands from the menu-bar tray, the global Play/Pause hotkey, or
/// macOS remote commands (Control Center / media keys): "playpause" | "play" |
/// "pause" | "next" | "prev".
export function onMediaCommand(cb: (cmd: string) => void): Promise<UnlistenFn> {
  return listen<string>("media-command", (e) => cb(e.payload));
}

export interface NowPlayingMeta {
  title: string | null;
  artist: string | null;
  album: string | null;
  durationMs: number | null;
  positionMs: number | null;
  playing: boolean;
}

/// Publish the current track + play state to the OS Now Playing surface
/// (macOS Control Center / media keys / lock screen). No-op off macOS.
export function setNowPlaying(meta: NowPlayingMeta): Promise<void> {
  return invoke<void>("set_now_playing", { meta });
}

export function listPlaylists(): Promise<PlaylistInfo[]> {
  return invoke<PlaylistInfo[]>("list_playlists");
}

export function createPlaylist(name: string): Promise<number> {
  return invoke<number>("create_playlist", { name });
}

export function playlistTracks(playlistId: number): Promise<Track[]> {
  return invoke<Track[]>("playlist_tracks", { playlistId });
}

export function addToPlaylist(playlistId: number, trackId: number): Promise<void> {
  return invoke<void>("add_to_playlist", { playlistId, trackId });
}

/// Append many tracks to a playlist in one call, skipping any already present.
/// Resolves to the number newly added.
export function addTracksToPlaylist(
  playlistId: number,
  trackIds: number[],
): Promise<number> {
  return invoke<number>("add_tracks_to_playlist", { playlistId, trackIds });
}

export function deletePlaylist(playlistId: number): Promise<void> {
  return invoke<void>("delete_playlist", { playlistId });
}

export function renamePlaylist(playlistId: number, name: string): Promise<void> {
  return invoke<void>("rename_playlist", { playlistId, name });
}

/// Persist a drag-and-drop playlist order (ids in display order).
export function reorderPlaylists(ids: number[]): Promise<void> {
  return invoke<void>("reorder_playlists", { ids });
}

// --- Playlist folders (sidebar grouping) -----------------------------------

export function listPlaylistFolders(): Promise<FolderInfo[]> {
  return invoke<FolderInfo[]>("list_playlist_folders");
}

export function createPlaylistFolder(name: string): Promise<number> {
  return invoke<number>("create_playlist_folder", { name });
}

export function renamePlaylistFolder(folderId: number, name: string): Promise<void> {
  return invoke<void>("rename_playlist_folder", { folderId, name });
}

/// Delete a folder — its playlists move back to the sidebar root.
export function deletePlaylistFolder(folderId: number): Promise<void> {
  return invoke<void>("delete_playlist_folder", { folderId });
}

export function setFolderCollapsed(folderId: number, collapsed: boolean): Promise<void> {
  return invoke<void>("set_folder_collapsed", { folderId, collapsed });
}

export function movePlaylistToFolder(
  playlistId: number,
  folderId: number | null,
): Promise<void> {
  return invoke<void>("move_playlist_to_folder", { playlistId, folderId });
}

export function reorderPlaylistFolders(ids: number[]): Promise<void> {
  return invoke<void>("reorder_playlist_folders", { ids });
}

export interface MpxImportReport {
  playlistId: number;
  playlistName: string;
  imported: number;
  skipped: number;
  duplicates: number;
  warnings: string[];
}

export function importMpxPlaylist(path: string): Promise<MpxImportReport> {
  return invoke<MpxImportReport>("import_mpx_playlist", { path });
}

export interface ShareReport {
  shareUrl: string;
  trackCount: number;
  excludedLocal: number;
}

/// Share a playlist: the server stores it as .mpx and emails the friend a link.
export function sharePlaylist(
  playlistId: number,
  recipientEmail: string,
  senderName?: string,
): Promise<ShareReport> {
  return invoke<ShareReport>("share_playlist", {
    playlistId,
    recipientEmail,
    senderName: senderName ?? null,
  });
}

export function radioTop(limit?: number): Promise<RadioStation[]> {
  return invoke<RadioStation[]>("radio_top", { limit: limit ?? null });
}

export function radioSearch(query: string, limit?: number): Promise<RadioStation[]> {
  return invoke<RadioStation[]>("radio_search", { query, limit: limit ?? null });
}

export function resolveRadioStream(url: string): Promise<RadioStation> {
  return invoke<RadioStation>("resolve_radio_stream", { url });
}

export function importRadioStation(station: RadioStation): Promise<Track> {
  return invoke<Track>("import_radio_station", {
    name: station.name,
    url: station.url,
    favicon: station.favicon,
    tags: station.tags,
  });
}

export function integrationStatus(): Promise<IntegrationStatus> {
  return invoke<IntegrationStatus>("integration_status");
}

export function setYoutubeApiKey(key: string): Promise<void> {
  return invoke<void>("set_youtube_api_key", { key });
}

/// Check a YouTube Data API key (1 quota unit) before saving it. Resolves with
/// a short success note; rejects with a plain-language reason naming the step
/// to go back to.
export function verifyYoutubeApiKey(key: string): Promise<string> {
  return invoke<string>("verify_youtube_api_key", { key });
}

export function setSpotifyCredentials(
  clientId: string,
  clientSecret: string,
): Promise<void> {
  return invoke<void>("set_spotify_credentials", { clientId, clientSecret });
}

// --- Go Live (Icecast broadcaster) ----------------------------------------

export interface BroadcastConfig {
  host: string;
  port: number;
  mount: string;
  username: string;
  bitrate: number;
  name: string;
  description: string;
  genre: string;
  url: string;
  public: boolean;
}

export interface BroadcastSettings extends BroadcastConfig {
  hasPassword: boolean;
}

export type BroadcastState =
  | "idle"
  | "connecting"
  | "live"
  | "reconnecting"
  | "error";

export interface BroadcastStatus {
  state: BroadcastState;
  elapsedMs: number;
  sentBytes: number;
  bitrate: number;
  message: string;
}

export function getBroadcastConfig(): Promise<BroadcastSettings> {
  return invoke<BroadcastSettings>("get_broadcast_config");
}

export function setBroadcastPassword(password: string): Promise<void> {
  return invoke<void>("set_broadcast_password", { password });
}

export function goLiveStart(config: BroadcastConfig): Promise<BroadcastStatus> {
  return invoke<BroadcastStatus>("go_live_start", { config });
}

export function goLiveStop(): Promise<BroadcastStatus> {
  return invoke<BroadcastStatus>("go_live_stop");
}

export function goLiveStatus(): Promise<BroadcastStatus> {
  return invoke<BroadcastStatus>("go_live_status");
}

export function onBroadcastState(
  cb: (status: BroadcastStatus) => void,
): Promise<UnlistenFn> {
  return listen<BroadcastStatus>("broadcast-state", (e) => cb(e.payload));
}

// --- engine events -------------------------------------------------------

export function onRecordingState(
  cb: (state: RecordingState) => void,
): Promise<UnlistenFn> {
  return listen<RecordingState>("recording-state", (e) => cb(e.payload));
}

export function onVuLevels(cb: (levels: VuLevels) => void): Promise<UnlistenFn> {
  return listen<VuLevels>("vu-levels", (e) => cb(e.payload));
}

export function onPosition(cb: (positionMs: number) => void): Promise<UnlistenFn> {
  return listen<{ positionMs: number }>("position", (e) => cb(e.payload.positionMs));
}

export function onPlaybackState(
  cb: (state: PlaybackState) => void,
): Promise<UnlistenFn> {
  return listen<{ state: PlaybackState }>("playback-state", (e) => cb(e.payload.state));
}

/// Fires when an OWNED track reaches its natural end (not a user stop), so the
/// playlist can advance. See engine `ended_signal` → meters emitter.
export function onTrackEnded(cb: () => void): Promise<UnlistenFn> {
  return listen("track-ended", () => cb());
}
