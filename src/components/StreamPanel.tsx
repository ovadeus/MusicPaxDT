import { useState } from "react";
import { Plus } from "lucide-react";
import * as ipc from "../lib/ipc";
import type { Track } from "../lib/types";

interface Props {
  curator: boolean;
  onAdded: (track: Track) => void;
  onError: (message: string) => void;
}

/// "Stream" source header + add-URL bar. Adding stores a direct audio/video URL
/// (e.g. an Archive.org file) in the library as a STREAM_PLAYABLE track; the
/// list below is the real library table filtered to those streams, so it mirrors
/// the library (title/artist/album/year/genre, edit, enrich, add-to-playlist).
export default function StreamPanel({ curator, onAdded, onError }: Props) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);

  const add = async () => {
    const u = url.trim();
    if (!u) return;
    setBusy(true);
    try {
      const track = await ipc.importDirectStream(u);
      setUrl("");
      onAdded(track);
    } catch (e) {
      onError(`${e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stream-head">
      <div className="stream-head-text">
        <h2>Direct Streams</h2>
        <p>
          Paste a direct link to an audio or video file (MP3, MP4, OGG, WAV… — e.g. an
          Archive.org download URL). It’s added to your library below and plays inline.
        </p>
      </div>
      {curator && (
        <div className="stream-add">
          <input
            className="search-box"
            placeholder="https://…/file.mp3"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
          <button className="import-button" onClick={add} disabled={busy || !url.trim()}>
            <Plus size={15} /> {busy ? "Adding…" : "Add to Library"}
          </button>
        </div>
      )}
    </div>
  );
}
