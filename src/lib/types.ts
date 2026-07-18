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
  mediaType: MediaType;
  fingerprint: string | null;
  musicbrainzId: string | null;
  artPath: string | null;
  rating: number;
  playCount: number;
  addedAt: number;
}

export type MediaType =
  | "music"
  | "podcast"
  | "audiobook"
  | "movie"
  | "radio"
  | "tutorial";

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

export interface RadioStation {
  uuid: string;
  name: string;
  url: string;
  favicon: string | null;
  tags: string | null;
  country: string | null;
  codec: string | null;
  bitrate: number;
}

export interface EngineStatus {
  mode: "library" | "lineIn";
  source: string | null;
  inputDevice: string | null;
  riaa: boolean;
  bassDb: number;
  trebleDb: number;
  inputGainDb: number;
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
  /// Folder this playlist lives in; null = ungrouped (sidebar root).
  folderId: number | null;
}

/// A sidebar playlist folder (single-level grouping).
export interface FolderInfo {
  id: number;
  name: string;
  position: number;
  collapsed: boolean;
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

export interface EnrichIntegrationStatus {
  acoustidKey: boolean;
  anthropicKey: boolean;
  openaiKey: boolean;
  fpcalcFound: boolean;
  fpcalcPath: string | null;
}

export interface MetadataSuggestion {
  title: string | null;
  artist: string | null;
  album: string | null;
  year: number | null;
  genre: string | null;
  artUrl: string | null;
  musicbrainzId: string | null;
  source: string;
  confidence: number;
}

export interface EnrichProposal {
  track: Track;
  suggestion: MetadataSuggestion;
}

export interface EnrichProposeReport {
  proposals: EnrichProposal[];
  total: number;
  spentUsd: number;
  capped: boolean;
}

export interface ApprovedEdit {
  trackId: number;
  title: string | null;
  artist: string | null;
  album: string | null;
  year: number | null;
  genre: string | null;
  artUrl: string | null;
  musicbrainzId: string | null;
}

export interface EnrichProgress {
  done: number;
  total: number;
  proposed: number;
  spentUsd: number;
  current: string;
  capped: boolean;
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
