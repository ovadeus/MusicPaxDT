import { useState } from "react";
import { Trash2, X } from "lucide-react";
import * as ipc from "../lib/ipc";
import type { Track } from "../lib/types";

interface Props {
  track: Track;
  onClose: () => void;
  onSaved: (track: Track) => void;
  onDeleted: (track: Track) => void;
  onError: (message: string) => void;
}

/// Edit a track's title and metadata tags. For OWNED local files the changes
/// are also written back into the file's tags; for streams they update the
/// library entry only.
export default function TrackEditModal({
  track,
  onClose,
  onSaved,
  onDeleted,
  onError,
}: Props) {
  const [title, setTitle] = useState(track.title ?? "");
  const [artist, setArtist] = useState(track.artist ?? "");
  const [album, setAlbum] = useState(track.album ?? "");
  const [year, setYear] = useState(track.year != null ? String(track.year) : "");
  const [genre, setGenre] = useState(track.genre ?? "");
  const [busy, setBusy] = useState(false);

  const writesToFile = track.capability === "OWNED" && track.sourceKind === "local";

  const remove = async () => {
    const ok = window.confirm(
      `Remove “${track.title ?? "this track"}” from the library?\n\nThis only removes the library entry${
        writesToFile ? " — your audio file on disk is not deleted." : "."
      }`,
    );
    if (!ok) return;
    setBusy(true);
    try {
      await ipc.deleteTrack(track.id);
      onDeleted(track);
      onClose();
    } catch (e) {
      onError(`${e}`);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      const parsedYear = year.trim() ? Number.parseInt(year.trim(), 10) : null;
      const updated = await ipc.updateTrackMetadata(track.id, {
        title: title.trim() || null,
        artist: artist.trim() || null,
        album: album.trim() || null,
        year: parsedYear != null && !Number.isNaN(parsedYear) ? parsedYear : null,
        genre: genre.trim() || null,
      });
      onSaved(updated);
      onClose();
    } catch (e) {
      onError(`${e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-overlay" onClick={busy ? undefined : onClose}>
      <div className="settings-panel edit-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Edit track</h2>
          <button className="settings-close" onClick={onClose} disabled={busy} title="Close">
            <X size={15} />
          </button>
        </div>

        <label className="edit-field">
          <span>Title</span>
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
          />
        </label>
        <label className="edit-field">
          <span>Artist</span>
          <input
            value={artist}
            onChange={(e) => setArtist(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
          />
        </label>
        <label className="edit-field">
          <span>Album</span>
          <input
            value={album}
            onChange={(e) => setAlbum(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
          />
        </label>
        <div className="edit-row">
          <label className="edit-field">
            <span>Year</span>
            <input
              inputMode="numeric"
              value={year}
              onChange={(e) => setYear(e.target.value.replace(/[^0-9]/g, ""))}
              onKeyDown={(e) => e.key === "Enter" && save()}
            />
          </label>
          <label className="edit-field">
            <span>Genre</span>
            <input
              value={genre}
              onChange={(e) => setGenre(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && save()}
            />
          </label>
        </div>

        <div className="edit-actions">
          <button className="delete-button" onClick={remove} disabled={busy}>
            <Trash2 size={14} /> Delete
          </button>
          <button className="import-button" onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>

        <p className="settings-hint">
          {writesToFile
            ? "Changes are saved to the library and written into the file's tags."
            : "Changes update the library entry (streams have no file to tag)."}
        </p>
      </div>
    </div>
  );
}
