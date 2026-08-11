import { useState } from "react";
import { Sparkles, Trash2, X } from "lucide-react";
import * as ipc from "../lib/ipc";
import { MEDIA_TYPES } from "../lib/mediaTypes";
import type { MediaType, Track } from "../lib/types";

interface Props {
  track: Track;
  onClose: () => void;
  onSaved: (track: Track) => void;
  onDeleted: (track: Track) => void;
  onError: (message: string) => void;
  onInfo?: (message: string) => void;
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
  onInfo,
}: Props) {
  const [title, setTitle] = useState(track.title ?? "");
  const [artist, setArtist] = useState(track.artist ?? "");
  const [album, setAlbum] = useState(track.album ?? "");
  const [year, setYear] = useState(track.year != null ? String(track.year) : "");
  const [genre, setGenre] = useState(track.genre ?? "");
  const [mediaType, setMediaType] = useState<MediaType>(track.mediaType ?? "music");
  const [uri, setUri] = useState(track.uri);
  const [busy, setBusy] = useState(false);
  const [looking, setLooking] = useState(false);

  const writesToFile = track.capability === "OWNED" && track.sourceKind === "local";
  // Only STREAM_PLAYABLE YouTube tracks expose an editable source URL — paste a
  // different video to swap it (e.g. a dead/region-blocked video, or a better
  // match). The embed reads the id straight off the uri, so the swap is live.
  const isYouTube = track.capability === "STREAM_PLAYABLE" && track.sourceKind === "youtube";

  // Fill in missing tags for THIS track from the open-source enrichment chain
  // (free MusicBrainz / AcoustID fingerprint first, AI only if configured).
  // Only blank fields are filled, so it never clobbers what you've typed.
  const lookupTags = async () => {
    setLooking(true);
    try {
      // Search with what's in the dialog now (cleaned of "- Topic"/"(Remastered)"
      // noise inside the lookup), so correcting the artist/title first helps.
      const s = await ipc.lookupTrackTags(track.id, title, artist);
      if (!s) {
        onInfo?.("No metadata match found — try fixing the artist/title, then look up again.");
        return;
      }
      if (!album.trim() && s.album) setAlbum(s.album);
      if (!year.trim() && s.year != null) setYear(String(s.year));
      if (!genre.trim() && s.genre) setGenre(s.genre);
      // Offer the canonical title/artist too — usually tidier than the label.
      if (s.title) setTitle(s.title);
      if (s.artist) setArtist(s.artist);
      onInfo?.(
        `Filled from ${s.source} (${Math.round(s.confidence * 100)}% match) — review, then Save.`,
      );
    } catch (e) {
      onError(`${e}`);
    } finally {
      setLooking(false);
    }
  };

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
        mediaType,
        // Only send a uri swap for YouTube; blank leaves it unchanged.
        ...(isYouTube && uri.trim() ? { uri: uri.trim() } : {}),
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
          <button
            className="edit-lookup"
            onClick={lookupTags}
            disabled={busy || looking}
            title="Look up missing tags online (MusicBrainz / fingerprint, AI if configured)"
          >
            <Sparkles size={13} /> {looking ? "Looking…" : "Look up tags"}
          </button>
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

        <label className="edit-field">
          <span>Type</span>
          <select value={mediaType} onChange={(e) => setMediaType(e.target.value as MediaType)}>
            {MEDIA_TYPES.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
        </label>

        {isYouTube && (
          <label className="edit-field">
            <span>YouTube URL</span>
            <input
              value={uri}
              onChange={(e) => setUri(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && save()}
              placeholder="https://www.youtube.com/watch?v=…"
              spellCheck={false}
            />
          </label>
        )}

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
            : isYouTube
              ? "Changes update the library entry. Paste a different YouTube URL to swap the video."
              : "Changes update the library entry (streams have no file to tag)."}
        </p>
      </div>
    </div>
  );
}
