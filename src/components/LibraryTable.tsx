import { useEffect, useRef, useState } from "react";
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
  curator: boolean;
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

interface Column {
  field: SortField;
  label: string;
  cell: (t: Track) => string;
  num?: boolean;
  /// Hidden first when the table gets narrow.
  hideWhenNarrow?: boolean;
}

const COLUMNS: Column[] = [
  { field: "title", label: "Title", cell: (t) => t.title ?? "—" },
  { field: "artist", label: "Artist", cell: (t) => t.artist ?? "—" },
  { field: "album", label: "Album", cell: (t) => t.album ?? "—", hideWhenNarrow: true },
  { field: "genre", label: "Genre", cell: (t) => t.genre ?? "—", hideWhenNarrow: true },
  {
    field: "year",
    label: "Year",
    cell: (t) => (t.year != null ? String(t.year) : "—"),
    hideWhenNarrow: true,
  },
  {
    field: "duration_ms",
    label: "Length",
    cell: (t) => formatDuration(t.durationMs),
    num: true,
  },
];

// Below this content width, drop Album/Genre/Year to keep Title/Artist/Length
// readable (e.g. when the Now Playing panel is open on a small window).
const COMPACT_WIDTH = 620;

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
    curator,
    enrichingId,
    nowPlayingId,
    playlists,
    onAddToPlaylist,
  } = props;

  // Hide secondary columns when the table is narrow.
  const sectionRef = useRef<HTMLElement | null>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setCompact(entry.contentRect.width < COMPACT_WIDTH);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const columns = compact ? COLUMNS.filter((c) => !c.hideWhenNarrow) : COLUMNS;

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
    <section className="library" ref={sectionRef}>
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
              {columns.map((c) => (
                <th
                  key={c.field}
                  className={c.num ? "num" : undefined}
                  onClick={() => toggleSort(c.field)}
                >
                  {c.label}
                  {arrow(c.field)}
                </th>
              ))}
              {curator && <th className="add-col" />}
            </tr>
          </thead>
          <tbody>
            {tracks.length === 0 ? (
              <tr>
                <td className="empty-row" colSpan={columns.length + 1 + (curator ? 1 : 0)}>
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
                    {columns.map((c) => (
                      <td key={c.field} className={c.num ? "num" : undefined}>
                        {c.cell(t)}
                      </td>
                    ))}
                    {curator && (
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
                    )}
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
