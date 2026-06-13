// Mirrors the Rust serde structs in src-tauri/src/library/model.rs and
// src-tauri/src/audio/engine.rs exactly (camelCase via serde rename_all).

export type Capability = "OWNED" | "STREAM_PLAYABLE" | "LINK_ONLY";

export type PlaybackState = "stopped" | "playing" | "paused";

export interface Track {
  id: number;
  title: string | null;
  artist: string | null;
  album: string | null;
  year: number | null;
  genre: string | null;
  bpm: number | null;
  musicalKey: string | null;
  durationMs: number | null;
  uri: string;
  sourceKind: string;
  capability: Capability;
  fingerprint: string | null;
  musicbrainzId: string | null;
  artPath: string | null;
  rating: number;
  playCount: number;
  addedAt: number;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

export interface AudioDevice {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface NowPlaying {
  track: Track;
  positionMs: number;
  state: PlaybackState;
  volume: number;
}

export interface VuLevels {
  peakL: number;
  peakR: number;
  rmsL: number;
  rmsR: number;
}

export type LineInSource = "phono" | "tape" | "cd" | "aux";

export interface EngineStatus {
  mode: "library" | "lineIn";
  source: string | null;
  inputDevice: string | null;
  riaa: boolean;
  bassDb: number;
  trebleDb: number;
  recording: boolean;
  recordedMs: number;
  state: PlaybackState;
  positionMs: number;
  volume: number;
}

export interface RecordingState {
  recording: boolean;
  recordedMs: number;
}

export interface PlaylistInfo {
  id: number;
  name: string;
  trackCount: number;
}

export interface MirrorReport {
  playlistId: number;
  playlistName: string;
  total: number;
  matched: number;
  failed: string[];
}

export interface MirrorProgress {
  done: number;
  total: number;
  matched: number;
  current: string;
}

export interface IntegrationStatus {
  youtubeApiKey: boolean;
  spotifyCredentials: boolean;
}

export type SortField =
  | "title"
  | "artist"
  | "album"
  | "genre"
  | "year"
  | "duration_ms"
  | "added_at";

export interface SortSpec {
  field: SortField;
  dir: "asc" | "desc";
}
