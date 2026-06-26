import { Pause, Play, SkipBack, SkipForward, Square } from "lucide-react";
import type { PlaybackState } from "../lib/types";

interface Props {
  state: PlaybackState;
  canPlay: boolean;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  canStep?: boolean;
}

export default function TransportControls({
  state,
  canPlay,
  onPlay,
  onPause,
  onStop,
  onPrev,
  onNext,
  canStep = false,
}: Props) {
  const playing = state === "playing";
  return (
    <div className="transport">
      <button
        className="transport-button"
        disabled={!canStep}
        onClick={onPrev}
        title="Previous track"
      >
        <SkipBack size={14} fill="currentColor" />
      </button>
      <button
        className="transport-button primary"
        disabled={!canPlay}
        onClick={playing ? onPause : onPlay}
        title={playing ? "Pause" : "Play"}
      >
        {playing ? (
          <Pause size={16} fill="currentColor" />
        ) : (
          <Play size={16} fill="currentColor" />
        )}
      </button>
      <button
        className="transport-button"
        disabled={state === "stopped"}
        onClick={onStop}
        title="Stop"
      >
        <Square size={12} fill="currentColor" />
      </button>
      <button
        className="transport-button"
        disabled={!canStep}
        onClick={onNext}
        title="Next track"
      >
        <SkipForward size={14} fill="currentColor" />
      </button>
    </div>
  );
}
