import { useEffect, useRef, useState } from "react";
import {
  Disc3,
  Flag,
  Link as LinkIcon,
  Music,
  Pencil,
  RadioTower,
  Sparkles,
  Square,
  SquarePlay,
} from "lucide-react";
import { MEDIA_TYPES, mediaTypeMeta } from "../lib/mediaTypes";
import type { MediaType, PlaylistInfo, SortField, SortSpec, Track } from "../lib/types";

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
  /// Media-type filter chips (All + the 6 types). Shown when onMediaType is set.
  mediaType?: MediaType | null;
  onMediaType?: (t: MediaType | null) => void;
  /// Curator inline-rename of the heading (e.g. a playlist title). Shows a pencil.
  onRenameHeading?: (name: string) => void;
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
    case "STREAM_PLAYABLE": {
      const Icon =
        t.sourceKind === "youtube"
          ? SquarePlay
          : t.sourceKind === "stream"
            ? Music
            : RadioTower;
      return {
        Icon,
        label: "STREAM PLAYABLE — plays inline only, no DSP or recording",
        className: t.sourceKind === "youtube" ? "cap-youtube" : "cap-stream",
      };
    }
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
    hideWhenNarrow: true,
  },
];

// Below this content width, drop Album/Genre/Year/Length to keep Title/Artist
// readable (e.g. a small window, or the Now Playing panel open in Curator mode).
const COMPACT_WIDTH = 680;

// Columns the user can manually collapse to a single icon to streamline the list.
const COLLAPSIBLE: ReadonlySet<SortField> = new Set(["album", "genre", "year"]);
const COLLAPSED_KEY = "library.collapsedCols";

function loadCollapsed(): Set<SortField> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

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
    mediaType,
    onMediaType,
    onRenameHeading,
  } = props;

  const [editingHeading, setEditingHeading] = useState(false);
  const [headingDraft, setHeadingDraft] = useState("");
  const cancelHeading = useRef(false);
  const commitHeading = () => {
    setEditingHeading(false);
    const name = headingDraft.trim();
    if (name && name !== heading) onRenameHeading?.(name);
  };

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

  // Per-column collapse (Album/Genre/Year): show only the toggle square, hide
  // the data, to streamline the list. Persisted across sessions.
  const [collapsed, setCollapsed] = useState<Set<SortField>>(loadCollapsed);
  const toggleCollapse = (field: SortField) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      return next;
    });
  };

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
        {heading &&
          (editingHeading && curator ? (
            <input
              className="library-heading-input"
              autoFocus
              value={headingDraft}
              onChange={(e) => setHeadingDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                else if (e.key === "Escape") {
                  cancelHeading.current = true;
                  e.currentTarget.blur();
                }
              }}
              onBlur={() => {
                if (cancelHeading.current) {
                  cancelHeading.current = false;
                  setEditingHeading(false);
                } else {
                  commitHeading();
                }
              }}
            />
          ) : (
            <span className="library-heading-row">
              <h2 className="library-heading">{heading}</h2>
              {curator && onRenameHeading && (
                <button
                  className="library-heading-edit"
                  title="Rename playlist"
                  onClick={() => {
                    setHeadingDraft(heading);
                    setEditingHeading(true);
                  }}
                >
                  <Pencil size={13} />
                </button>
              )}
            </span>
          ))}
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
        {onMediaType && (
          <div className="mtype-chips" role="tablist" aria-label="Filter by type">
            <button
              className={`mtype-chip${mediaType == null ? " active" : ""}`}
              onClick={() => onMediaType(null)}
            >
              All
            </button>
            {MEDIA_TYPES.map((m) => (
              <button
                key={m.key}
                className={`mtype-chip${mediaType === m.key ? " active" : ""}`}
                title={m.label}
                onClick={() => onMediaType(mediaType === m.key ? null : m.key)}
              >
                <m.Icon size={15} style={{ color: m.color }} />
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="library-scroll">
        <table className="library-table">
          <thead>
            <tr>
              <th className="cap-col" title="Capability">
                <Flag size={12} />
              </th>
              <th className="type-col">Type</th>
              {columns.map((c) => {
                const collapsible = COLLAPSIBLE.has(c.field);
                const isCollapsed = collapsible && collapsed.has(c.field);
                const cls = [c.num ? "num" : "", isCollapsed ? "col-collapsed" : ""]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <th key={c.field} className={cls || undefined}>
                    {collapsible && (
                      <button
                        className="col-toggle"
                        title={isCollapsed ? `Show ${c.label}` : `Hide ${c.label}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleCollapse(c.field);
                        }}
                      >
                        <Square size={11} fill={isCollapsed ? "none" : "currentColor"} />
                      </button>
                    )}
                    {!isCollapsed && (
                      <span className="col-label" onClick={() => toggleSort(c.field)}>
                        {c.label}
                        {arrow(c.field)}
                      </span>
                    )}
                  </th>
                );
              })}
              {curator && <th className="add-col" />}
            </tr>
          </thead>
          <tbody>
            {tracks.length === 0 ? (
              <tr>
                <td className="empty-row" colSpan={columns.length + 2 + (curator ? 1 : 0)}>
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
                    {(() => {
                      const mt = mediaTypeMeta(t.mediaType);
                      return (
                        <td className="type-col">
                          <span className="type-badge" title={mt.label}>
                            <mt.Icon size={14} style={{ color: mt.color }} />
                            <span className="type-label">{mt.label}</span>
                          </span>
                        </td>
                      );
                    })()}
                    {columns.map((c) => {
                      const isCollapsed = COLLAPSIBLE.has(c.field) && collapsed.has(c.field);
                      const cls = [c.num ? "num" : "", isCollapsed ? "col-collapsed" : ""]
                        .filter(Boolean)
                        .join(" ");
                      return (
                        <td key={c.field} className={cls || undefined}>
                          {isCollapsed ? "" : c.cell(t)}
                        </td>
                      );
                    })}
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
