import { useEffect, useState } from "react";
import { X } from "lucide-react";
import * as ipc from "../lib/ipc";
import type { MirrorProgress } from "../lib/types";

const DEFAULT_COUNT = 25;
/// Mirrors `ai::PLAYLIST_MAX_TRACKS` in the Rust core, which clamps too.
const MAX_COUNT = 100;

/// Friendly names for the `enrich.ai_provider` setting values.
const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI",
  gemini: "Google Gemini",
  ollama: "Ollama (local)",
};

interface Props {
  /// The configured provider (the `enrich.ai_provider` setting value), or null
  /// when none is set up — the modal then points at Settings instead.
  providerLabel: string | null;
  onClose: () => void;
  onError: (message: string) => void;
  onDone: (message: string) => void;
  onOpenSettings: () => void;
}

function clampCount(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_COUNT;
  return Math.min(MAX_COUNT, Math.max(1, n));
}

/// "Build Playlist With a Text Prompt": describe a playlist in plain language;
/// the configured AI drafts an Artist - Title list and the Mirror Engine
/// resolves it to official YouTube embeds, exactly like a pasted Spotify list.
export default function BuildPlaylistWithAIModal({
  providerLabel,
  onClose,
  onError,
  onDone,
  onOpenSettings,
}: Props) {
  const [prompt, setPrompt] = useState("");
  const [countText, setCountText] = useState(String(DEFAULT_COUNT));
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<MirrorProgress | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    ipc.onMirrorProgress(setProgress).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const submit = async () => {
    const trimmed = prompt.trim();
    if (!trimmed || !providerLabel || busy) return;
    const count = clampCount(countText);
    setCountText(String(count));
    setBusy(true);
    setProgress(null);
    try {
      const report = await ipc.aiBuildPlaylist(trimmed, count);
      const failures = report.failed.length
        ? ` — ${report.failed.length} could not be matched`
        : "";
      onDone(
        `Built “${report.playlistName}”: ${report.matched}/${report.total} tracks${failures}`,
      );
      onClose();
    } catch (e) {
      onError(`${e}`);
    } finally {
      setBusy(false);
    }
  };

  // The AI drafting step has no progress events; the mirror step does.
  const mirroring = busy && progress != null && progress.total > 0;
  const providerName = providerLabel ? (PROVIDER_NAMES[providerLabel] ?? providerLabel) : "";

  return (
    <div className="settings-overlay" onClick={busy ? undefined : onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Build Playlist With a Text Prompt</h2>
          <button className="settings-close" onClick={onClose} disabled={busy} title="Close">
            <X size={15} />
          </button>
        </div>

        {providerLabel ? (
          <>
            <textarea
              className="addurl-input"
              rows={4}
              placeholder="Describe the playlist you want — e.g. “the greatest disco hits of the 1970s”"
              value={prompt}
              autoFocus
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
              }}
              disabled={busy}
            />

            <div className="aibuild-row">
              <label className="aibuild-count">
                <span>Tracks</span>
                <input
                  type="number"
                  min={1}
                  max={MAX_COUNT}
                  step={1}
                  value={countText}
                  disabled={busy}
                  onChange={(e) => setCountText(e.target.value)}
                  onBlur={(e) => setCountText(String(clampCount(e.target.value)))}
                />
                <span className="aibuild-max">max {MAX_COUNT}</span>
              </label>
              <span className="aibuild-provider">Using {providerName}</span>
            </div>

            {busy && !mirroring && (
              <div className="mirror-progress">
                <div className="mirror-progress-text">
                  Drafting the track list with {providerName}…
                </div>
              </div>
            )}

            {mirroring && progress && (
              <div className="mirror-progress">
                <div className="mirror-progress-bar">
                  <div
                    className="mirror-progress-fill"
                    style={{ width: `${(progress.done / progress.total) * 100}%` }}
                  />
                </div>
                <div className="mirror-progress-text">
                  {progress.done}/{progress.total} · {progress.matched} matched
                  {progress.current ? ` · ${progress.current}` : ""}
                </div>
              </div>
            )}

            <div className="addurl-actions">
              <button
                className="import-button"
                onClick={submit}
                disabled={busy || !prompt.trim()}
              >
                {busy ? "Working…" : "Build"}
              </button>
            </div>

            <p className="settings-hint">
              Your AI provider drafts an Artist - Title list, then each song is
              mirrored to YouTube — preferring official artist, “Topic”, and label
              channels, just like a Spotify import. Nothing is downloaded.
            </p>
          </>
        ) : (
          <>
            <p className="settings-hint">
              Add an Anthropic, OpenAI, or Gemini API key — or point at a local
              Ollama — under <strong>Settings → Integrations → AI provider</strong> to
              build playlists from a text prompt.
            </p>
            <div className="addurl-actions">
              <button className="import-button" onClick={onOpenSettings}>
                Open Settings
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
