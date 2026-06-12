// The only place the app talks to Tauri. Components import from here —
// never call invoke() directly.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AudioDevice,
  ImportResult,
  NowPlaying,
  PlaybackState,
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

// --- engine events -------------------------------------------------------

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
