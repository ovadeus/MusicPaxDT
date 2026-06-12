import { useEffect, useState } from "react";
import { formatDuration } from "./LibraryTable";
import TransportControls from "./TransportControls";
import VuMeter from "./VuMeter";
import type { PlaybackState, Track } from "../lib/types";

interface Props {
  track: Track | null;
  state: PlaybackState;
  positionMs: number;
  volume: number;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
  onSeek: (ms: number) => void;
  onVolume: (level: number) => void;
}

export default function NowPlayingBar(props: Props) {
  const { track, state, positionMs, volume, onPlay, onPause, onStop, onSeek, onVolume } =
    props;
  const durationMs = track?.durationMs ?? 0;

  // While dragging, show the drag position instead of fighting engine events.
  const [dragMs, setDragMs] = useState<number | null>(null);
  useEffect(() => setDragMs(null), [track?.id]);
  const shownMs = dragMs ?? positionMs;

  return (
    <footer className="now-playing-bar">
      <div className="np-track">
        {track ? (
          <>
            <div className="np-title">{track.title ?? "Untitled"}</div>
            <div className="np-artist">{track.artist ?? "Unknown artist"}</div>
          </>
        ) : (
          <div className="np-artist">Nothing loaded</div>
        )}
      </div>

      <TransportControls
        state={state}
        canPlay={track != null}
        onPlay={onPlay}
        onPause={onPause}
        onStop={onStop}
      />

      <div className="np-seek">
        <span className="np-time">{formatDuration(shownMs)}</span>
        <input
          type="range"
          className="seek-slider"
          min={0}
          max={Math.max(durationMs, 1)}
          step={250}
          value={Math.min(shownMs, durationMs)}
          disabled={!track || durationMs <= 0}
          onChange={(e) => setDragMs(Number(e.target.value))}
          onPointerUp={() => {
            if (dragMs != null) {
              onSeek(dragMs);
              setDragMs(null);
            }
          }}
          onKeyUp={(e) => {
            if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && dragMs != null) {
              onSeek(dragMs);
              setDragMs(null);
            }
          }}
        />
        <span className="np-time">{formatDuration(durationMs)}</span>
      </div>

      <div className="np-volume" title="Volume">
        <span className="np-volume-icon">{volume === 0 ? "🔇" : "🔊"}</span>
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

      <VuMeter />
    </footer>
  );
}
