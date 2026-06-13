import { useEffect, useRef } from "react";
import type { Track } from "../lib/types";

interface Props {
  track: Track;
  playing: boolean;
  volume: number; // 0..1
  onPlayingChange: (playing: boolean) => void;
  onError: (message: string) => void;
}

/// Plays an internet-radio stream inline via a hidden HTML5 <audio> element —
/// the STREAM_PLAYABLE path for radio (no decode into the OWNED engine, no
/// DSP, no recording). Transport/volume are driven by the now-playing bar.
export default function RadioPlayer({
  track,
  playing,
  volume,
  onPlayingChange,
  onError,
}: Props) {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Load the stream when the track changes.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.src = track.uri;
    audio.load();
    if (playing) audio.play().catch(() => onPlayingChange(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.uri]);

  // Reflect transport intent onto the element.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) audio.play().catch(() => onPlayingChange(false));
    else audio.pause();
  }, [playing, onPlayingChange]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  return (
    <audio
      ref={audioRef}
      hidden
      onPlaying={() => onPlayingChange(true)}
      onPause={() => onPlayingChange(false)}
      onError={() => onError(`Could not play “${track.title ?? "station"}” — the stream may be offline.`)}
    />
  );
}
