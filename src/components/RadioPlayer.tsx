import { useEffect, useRef } from "react";
import type { Track } from "../lib/types";
import * as meter from "../lib/streamMeter";

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
///
/// When the stream server allows cross-origin reads we tap the element with the
/// Web Audio API for a REAL stereo VU meter; otherwise the meter falls back to
/// a synthesized animation. Mount one element per station (App keys us by
/// track.uri) so each stream gets a clean shot at the analyser graph.
export default function RadioPlayer({
  track,
  playing,
  volume,
  onPlayingChange,
  onError,
}: Props) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playingRef = useRef(playing);
  playingRef.current = playing;

  // Load the stream once for this mount: probe CORS, opt into the real meter if
  // allowed, then set the source. crossOrigin must be set before .src.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    let cancelled = false;

    (async () => {
      const allowed = await meter.corsAllowed(track.uri);
      if (cancelled || !audioRef.current) return;
      if (allowed) {
        audio.crossOrigin = "anonymous";
        meter.connect(audio);
      }
      audio.src = track.uri;
      audio.load();
      if (playingRef.current) audio.play().catch(() => onPlayingChange(false));
    })();

    return () => {
      cancelled = true;
      meter.disconnect();
    };
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
