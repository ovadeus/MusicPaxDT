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
  ImportResult,
  IntegrationStatus,
  LineInSource,
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
}): Promise<Track[]> {
  return invoke<Track[]>("list_tracks", {
    query: opts.query || null,
    sort: opts.sort ? `${opts.sort.field}:${opts.sort.dir}` : null,
    limit: opts.limit ?? null,
    offset: opts.offset ?? null,
  });
}

export function updateTrackMetadata(
  trackId: number,
  fields: {
    title: string | null;
    artist: string | null;
    album: string | null;
    year: number | null;
    genre: string | null;
  },
): Promise<Track> {
  return invoke<Track>("update_track_metadata", { trackId, ...fields });
}

export function deleteTrack(trackId: number): Promise<void> {
  return invoke<void>("delete_track", { trackId });
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

export function getAudioDevices(): Promise<AudioDevice[]> {
  return invoke<AudioDevice[]>("get_audio_devices");
}

export function setOutputDevice(id: string): Promise<void> {
  return invoke<void>("set_output_device", { id });
}

export function loadTrack(trackId: number): Promise<void> {
  return invoke<void>("load_track", { trackId });
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

export function proposeEnrichment(
  trackIds: number[],
): Promise<EnrichProposeReport> {
  return invoke<EnrichProposeReport>("propose_enrichment", { trackIds });
}

export function applyEnrichment(edits: ApprovedEdit[]): Promise<number> {
  return invoke<number>("apply_enrichment", { edits });
}

export function enrichCostEstimate(count: number): Promise<number> {
  return invoke<number>("enrich_cost_estimate", { count });
}

export function onEnrichProgress(
  cb: (p: EnrichProgress) => void,
): Promise<UnlistenFn> {
  return listen<EnrichProgress>("enrich-progress", (e) => cb(e.payload));
}

// --- streams, mirror, playlists -------------------------------------------

export function importStreamUrl(url: string): Promise<Track> {
  return invoke<Track>("import_stream_url", { url });
}

export function mirrorPlaylist(input: string): Promise<MirrorReport> {
  return invoke<MirrorReport>("mirror_playlist", { input });
}

export function onMirrorProgress(
  cb: (p: MirrorProgress) => void,
): Promise<UnlistenFn> {
  return listen<MirrorProgress>("mirror-progress", (e) => cb(e.payload));
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

export function deletePlaylist(playlistId: number): Promise<void> {
  return invoke<void>("delete_playlist", { playlistId });
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

export function setSpotifyCredentials(
  clientId: string,
  clientSecret: string,
): Promise<void> {
  return invoke<void>("set_spotify_credentials", { clientId, clientSecret });
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
