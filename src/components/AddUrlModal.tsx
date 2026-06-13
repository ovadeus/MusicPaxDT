import { useEffect, useState } from "react";
import * as ipc from "../lib/ipc";
import type { MirrorProgress } from "../lib/types";

interface Props {
  onClose: () => void;
  onError: (message: string) => void;
  onDone: (message: string) => void;
}

/// Paste a YouTube link (single track), a Spotify playlist URL, or an
/// "Artist - Title" list / Exportify CSV (mirrored to YouTube streams).
export default function AddUrlModal({ onClose, onError, onDone }: Props) {
  const [input, setInput] = useState("");
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
    const trimmed = input.trim();
    if (!trimmed) return;
    setBusy(true);
    setProgress(null);
    try {
      const isSingleYoutube =
        /youtu(\.be|be\.com|be-nocookie\.com)/i.test(trimmed) &&
        !trimmed.includes("\n") &&
        !trimmed.includes("playlist");
      if (isSingleYoutube) {
        const track = await ipc.importStreamUrl(trimmed);
        onDone(`Added “${track.title ?? "stream"}” to the library`);
      } else {
        const report = await ipc.mirrorPlaylist(trimmed);
        const failures = report.failed.length
          ? ` — ${report.failed.length} could not be matched`
          : "";
        onDone(
          `Mirrored “${report.playlistName}”: ${report.matched}/${report.total} tracks${failures}`,
        );
      }
      onClose();
    } catch (e) {
      onError(`${e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-overlay" onClick={busy ? undefined : onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Add URL / Mirror playlist</h2>
          <button className="settings-close" onClick={onClose} disabled={busy} title="Close">
            ✕
          </button>
        </div>

        <textarea
          className="addurl-input"
          rows={6}
          placeholder={
            "Paste one of:\n• a YouTube video URL\n• a Spotify playlist URL (mirrors to YouTube streams)\n• an Artist - Title list, one per line (or Exportify CSV)"
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
        />

        {busy && progress && progress.total > 0 && (
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
          <button className="import-button" onClick={submit} disabled={busy || !input.trim()}>
            {busy ? "Working…" : "Add / Mirror"}
          </button>
        </div>

        <p className="settings-hint">
          Streams play through the official YouTube player (📡 STREAM PLAYABLE — no
          EQ, no recording). Mirroring creates a playlist with the same name and
          works with no setup: public Spotify playlists are read straight from the
          page (first ~100 tracks). Optional, in Settings → Integrations: Spotify
          credentials for full-length playlists, a YouTube API key for the most
          reliable matching.
        </p>
      </div>
    </div>
  );
}
