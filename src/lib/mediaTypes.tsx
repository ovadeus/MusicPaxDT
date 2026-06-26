import { BookOpen, Clapperboard, GraduationCap, Music, Podcast, Radio } from "lucide-react";
import type { MediaType } from "./types";

export interface MediaTypeMeta {
  key: MediaType;
  label: string;
  Icon: typeof Music;
  color: string;
}

/// The MusicPax media-type set (same as musicpax.org), with icon + accent color.
export const MEDIA_TYPES: MediaTypeMeta[] = [
  { key: "music", label: "Music", Icon: Music, color: "#4d9fff" },
  { key: "podcast", label: "Podcast", Icon: Podcast, color: "#a855f7" },
  { key: "audiobook", label: "Audiobook", Icon: BookOpen, color: "#f59e0b" },
  { key: "movie", label: "Movie", Icon: Clapperboard, color: "#ef4444" },
  { key: "radio", label: "Radio", Icon: Radio, color: "#22c55e" },
  { key: "tutorial", label: "Tutorial", Icon: GraduationCap, color: "#fb923c" },
];

export function mediaTypeMeta(key: string | null | undefined): MediaTypeMeta {
  return MEDIA_TYPES.find((m) => m.key === key) ?? MEDIA_TYPES[0];
}
