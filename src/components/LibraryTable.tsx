import {
  Disc3,
  Flag,
  Link as LinkIcon,
  Pencil,
  RadioTower,
  Sparkles,
  SquarePlay,
} from "lucide-react";
import type { PlaylistInfo, SortField, SortSpec, Track } from "../lib/types";

interface Props {
  tracks: Track[];
  heading?: string;
  searchable: boolean;
  query: string;
  onQueryChange: (q: string) => void;
  sort: SortSpec;
  onSortChange: (s: SortSpec) => void;
  onActivate: (track: Track) => void;
  onEdit: (track: Track) => void;
  onEnrich: (track: Track) => void;
  enrichingId: number | null;
  nowPlayingId: number | null;
  playlists: PlaylistInfo[];
  onAddToPlaylist: (playlistId: number, trackId: number) => void;
}

/// Icon per capability, refined by source (YouTube streams get the YouTube
/// glyph; RadioTower stays for radio streams arriving in M3).
export function capabilityIcon(t: Track): {
  Icon: typeof Disc3;
  label: string;
  className: string;
} {
  switch (t.capability) {
    case "OWNED":
      return {
        Icon: Disc3,
        label: "OWNED — local audio, can decode, mix and record",
        className: "cap-owned",
      };
    case "STREAM_PLAYABLE":
      return {
        Icon: t.sourceKind === "youtube" ? SquarePlay : RadioTower,
        label: "STREAM PLAYABLE — plays inline only, no DSP or recording",
        className: t.sourceKind === "youtube" ? "cap-youtube" : "cap-stream",
      };
    default:
      return {
        Icon: LinkIcon,
        label: "LINK ONLY — opens externally",
        className: "cap-link",
      };
  }
}

const COLUMNS: { field: SortField; label: string }[] = [
  { field: "title", label: "Title" },
  { field: "artist", label: "Artist" },
  { field: "album", label: "Album" },
  { field: "genre", label: "Genre" },
  { field: "year", label: "Year" },
  { field: "duration_ms", label: "Length" },
];

export function formatDuration(ms: number | null): string {
  if (ms == null || ms < 0) return "–:––";
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function LibraryTable(props: Props) {
  const {
    tracks,
    heading,
    searchable,
    query,
    onQueryChange,
    sort,
    onSortChange,
    onActivate,
    onEdit,
    onEnrich,
    enrichingId,
    nowPlayingId,
    playlists,
    onAddToPlaylist,
  } = props;

  const toggleSort = (field: SortField) => {
    if (sort.field === field) {
      onSortChange({ field, dir: sort.dir === "asc" ? "desc" : "asc" });
    } else {
      onSortChange({ field, dir: "asc" });
    }
  };

  const arrow = (field: SortField) =>
    sort.field === field ? (sort.dir === "asc" ? " ▲" : " ▼") : "";

  return (
    <section className="library">
      <div className="library-toolbar">
        {heading && <h2 className="library-heading">{heading}</h2>}
        {searchable && (
          <input
            type="search"
            className="search-box"
            placeholder="Search title, artist, album, genre…"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
          />
        )}
        <span className="track-count">
          {tracks.length} track{tracks.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="library-scroll">
        <table className="library-table">
          <thead>
            <tr>
              <th className="cap-col" title="Capability">
                <Flag size={12} />
              </th>
              {COLUMNS.map((c) => (
                <th key={c.field} onClick={() => toggleSort(c.field)}>
                  {c.label}
                  {arrow(c.field)}
                </th>
              ))}
              <th className="add-col" />
            </tr>
          </thead>
          <tbody>
            {tracks.length === 0 ? (
              <tr>
                <td className="empty-row" colSpan={COLUMNS.length + 2}>
                  {heading
                    ? "This playlist is empty — add tracks with the + button."
                    : "Library is empty — use “Import Folder” or “Add URL” to add music."}
                </td>
              </tr>
            ) : (
              tracks.map((t) => {
                const cap = capabilityIcon(t);
                return (
                  <tr
                    key={t.id}
                    className={t.id === nowPlayingId ? "playing" : ""}
                    onDoubleClick={() => onActivate(t)}
                  >
                    <td className="cap-col">
                      <span className={`cap-icon ${cap.className}`} title={cap.label}>
                        <cap.Icon size={15} />
                      </span>
                    </td>
                    <td>{t.title ?? "—"}</td>
                    <td>{t.artist ?? "—"}</td>
                    <td>{t.album ?? "—"}</td>
                    <td>{t.genre ?? "—"}</td>
                    <td>{t.year ?? "—"}</td>
                    <td className="num">{formatDuration(t.durationMs)}</td>
                    <td className="add-col">
                      <div className="row-actions">
                        <button
                          className={`row-edit${enrichingId === t.id ? " spinning" : ""}`}
                          title="Auto-fill tags (MusicBrainz / fingerprint / AI)"
                          disabled={enrichingId != null}
                          onClick={(e) => {
                            e.stopPropagation();
                            onEnrich(t);
                          }}
                        >
                          <Sparkles size={13} />
                        </button>
                        <button
                          className="row-edit"
                          title="Edit title & tags"
                          onClick={(e) => {
                            e.stopPropagation();
                            onEdit(t);
                          }}
                        >
                          <Pencil size={13} />
                        </button>
                        {playlists.length > 0 && (
                          <select
                            className="add-to-playlist"
                            title="Add to playlist"
                            value=""
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => {
                              const id = Number(e.target.value);
                              if (id) onAddToPlaylist(id, t.id);
                              e.target.value = "";
                            }}
                          >
                            <option value="">+</option>
                            {playlists.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
