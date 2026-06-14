import { useEffect, useState } from "react";
import { X } from "lucide-react";
import * as ipc from "../lib/ipc";
import type { MirrorProgress } from "../lib/types";

type AddUrlMode = "youtube" | "spotify";

interface Props {
  mode: AddUrlMode;
  onClose: () => void;
  onError: (message: string) => void;
  onDone: (message: string) => void;
}

const COPY: Record<
  AddUrlMode,
  { title: string; placeholder: string; hint: string }
> = {
  youtube: {
    title: "Add YouTube URL",
    placeholder: "Paste a YouTube video URL (https://www.youtube.com/watch?v=…)",
    hint: "Imports the video as a 📺 STREAM_PLAYABLE track that plays in the official YouTube player.",
  },
  spotify: {
    title: "Add Spotify Playlist",
    placeholder:
      "Paste a Spotify playlist URL — or an Artist - Title list, one per line",
    hint: "Mirrors the playlist to YouTube streams (public playlists need no Spotify key; add credentials in Settings for private/long ones).",
  },
};

/// Paste a YouTube link (single track), a Spotify playlist URL, or an
/// "Artist - Title" list / Exportify CSV (mirrored to YouTube streams).
export default function AddUrlModal({ mode, onClose, onError, onDone }: Props) {
  const copy = COPY[mode];
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
          <h2>{copy.title}</h2>
          <button className="settings-close" onClick={onClose} disabled={busy} title="Close">
            <X size={15} />
          </button>
        </div>

        <textarea
          className="addurl-input"
          rows={mode === "spotify" ? 6 : 2}
          placeholder={copy.placeholder}
          value={input}
          autoFocus
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
            {busy ? "Working…" : mode === "spotify" ? "Mirror" : "Add"}
          </button>
        </div>

        <p className="settings-hint">{copy.hint}</p>
      </div>
    </div>
  );
}
