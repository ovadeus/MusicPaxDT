import { useEffect, useState } from "react";
import { Circle, Square } from "lucide-react";
import * as ipc from "../lib/ipc";
import type {
  AudioDevice,
  EngineStatus,
  LineInSource,
  RecordingState,
} from "../lib/types";
import { formatDuration } from "./LibraryTable";

interface Props {
  source: LineInSource;
  status: EngineStatus | null;
  recording: RecordingState;
  formatLabel: string;
  onOpenSettings: () => void;
  onStatus: (status: EngineStatus) => void;
  onError: (message: string) => void;
  onRecordingSaved: (title: string) => void;
}

const SOURCE_TITLES: Record<LineInSource, string> = {
  phono: "Phono",
  tape: "Tape",
  cd: "CD",
  aux: "Aux",
};

export default function ReceiverPanel(props: Props) {
  const {
    source,
    status,
    recording,
    formatLabel,
    onOpenSettings,
    onStatus,
    onError,
    onRecordingSaved,
  } = props;
  const [inputs, setInputs] = useState<AudioDevice[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    ipc
      .getAudioInputDevices()
      .then(setInputs)
      .catch((e) => onError(`Input devices unavailable: ${e}`));
  }, [onError]);

  const riaa = status?.riaa ?? false;
  const bass = status?.bassDb ?? 0;
  const treble = status?.trebleDb ?? 0;
  const gain = status?.inputGainDb ?? 0;
  const monitoring = status?.state === "playing";

  const handleInput = async (deviceId: string) => {
    try {
      onStatus(await ipc.setInputDevice(source, deviceId));
    } catch (e) {
      onError(`${e}`);
    }
  };

  const handleRiaa = async (on: boolean) => {
    try {
      onStatus(await ipc.setRiaa(on));
    } catch (e) {
      onError(`${e}`);
    }
  };

  const handleTone = async (nextBass: number, nextTreble: number) => {
    try {
      onStatus(await ipc.setTone(nextBass, nextTreble));
    } catch (e) {
      onError(`${e}`);
    }
  };

  const handleGain = async (db: number) => {
    try {
      onStatus(await ipc.setInputGain(db));
    } catch (e) {
      onError(`${e}`);
    }
  };

  const toggleRecording = async () => {
    setBusy(true);
    try {
      if (recording.recording) {
        const track = await ipc.stopRecording();
        onRecordingSaved(track.title ?? "recording");
      } else {
        await ipc.startRecording();
      }
    } catch (e) {
      onError(`${e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="receiver-panel">
      <div className="receiver-header">
        <h2 className="receiver-title">{SOURCE_TITLES[source]} input</h2>
        <span className={`monitor-badge${monitoring ? " live" : ""}`}>
          {monitoring ? "MONITORING" : "MUTED"}
        </span>
      </div>

      <div className="receiver-controls">
        <label className="receiver-field">
          <span className="field-label">Capture device</span>
          <select
            value={status?.inputDevice ?? ""}
            onChange={(e) => handleInput(e.target.value)}
          >
            {status?.inputDevice == null && <option value="">Select…</option>}
            {inputs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
                {d.isDefault ? " (default)" : ""}
              </option>
            ))}
          </select>
        </label>

        <label
          className="receiver-field"
          title="Software boost for a quiet / phono-level source. A hardware preamp is cleaner, but this gets you listening from inside the app."
        >
          <span className="field-label">Input gain +{gain.toFixed(0)} dB</span>
          <input
            type="range"
            min={0}
            max={40}
            step={1}
            value={gain}
            onChange={(e) => handleGain(Number(e.target.value))}
          />
        </label>

        <label className="receiver-field riaa-toggle" title="RIAA de-emphasis for turntables with no phono preamp">
          <span className="field-label">RIAA EQ</span>
          <input
            type="checkbox"
            checked={riaa}
            onChange={(e) => handleRiaa(e.target.checked)}
          />
          <span>{riaa ? "On" : "Off"}</span>
        </label>

        <label className="receiver-field">
          <span className="field-label">Bass {bass > 0 ? "+" : ""}{bass.toFixed(0)} dB</span>
          <input
            type="range"
            min={-12}
            max={12}
            step={1}
            value={bass}
            onChange={(e) => handleTone(Number(e.target.value), treble)}
          />
        </label>

        <label className="receiver-field">
          <span className="field-label">
            Treble {treble > 0 ? "+" : ""}{treble.toFixed(0)} dB
          </span>
          <input
            type="range"
            min={-12}
            max={12}
            step={1}
            value={treble}
            onChange={(e) => handleTone(bass, Number(e.target.value))}
          />
        </label>

        <div className="receiver-field record-field">
          <button
            className={`record-button${recording.recording ? " recording" : ""}`}
            onClick={toggleRecording}
            disabled={busy || status == null}
            title={
              recording.recording
                ? "Stop and save to library"
                : "Record this input to the library (float32 WAV)"
            }
          >
            {recording.recording ? (
              <>
                <Square size={11} fill="currentColor" /> Stop
              </>
            ) : (
              <>
                <Circle size={11} fill="currentColor" /> Record
              </>
            )}
          </button>
          {recording.recording && (
            <span className="record-elapsed">{formatDuration(recording.recordedMs)}</span>
          )}
          {formatLabel && (
            <button
              className="format-chip"
              onClick={onOpenSettings}
              title="Recording format — click to change in Settings"
            >
              {formatLabel}
            </button>
          )}
        </div>
      </div>

      <p className="receiver-hint">
        Recordings are saved as OWNED tracks — find them in the Library when you stop.
      </p>
    </section>
  );
}
