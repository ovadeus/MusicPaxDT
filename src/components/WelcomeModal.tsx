import { useEffect, useState } from "react";
import { Sparkles, Wand2, ListMusic, Bot, Check } from "lucide-react";
import * as ipc from "../lib/ipc";

type Provider = "anthropic" | "openai" | "gemini" | "ollama";

const PROVIDERS: { value: Provider; label: string; placeholder: string }[] = [
  { value: "anthropic", label: "Anthropic (Claude)", placeholder: "sk-ant-…" },
  { value: "openai", label: "OpenAI", placeholder: "sk-…" },
  { value: "gemini", label: "Google Gemini", placeholder: "AIza…" },
  { value: "ollama", label: "Ollama — local, free (no key)", placeholder: "" },
];

const PROVIDER_LABEL: Record<string, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI",
  gemini: "Google Gemini",
  ollama: "local Ollama",
};

interface Props {
  /// Called when the user finishes onboarding (whether they saved a key or
  /// skipped). `saved` is true only when a provider/key was configured.
  onComplete: (saved: boolean) => void;
  onError: (message: string) => void;
}

/// First-run welcome. Introduces the app and offers to add the user's own AI
/// key — optional but encouraged. If a key is already saved on this device
/// (it persists across reinstalls, in the OS keychain), it recognizes that and
/// says so instead of asking again.
export default function WelcomeModal({ onComplete, onError }: Props) {
  const [provider, setProvider] = useState<Provider>("anthropic");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  // Detect an already-configured provider/key from persisted settings (no
  // keychain read — mirrors the launch gate). `existing` is that provider, or
  // null. `override` lets the user replace it from this screen anyway.
  const [checked, setChecked] = useState(false);
  const [existing, setExisting] = useState<string | null>(null);
  const [override, setOverride] = useState(false);

  useEffect(() => {
    let live = true;
    ipc
      .getSettings()
      .then((s) => {
        if (!live) return;
        const p = s["enrich.ai_provider"];
        const ready =
          p === "ollama" || (!!p && p !== "none" && s[`enrich.key_set.${p}`] !== "0");
        setExisting(ready ? p : null);
        setChecked(true);
      })
      .catch(() => {
        if (live) setChecked(true);
      });
    return () => {
      live = false;
    };
  }, []);

  const isCloud = provider !== "ollama";
  const current = PROVIDERS.find((p) => p.value === provider)!;
  const canSave = !busy && (!isCloud || key.trim().length > 0);

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    try {
      if (isCloud) {
        if (provider === "anthropic") await ipc.setAnthropicKey(key.trim());
        else if (provider === "openai") await ipc.setOpenaiKey(key.trim());
        else if (provider === "gemini") await ipc.setGeminiKey(key.trim());
        // Non-secret flag so AI features unlock without reading the keychain
        // at launch (mirrors what Settings writes).
        await ipc.setSetting(`enrich.key_set.${provider}`, "1");
      }
      await ipc.setSetting("enrich.ai_provider", provider);
      onComplete(true);
    } catch (e) {
      onError(`${e}`);
      setBusy(false);
    }
  };

  return (
    <div className="settings-overlay welcome-overlay">
      <div className="settings-panel welcome-panel" onClick={(e) => e.stopPropagation()}>
        <div className="welcome-hero">
          <h2>Welcome to MusicPax</h2>
          <p className="welcome-sub">
            Your local-first music library, vintage receiver, and playlist studio —
            import your own music, tune in radio and streams, and build playlists.
          </p>
        </div>

        {!checked ? null : existing && !override ? (
          // A key/provider is already saved on this device — recognize it.
          <div className="welcome-ai">
            <h3>
              <Check size={16} /> AI is ready
            </h3>
            <p className="welcome-ai-lead">
              Using your existing <strong>{PROVIDER_LABEL[existing] ?? existing}</strong>{" "}
              {existing === "ollama" ? "setup" : "API key"} — it's saved on this device, so
              you're all set. The AI playlist builder, tag cleanup, and Assistant are ready.
            </p>
            <div className="welcome-actions">
              <button className="import-button" onClick={() => onComplete(false)}>
                Continue
              </button>
            </div>
            <button
              className="welcome-skip"
              onClick={() => {
                if (existing !== "ollama") setProvider(existing as Provider);
                setOverride(true);
              }}
            >
              Use a different provider or key
            </button>
          </div>
        ) : (
          <div className="welcome-ai">
            <h3>
              <Sparkles size={16} /> Supercharge it with AI
            </h3>
            <p className="welcome-ai-lead">
              Add your own AI key to unlock the smart features. It's optional — the
              rest of MusicPax works without it.
            </p>
            <ul className="welcome-benefits">
              <li>
                <ListMusic size={15} />
                <span>
                  <strong>Build a playlist from a text prompt</strong> — e.g. "upbeat
                  90s road-trip songs" → mirrored to official YouTube.
                </span>
              </li>
              <li>
                <Wand2 size={15} />
                <span>
                  <strong>Clean up messy titles &amp; tags</strong> automatically.
                </span>
              </li>
              <li>
                <Bot size={15} />
                <span>
                  <strong>AI Assistant</strong> for natural-language library edits.
                </span>
              </li>
            </ul>

            <div className="welcome-fields">
              <label className="settings-field">
                <span>AI provider</span>
                <select
                  value={provider}
                  disabled={busy}
                  onChange={(e) => setProvider(e.target.value as Provider)}
                >
                  {PROVIDERS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>

              {isCloud ? (
                <label className="settings-field">
                  <span>{current.label.replace(/\s*\(.*\)/, "")} API key</span>
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={current.placeholder}
                    value={key}
                    disabled={busy}
                    autoFocus
                    onChange={(e) => setKey(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") save();
                    }}
                  />
                </label>
              ) : (
                <p className="settings-hint">
                  Uses a local Ollama server — no key and no cost. You can pick the
                  model later in Settings.
                </p>
              )}
            </div>

            <p className="welcome-privacy">
              Your key is stored only on this device, in the macOS keychain, and
              persists across app updates. Everyone uses their own key — you're never
              billed for anyone else, and no one is billed for you.
            </p>

            <div className="welcome-actions">
              <button className="import-button" onClick={save} disabled={!canSave}>
                {busy ? "Saving…" : isCloud ? "Save key & continue" : "Use Ollama & continue"}
              </button>
            </div>
            <button
              className="welcome-skip"
              onClick={() => onComplete(false)}
              disabled={busy}
            >
              Skip for now — I'll add a key later in Settings
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
