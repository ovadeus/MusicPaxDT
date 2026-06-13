import { useEffect, useState } from "react";
import * as ipc from "../lib/ipc";
import type { IntegrationStatus } from "../lib/types";

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
  const [integrations, setIntegrations] = useState<IntegrationStatus | null>(null);
  const [ytKey, setYtKey] = useState("");
  const [spotifyId, setSpotifyId] = useState("");
  const [spotifySecret, setSpotifySecret] = useState("");

  useEffect(() => {
    ipc
      .getSettings()
      .then((s) => {
        setValues(s);
        setLoaded(true);
      })
      .catch((e) => onError(`Failed to load settings: ${e}`));
    ipc.integrationStatus().then(setIntegrations).catch(() => {});
  }, [onError]);

  const saveYoutubeKey = async () => {
    try {
      await ipc.setYoutubeApiKey(ytKey);
      setYtKey("");
      setIntegrations(await ipc.integrationStatus());
    } catch (e) {
      onError(`${e}`);
    }
  };

  const saveSpotify = async () => {
    try {
      await ipc.setSpotifyCredentials(spotifyId, spotifySecret);
      setSpotifyId("");
      setSpotifySecret("");
      setIntegrations(await ipc.integrationStatus());
    } catch (e) {
      onError(`${e}`);
    }
  };

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

            <section className="settings-section">
              <h3>Integrations</h3>
              <div className="integration-row">
                <span>
                  YouTube Data API key{" "}
                  <em className={integrations?.youtubeApiKey ? "ok" : ""}>
                    {integrations?.youtubeApiKey
                      ? "configured"
                      : "not set (keyless search fallback in use)"}
                  </em>
                </span>
                <div className="integration-inputs">
                  <input
                    type="password"
                    placeholder="Paste API key"
                    value={ytKey}
                    onChange={(e) => setYtKey(e.target.value)}
                  />
                  <button onClick={saveYoutubeKey} disabled={!ytKey.trim()}>
                    Save
                  </button>
                </div>
              </div>

              <div className="integration-row">
                <span>
                  Spotify credentials{" "}
                  <em className={integrations?.spotifyCredentials ? "ok" : ""}>
                    {integrations?.spotifyCredentials ? "configured" : "not set"}
                  </em>
                </span>
                <div className="integration-inputs">
                  <input
                    type="password"
                    placeholder="Client ID"
                    value={spotifyId}
                    onChange={(e) => setSpotifyId(e.target.value)}
                  />
                  <input
                    type="password"
                    placeholder="Client Secret"
                    value={spotifySecret}
                    onChange={(e) => setSpotifySecret(e.target.value)}
                  />
                  <button
                    onClick={saveSpotify}
                    disabled={!spotifyId.trim() || !spotifySecret.trim()}
                  >
                    Save
                  </button>
                </div>
              </div>

              <p className="settings-hint">
                Keys are stored in the system keychain, never in plain text.
                Spotify credentials (free at developer.spotify.com) let Mirror
                read public playlist track lists; a YouTube API key makes match
                search more reliable than the built-in keyless fallback.
              </p>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
