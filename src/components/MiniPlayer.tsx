import { useState, type RefObject } from "react";
import { Maximize2, Pause, Play, SkipBack, SkipForward, Volume1, Volume2, VolumeX } from "lucide-react";
import { formatDuration } from "./LibraryTable";
import MpxLogo from "./MpxLogo";
import type { Track } from "../lib/types";

interface Props {
  track: Track | null;
  cover: string | null;
  playing: boolean;
  positionMs: number;
  durationMs: number;
  volume: number;
  onPlay: () => void;
  onPause: () => void;
  onSeek: (ms: number) => void;
  onVolume: (level: number) => void;
  onPrev: () => void;
  onNext: () => void;
  onExit: () => void;
  canStep: boolean;
  /// The cover element, measured by App so a live video can fill the cover slot.
  coverRef?: RefObject<HTMLDivElement | null>;
}

/// Compact floating "now playing" card shown when the window is shrunk to mini.
/// Drives the same playback state as the full now-playing bar.
export default function MiniPlayer(props: Props) {
  const {
    track,
    cover,
    playing,
    positionMs,
    durationMs,
    volume,
    onSeek,
    onVolume,
    onExit,
    canStep,
  } = props;

  const [dragMs, setDragMs] = useState<number | null>(null);
  const shownMs = dragMs ?? positionMs;
  const remaining = durationMs > 0 ? Math.max(0, durationMs - shownMs) : 0;
  const VolIcon = volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  return (
    <div className="mini-player">
      <div className="mini-titlebar">
        <span className="mini-brand">MINIPLAY</span>
        <button className="mini-expand" title="Back to full window" onClick={onExit}>
          <Maximize2 size={14} />
        </button>
      </div>

      <div className="mini-cover" ref={props.coverRef}>
        {cover ? (
          <img src={cover} alt="" onError={(e) => (e.currentTarget.style.display = "none")} />
        ) : (
          <MpxLogo className="mini-cover-logo" />
        )}
      </div>

      <div className="mini-seek">
        <input
          type="range"
          className="seek-slider"
          min={0}
          max={Math.max(durationMs, 1)}
          step={250}
          value={Math.min(shownMs, Math.max(durationMs, 1))}
          disabled={!track || durationMs <= 0}
          onChange={(e) => setDragMs(Number(e.target.value))}
          onPointerUp={() => {
            if (dragMs != null) {
              onSeek(dragMs);
              setDragMs(null);
            }
          }}
        />
        <div className="mini-times">
          <span>{formatDuration(shownMs)}</span>
          <span>{durationMs > 0 ? `-${formatDuration(remaining)}` : ""}</span>
        </div>
      </div>

      <div className="mini-meta">
        <div className="mini-title" title={track?.title ?? ""}>
          {track?.title ?? "Nothing playing"}
        </div>
        {track && (
          <div className="mini-sub">
            {[track.artist, track.album].filter(Boolean).join(" — ") || "—"}
          </div>
        )}
      </div>

      <div className="mini-transport">
        <button disabled={!canStep} onClick={props.onPrev} title="Previous">
          <SkipBack size={20} fill="currentColor" />
        </button>
        <button
          className="mini-play"
          disabled={!track}
          onClick={playing ? props.onPause : props.onPlay}
          title={playing ? "Pause" : "Play"}
        >
          {playing ? (
            <Pause size={22} fill="currentColor" />
          ) : (
            <Play size={22} fill="currentColor" />
          )}
        </button>
        <button disabled={!canStep} onClick={props.onNext} title="Next">
          <SkipForward size={20} fill="currentColor" />
        </button>
      </div>

      <div className="mini-volume">
        <VolIcon size={16} />
        <input
          type="range"
          className="volume-slider"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => onVolume(Number(e.target.value))}
        />
      </div>
    </div>
  );
}
