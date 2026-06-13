import { useEffect, useState } from "react";
import * as ipc from "../lib/ipc";

interface Props {
  onClose: () => void;
  onError: (message: string) => void;
  onSaved: () => void;
}

const FORMATS = [
  { value: "wav", label: "WAV (lossless)" },
  { value: "aiff", label: "AIFF (lossless)" },
  { value: "flac", label: "FLAC (lossless, compressed)" },
  { value: "mp3", label: "MP3 (lossy)" },
];

const BIT_DEPTHS = [
  { value: "16", label: "16-bit (CD quality)" },
  { value: "24", label: "24-bit (archival)" },
  { value: "32", label: "32-bit float (studio, WAV only)" },
];

const MP3_BITRATES = [
  { value: "128", label: "128 kbps" },
  { value: "192", label: "192 kbps" },
  { value: "256", label: "256 kbps" },
  { value: "320", label: "320 kbps (best)" },
];

/// The app-wide settings area. Sections are designed to grow — M3+ will add
/// radio, AI-provider and theme settings here.
export default function SettingsPanel({ onClose, onError, onSaved }: Props) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    ipc
      .getSettings()
      .then((s) => {
        setValues(s);
        setLoaded(true);
      })
      .catch((e) => onError(`Failed to load settings: ${e}`));
  }, [onError]);

  const update = async (key: string, value: string) => {
    setValues((cur) => ({ ...cur, [key]: value }));
    try {
      await ipc.setSetting(key, value);
      onSaved();
    } catch (e) {
      onError(`Failed to save setting: ${e}`);
    }
  };

  const format = values["recording.format"] ?? "wav";
  const bitDepth = values["recording.bit_depth"] ?? "32";
  const mp3Bitrate = values["recording.mp3_bitrate"] ?? "320";

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="settings-close" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        {!loaded ? (
          <p className="settings-loading">Loading…</p>
        ) : (
          <>
            <section className="settings-section">
              <h3>Recording</h3>
              <label className="settings-field">
                <span>Format</span>
                <select
                  value={format}
                  onChange={(e) => update("recording.format", e.target.value)}
                >
                  {FORMATS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </label>

              {format !== "mp3" && (
                <label className="settings-field">
                  <span>Bit depth</span>
                  <select
                    value={bitDepth}
                    onChange={(e) => update("recording.bit_depth", e.target.value)}
                  >
                    {BIT_DEPTHS.filter(
                      (b) => format === "wav" || b.value !== "32",
                    ).map((b) => (
                      <option key={b.value} value={b.value}>
                        {b.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {format === "mp3" && (
                <label className="settings-field">
                  <span>Bitrate</span>
                  <select
                    value={mp3Bitrate}
                    onChange={(e) => update("recording.mp3_bitrate", e.target.value)}
                  >
                    {MP3_BITRATES.map((b) => (
                      <option key={b.value} value={b.value}>
                        {b.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <p className="settings-hint">
                Recordings always capture the post-EQ signal at the input device’s
                native sample rate. Lossless formats are best for archiving vinyl
                and tape; MP3 is the most portable.
                {format === "mp3" &&
                  " MP3 supports inputs up to 48 kHz — use a lossless format for hi-res interfaces."}
                {format === "flac" &&
                  " FLAC encodes when you stop — fine up to roughly a vinyl side per take."}
              </p>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
