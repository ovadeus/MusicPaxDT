import type { PlaybackState } from "../lib/types";

interface Props {
  state: PlaybackState;
  canPlay: boolean;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
}

export default function TransportControls({ state, canPlay, onPlay, onPause, onStop }: Props) {
  const playing = state === "playing";
  return (
    <div className="transport">
      <button
        className="transport-button primary"
        disabled={!canPlay}
        onClick={playing ? onPause : onPlay}
        title={playing ? "Pause" : "Play"}
      >
        {playing ? "❚❚" : "▶"}
      </button>
      <button
        className="transport-button"
        disabled={state === "stopped"}
        onClick={onStop}
        title="Stop"
      >
        ■
      </button>
    </div>
  );
}
