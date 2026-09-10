import { useEffect, useState } from "react";
import { X } from "lucide-react";
import * as ipc from "../lib/ipc";
import { COLUMN_TOGGLES, type ColumnPrefs } from "../lib/columnPrefs";
import type { EnrichIntegrationStatus, IntegrationStatus } from "../lib/types";

const AI_PROVIDERS = [
  { value: "none", label: "None (free tiers only)" },
  { value: "anthropic", label: "Anthropic (Claude)" },
  { value: "openai", label: "OpenAI" },
  { value: "gemini", label: "Google Gemini" },
  { value: "ollama", label: "Ollama (local, free)" },
];

/// Cloud providers that need an API key (keychain) and accept a model id.
/// Defaults match `resolve_llm` in the Rust core.
const CLOUD_AI: Record<string, { label: string; modelPlaceholder: string }> = {
  anthropic: { label: "Anthropic", modelPlaceholder: "claude-opus-4-8" },
  openai: { label: "OpenAI", modelPlaceholder: "gpt-4o-mini" },
  gemini: { label: "Gemini", modelPlaceholder: "gemini-2.5-flash" },
};

interface Props {
  onClose: () => void;
  onError: (message: string) => void;
  onSaved: () => void;
  /// Library-column visibility (Album/Genre/Year/Length/Plays) + setter.
  columnPrefs: ColumnPrefs;
  onColumnPref: (key: keyof ColumnPrefs, value: boolean) => void;
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
export default function SettingsPanel({
  onClose,
  onError,
  onSaved,
  columnPrefs,
  onColumnPref,
}: Props) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [integrations, setIntegrations] = useState<IntegrationStatus | null>(null);
  const [enrich, setEnrich] = useState<EnrichIntegrationStatus | null>(null);
  const [ytKey, setYtKey] = useState("");
  const [spotifyId, setSpotifyId] = useState("");
  const [spotifySecret, setSpotifySecret] = useState("");
  const [acoustidKey, setAcoustidKey] = useState("");
  const [aiKey, setAiKey] = useState("");
  const [ollamaList, setOllamaList] = useState<string[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [detectErr, setDetectErr] = useState<string | null>(null);

  // Keychain reads happen only here (Settings is open = a user action), never at
  // launch. Mirror "is a key present" into plain settings flags so the app can
  // gate AI features on startup without touching the keychain (which would make
  // an unsigned build prompt for the login password every launch).
  const refreshEnrich = () =>
    ipc
      .enrichIntegrationStatus()
      .then((s) => {
        setEnrich(s);
        const flags: Record<string, boolean> = {
          anthropic: s.anthropicKey,
          openai: s.openaiKey,
          gemini: s.geminiKey,
        };
        for (const [provider, present] of Object.entries(flags)) {
          ipc.setSetting(`enrich.key_set.${provider}`, present ? "1" : "0").catch(() => {});
        }
      })
      .catch(() => {});

  useEffect(() => {
    ipc
      .getSettings()
      .then((s) => {
        setValues(s);
        setLoaded(true);
      })
      .catch((e) => onError(`Failed to load settings: ${e}`));
    ipc.integrationStatus().then(setIntegrations).catch(() => {});
    refreshEnrich();
  }, [onError]);

  const saveAcoustid = async () => {
    try {
      await ipc.setAcoustidKey(acoustidKey);
      setAcoustidKey("");
      await refreshEnrich();
    } catch (e) {
      onError(`${e}`);
    }
  };

  const detectOllama = async () => {
    setDetecting(true);
    setDetectErr(null);
    try {
      const list = await ipc.ollamaModels(values["enrich.ollama_host"] ?? "http://localhost:11434");
      setOllamaList(list);
      if (list.length === 0) {
        setDetectErr("Ollama is running but has no models. Pull one, e.g. `ollama pull llama3`.");
      } else if (!(values["enrich.model.ollama"] ?? "").trim()) {
        await update("enrich.model.ollama", list[0]);
      }
    } catch (e) {
      setDetectErr(`${e}`);
      setOllamaList([]);
    } finally {
      setDetecting(false);
    }
  };

  const saveAiKey = async (provider: string) => {
    try {
      if (provider === "anthropic") await ipc.setAnthropicKey(aiKey);
      else if (provider === "openai") await ipc.setOpenaiKey(aiKey);
      else if (provider === "gemini") await ipc.setGeminiKey(aiKey);
      setAiKey("");
      await refreshEnrich();
    } catch (e) {
      onError(`${e}`);
    }
  };

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

  const aiProvider = values["enrich.ai_provider"] ?? "none";
  // Model is stored per provider so an Ollama model can't leak into Anthropic.
  const modelKey = `enrich.model.${aiProvider}`;
  const aiModel = values[modelKey] ?? "";
  const spendCap = values["enrich.spend_cap_usd"] ?? "1.0";
  const ollamaHost = values["enrich.ollama_host"] ?? "http://localhost:11434";
  const cloudAi = CLOUD_AI[aiProvider];
  const aiKeyConfigured =
    (aiProvider === "anthropic" && enrich?.anthropicKey) ||
    (aiProvider === "openai" && enrich?.openaiKey) ||
    (aiProvider === "gemini" && enrich?.geminiKey);

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="settings-close" onClick={onClose} title="Close">
            <X size={15} />
          </button>
        </div>

        {!loaded ? (
          <p className="settings-loading">Loading…</p>
        ) : (
          <>
            <section className="settings-section">
              <h3>Library columns</h3>
              <p className="settings-note">
                Show or hide columns in the library list. Title and Artist always show.
              </p>
              <div className="col-toggles">
                {COLUMN_TOGGLES.map(({ key, label }) => (
                  <label className="col-toggle-row" key={key}>
                    <span>{label}</span>
                    <input
                      className="col-switch"
                      type="checkbox"
                      role="switch"
                      checked={columnPrefs[key]}
                      onChange={(e) => onColumnPref(key, e.target.checked)}
                    />
                  </label>
                ))}
              </div>
            </section>

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

            <section className="settings-section">
              <h3>Sharing</h3>
              <div className="settings-field">
                <span>Share server</span>
                <input
                  type="text"
                  placeholder="https://musicpax.com"
                  value={values["share.api_base"] ?? ""}
                  onChange={(e) => update("share.api_base", e.target.value)}
                />
              </div>
              <p className="settings-hint">
                Where “Share this playlist” uploads and emails from. Leave blank
                for musicpax.com; point it at http://localhost:3001 to test
                against a local share server.
              </p>
            </section>

            <section className="settings-section">
              <h3>Metadata enrichment</h3>

              <div className="integration-row">
                <span>
                  AcoustID API key{" "}
                  <em className={enrich?.acoustidKey ? "ok" : ""}>
                    {enrich?.acoustidKey ? "configured" : "not set"}
                  </em>
                </span>
                <div className="integration-inputs">
                  <input
                    type="password"
                    placeholder="Free key from acoustid.org"
                    value={acoustidKey}
                    onChange={(e) => setAcoustidKey(e.target.value)}
                  />
                  <button onClick={saveAcoustid} disabled={!acoustidKey.trim()}>
                    Save
                  </button>
                </div>
              </div>

              <div className="settings-field">
                <span>Fingerprint tool (fpcalc)</span>
                <em className={enrich?.fpcalcFound ? "ok integration-status" : "integration-status"}>
                  {enrich?.fpcalcFound
                    ? `found: ${enrich.fpcalcPath}`
                    : "not found — install Chromaprint or set a path below"}
                </em>
              </div>
              <div className="integration-inputs">
                <input
                  type="text"
                  placeholder="Optional: full path to fpcalc"
                  defaultValue={values["enrich.fpcalc_path"] ?? ""}
                  onBlur={(e) =>
                    update("enrich.fpcalc_path", e.target.value).then(refreshEnrich)
                  }
                />
              </div>

              <label className="settings-field">
                <span>AI provider (title cleanup, AI Assistant, playlist builder)</span>
                <select
                  value={aiProvider}
                  onChange={(e) => update("enrich.ai_provider", e.target.value)}
                >
                  {AI_PROVIDERS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>

              {cloudAi && (
                <label className="settings-field">
                  <span>Model</span>
                  <input
                    key={modelKey}
                    type="text"
                    placeholder={cloudAi.modelPlaceholder}
                    defaultValue={aiModel}
                    onBlur={(e) => update(modelKey, e.target.value)}
                  />
                </label>
              )}

              {cloudAi && (
                <div className="integration-row">
                  <span>
                    {cloudAi.label} API key{" "}
                    <em className={aiKeyConfigured ? "ok" : ""}>
                      {aiKeyConfigured ? "configured" : "not set"}
                    </em>
                  </span>
                  <div className="integration-inputs">
                    <input
                      type="password"
                      autoComplete="off"
                      // The real key never leaves the keychain; when one is saved
                      // we show dots so the field reads as "set" rather than empty.
                      placeholder={aiKeyConfigured ? "••••••••••••••••" : "Paste API key"}
                      value={aiKey}
                      onChange={(e) => setAiKey(e.target.value)}
                    />
                    <button onClick={() => saveAiKey(aiProvider)} disabled={!aiKey.trim()}>
                      {aiKeyConfigured ? "Replace" : "Save"}
                    </button>
                  </div>
                </div>
              )}

              {aiProvider === "ollama" && (
                <>
                  <label className="settings-field">
                    <span>Ollama host</span>
                    <input
                      type="text"
                      defaultValue={ollamaHost}
                      onBlur={(e) => update("enrich.ollama_host", e.target.value)}
                    />
                  </label>

                  <div className="integration-row">
                    <span>
                      Local model{" "}
                      <em className={aiModel ? "ok" : ""}>{aiModel || "not set"}</em>
                    </span>
                    <div className="integration-inputs">
                      {ollamaList.length > 0 ? (
                        <select
                          value={aiModel}
                          onChange={(e) => update("enrich.model.ollama", e.target.value)}
                        >
                          <option value="" disabled>
                            Pick a model…
                          </option>
                          {ollamaList.map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type="text"
                          placeholder="llama3"
                          defaultValue={aiModel}
                          onBlur={(e) => update("enrich.model.ollama", e.target.value)}
                        />
                      )}
                      <button onClick={detectOllama} disabled={detecting}>
                        {detecting ? "Detecting…" : "Detect models"}
                      </button>
                    </div>
                  </div>

                  {detectErr && (
                    <p className="settings-hint" style={{ color: "var(--danger)" }}>
                      {detectErr}
                    </p>
                  )}

                  <p className="settings-hint">
                    The list shows the models you've pulled in Ollama. Use a general{" "}
                    <strong>chat</strong> model — e.g. <code>llama3.2</code>, <code>mistral</code>,
                    or <code>qwen2.5</code>. Embedding models (<code>nomic-embed-text</code>) can't
                    generate text, and vision models (<code>llava</code>, <code>moondream</code>) do
                    poorly at edits. Install one in a terminal, then Detect again:
                    <br />
                    <code>ollama pull llama3.2</code>
                  </p>
                </>
              )}

              {aiProvider !== "none" && aiProvider !== "ollama" && (
                <label className="settings-field">
                  <span>AI spend cap per batch (USD)</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    defaultValue={spendCap}
                    onBlur={(e) =>
                      update(
                        "enrich.spend_cap_usd",
                        e.target.value.replace(/[^0-9.]/g, "") || "1.0",
                      )
                    }
                  />
                </label>
              )}

              <p className="settings-hint">
                Enrich always tries free MusicBrainz first, then AcoustID
                fingerprinting for local files (needs the free key + fpcalc),
                and only then the AI — whose cleaned guess is re-checked against
                MusicBrainz. The spend cap stops paid calls mid-batch; free
                tiers keep running. Ollama runs locally and costs nothing.
              </p>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
