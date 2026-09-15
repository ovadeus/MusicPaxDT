import { useState, type RefObject } from "react";
import {
  ChevronDown,
  ChevronUp,
  Maximize2,
  Pause,
  Play,
  RefreshCw,
  SkipBack,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";
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
  /// Step one size up: micro → mini, mini → the full window.
  onGrow: () => void;
  /// Step down from mini to the micro bar. Absent in micro (already smallest).
  onShrink?: () => void;
  /// Micro: the smallest size — title, transport and the two sliders only.
  micro?: boolean;
  /// A staged update's version, when one is ready. The full window shows a
  /// card for this; the small sizes have no room for it, and people leave
  /// the app in them for hours — exactly when the periodic check fires — so
  /// they carry their own compact affordance instead of hiding the news.
  updateVersion?: string | null;
  onRelaunch?: () => void;
  canStep: boolean;
  /// The cover element, measured by App so a live video can fill the cover slot.
  coverRef?: RefObject<HTMLDivElement | null>;
}

/// Compact floating "now playing" card shown when the window is shrunk to mini.
/// Drives the same playback state as the full now-playing bar. In `micro` it
/// drops the cover art and stacks the transport over a seek + volume row —
/// the smallest size that still exposes every control.
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
    onGrow,
    onShrink,
    micro,
    updateVersion,
    onRelaunch,
    canStep,
  } = props;

  const updateTitle = updateVersion
    ? `MUSICPAX ${updateVersion} is ready — relaunch to update`
    : undefined;

  const [dragMs, setDragMs] = useState<number | null>(null);
  const shownMs = dragMs ?? positionMs;
  const remaining = durationMs > 0 ? Math.max(0, durationMs - shownMs) : 0;
  const VolIcon = volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  const seekSlider = (
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
  );

  const transport = (
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
  );

  if (micro) {
    return (
      <div className="mini-player micro">
        <div className="micro-top">
          <div
            className={`mini-title${updateVersion && onRelaunch ? " with-update" : ""}`}
            title={track?.title ?? ""}
          >
            {track?.title ?? "Nothing playing"}
          </div>
          {updateVersion && onRelaunch && (
            <button className="mini-update micro" title={updateTitle} onClick={onRelaunch}>
              <RefreshCw size={13} />
            </button>
          )}
          <button className="mini-expand" title="Back to the mini player" onClick={onGrow}>
            <ChevronUp size={17} />
          </button>
        </div>

        {transport}

        <div className="micro-sliders">
          {seekSlider}
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
        <div className="micro-time">{formatDuration(shownMs)}</div>
      </div>
    );
  }

  return (
    <div className="mini-player">
      <div className="mini-titlebar">
        {/* The pill takes the brand's place: at 360px there isn't room for
            both, and "Relaunch to update" is the more useful headline. */}
        {!(updateVersion && onRelaunch) && <span className="mini-brand">MINIPLAY</span>}
        {updateVersion && onRelaunch && (
          <button className="mini-update" title={updateTitle} onClick={onRelaunch}>
            <RefreshCw size={12} /> Relaunch to update
          </button>
        )}
        {onShrink && (
          <button className="mini-expand" title="Shrink to the micro player" onClick={onShrink}>
            <ChevronDown size={17} />
          </button>
        )}
        <button className="mini-expand" title="Back to full window" onClick={onGrow}>
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
        {seekSlider}
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

      {transport}

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
