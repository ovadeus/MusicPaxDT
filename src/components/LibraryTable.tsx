import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  BarChart3,
  CheckSquare,
  Clock3,
  Disc3,
  Flag,
  Heart,
  LayoutGrid,
  Link as LinkIcon,
  List,
  ListPlus,
  Music,
  Pencil,
  Plus,
  RadioTower,
  Share2,
  Shuffle,
  Sparkles,
  SquarePlay,
  Trash2,
} from "lucide-react";
import MpxLogo from "./MpxLogo";
import MediaTypeFilter from "./MediaTypeFilter";
import { mediaTypeMeta } from "../lib/mediaTypes";
import type { ColumnPrefs } from "../lib/columnPrefs";
import type { MediaType, PlaylistInfo, SortField, SortSpec, Track } from "../lib/types";

type ListenOrder = "recent" | "most_played" | "shuffle";

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
  /// Toggle a track's favorite (heart). Favorited = rating >= 1.
  onToggleFavorite?: (track: Track) => void;
  /// Which optional columns to show (Album/Genre/Year/Length); set in Settings.
  visibleColumns: ColumnPrefs;
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
  /// Click an artist name to filter the library to that artist (all sources).
  onArtist?: (artist: string) => void;
  /// Changes when the view (playlist) switches → fades the list in (300ms).
  fadeKey?: string;
  /// Overrides the empty-state text (e.g. the My Favorites view, which isn't a
  /// playlist and has no + button).
  emptyMessage?: string;
  /// Local-file track ids whose file is missing (shows a relink indicator).
  missingIds?: Set<number>;
  /// Relink a missing local file (opens a file picker).
  onRelink?: (track: Track) => void;
  /// Share the current playlist (shows a share icon left of the track count).
  onShare?: () => void;
  /// Bulk-delete (curator only). When provided, a "Select" toggle appears; the
  /// user checks tracks and deletes them in one batch. Deletes from the library.
  onBulkDelete?: (ids: number[]) => Promise<void> | void;
  /// Add the checked tracks to an existing playlist (one batch call).
  onBulkAddToPlaylist?: (playlistId: number, ids: number[]) => Promise<void> | void;
  /// Create a new playlist from the checked tracks.
  onCreatePlaylistWithTracks?: (name: string, ids: number[]) => Promise<void> | void;
  /// Listen-mode presentation order. Hidden in Curator mode, where table-header
  /// sorting remains the main management affordance.
  listenOrder?: ListenOrder;
  onListenOrderChange?: (order: ListenOrder) => void;
  onReshuffle?: () => void;
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
  {
    field: "play_count",
    label: "Plays",
    cell: (t) => String(t.playCount ?? 0),
    num: true,
    hideWhenNarrow: true,
  },
];

// Maps a toggleable column to its ColumnPrefs key (Title/Artist are always on).
const PREF_KEY: Partial<Record<SortField, keyof ColumnPrefs>> = {
  album: "album",
  genre: "genre",
  year: "year",
  duration_ms: "length",
  play_count: "plays",
};

// Below this content width, drop Album/Genre/Year/Length/Plays to keep Title/Artist
// readable (e.g. a small window, or the Now Playing panel open in Curator mode).
const COMPACT_WIDTH = 680;

export function formatDuration(ms: number | null): string {
  if (ms == null || ms < 0) return "–:––";
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const VIEW_KEY = "library.view";
type ViewMode = "list" | "grid";

/// A web-loadable cover for the grid: a remote/data art URL or a YouTube
/// thumbnail. Local-file art isn't served over localhost, so it falls back to
/// the MusicPax mark.
function gridCoverUrl(t: Track): string | null {
  if (t.artPath && /^(https?:|data:)/.test(t.artPath)) return t.artPath;
  const m = t.uri.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  return m ? `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg` : null;
}

function GridCover({ track }: { track: Track }) {
  const [failed, setFailed] = useState(false);
  const url = gridCoverUrl(track);
  if (!url || failed) return <MpxLogo className="grid-cover-logo" />;
  return (
    <img
      className="grid-cover-img"
      src={url}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
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
    onToggleFavorite,
    visibleColumns,
    curator,
    enrichingId,
    nowPlayingId,
    playlists,
    onAddToPlaylist,
    mediaType,
    onMediaType,
    onRenameHeading,
    onArtist,
    fadeKey,
    emptyMessage,
    missingIds,
    onRelink,
    onShare,
    onBulkDelete,
    onBulkAddToPlaylist,
    onCreatePlaylistWithTracks,
    listenOrder,
    onListenOrderChange,
    onReshuffle,
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

  // Show a column only if the user hasn't hidden it in Settings, then drop the
  // "hide when narrow" ones if the table is too tight (Title/Artist always stay).
  const columns = COLUMNS.filter((c) => {
    const key = PREF_KEY[c.field];
    if (key && !visibleColumns[key]) return false;
    return compact ? !c.hideWhenNarrow : true;
  });

  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    localStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "list",
  );
  const setView = (v: ViewMode) => {
    setViewMode(v);
    localStorage.setItem(VIEW_KEY, v);
  };

  // Bulk selection (curator). `bulkMode` reveals a checkbox per track; selected
  // tracks are removed in a single batch call. Selection is scoped to the
  // currently visible (searched/filtered) tracks.
  const bulkEnabled = curator && !!onBulkDelete;
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [deleting, setDeleting] = useState(false);
  // Bulk playlist actions: an inline "name" field for a new playlist, and a
  // popover picker for adding to an existing one.
  const [working, setWorking] = useState(false);
  const [naming, setNaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addMenuRef = useRef<HTMLDivElement | null>(null);
  const lastIndexRef = useRef<number | null>(null);
  const bulkBusy = deleting || working;

  // Checkboxes may only render where bulk delete is actually available (curator
  // + an onBulkDelete handler). This keeps a stale `bulkMode` from leaking
  // checkboxes into Listening mode after a mode switch.
  const bulkActive = bulkEnabled && bulkMode;

  const selectedVisible = tracks.filter((t) => selectedIds.has(t.id));
  const allVisibleSelected = tracks.length > 0 && selectedVisible.length === tracks.length;

  const exitBulk = () => {
    setBulkMode(false);
    setSelectedIds(new Set());
    setNaming(false);
    setNameDraft("");
    setAddMenuOpen(false);
    lastIndexRef.current = null;
  };

  // Close the "add to playlist" popover on an outside click.
  useEffect(() => {
    if (!addMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
        setAddMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [addMenuOpen]);

  // Toggle one row; Shift extends the range from the last-clicked row (add-only).
  const toggleAt = (index: number, shiftKey: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (shiftKey && lastIndexRef.current != null) {
        const [a, b] =
          lastIndexRef.current <= index
            ? [lastIndexRef.current, index]
            : [index, lastIndexRef.current];
        for (let i = a; i <= b; i++) next.add(tracks[i].id);
      } else {
        const id = tracks[index].id;
        if (next.has(id)) next.delete(id);
        else next.add(id);
      }
      return next;
    });
    lastIndexRef.current = index;
  };

  const selectAllVisible = () =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      tracks.forEach((t) => next.add(t.id));
      return next;
    });
  const clearSelection = () => {
    setSelectedIds(new Set());
    lastIndexRef.current = null;
  };

  const runBulkDelete = async () => {
    const ids = selectedVisible.map((t) => t.id);
    if (ids.length === 0 || !onBulkDelete) return;
    const ok = window.confirm(
      `Delete ${ids.length} track${ids.length === 1 ? "" : "s"} from the library?\n\n` +
        `This removes the library ${
          ids.length === 1 ? "entry" : "entries"
        } (and any playlist references). Audio files on disk are not deleted.`,
    );
    if (!ok) return;
    setDeleting(true);
    try {
      await onBulkDelete(ids);
      clearSelection();
    } finally {
      setDeleting(false);
    }
  };

  const runCreatePlaylist = async () => {
    const ids = selectedVisible.map((t) => t.id);
    const name = nameDraft.trim();
    if (ids.length === 0 || !name || !onCreatePlaylistWithTracks) return;
    setWorking(true);
    try {
      await onCreatePlaylistWithTracks(name, ids);
      exitBulk(); // success only; on error the handler reports and we keep the selection
    } catch {
      /* error surfaced by the handler */
    } finally {
      setWorking(false);
    }
  };

  const runAddToPlaylist = async (playlistId: number) => {
    const ids = selectedVisible.map((t) => t.id);
    if (ids.length === 0 || !onBulkAddToPlaylist) return;
    setAddMenuOpen(false);
    setWorking(true);
    try {
      await onBulkAddToPlaylist(playlistId, ids);
      exitBulk();
    } catch {
      /* error surfaced by the handler */
    } finally {
      setWorking(false);
    }
  };

  const tableSortEnabled = curator || !listenOrder;
  const toggleSort = (field: SortField) => {
    if (!tableSortEnabled) return;
    if (sort.field === field) {
      onSortChange({ field, dir: sort.dir === "asc" ? "desc" : "asc" });
    } else {
      onSortChange({ field, dir: "asc" });
    }
  };

  const arrow = (field: SortField) =>
    tableSortEnabled && sort.field === field ? (sort.dir === "asc" ? " ▲" : " ▼") : "";

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
        {onMediaType && (
          <MediaTypeFilter value={mediaType ?? null} onChange={onMediaType} />
        )}
        {!curator && listenOrder && onListenOrderChange && (
          <div className="listen-order" role="group" aria-label="Listen order">
            <button
              className={listenOrder === "recent" ? "active" : ""}
              title="Recent — newest additions first"
              aria-pressed={listenOrder === "recent"}
              onClick={() => onListenOrderChange("recent")}
            >
              <Clock3 size={15} />
              <span>Recent</span>
            </button>
            <button
              className={listenOrder === "most_played" ? "active" : ""}
              title="Most Played — highest play count first"
              aria-pressed={listenOrder === "most_played"}
              onClick={() => onListenOrderChange("most_played")}
            >
              <BarChart3 size={15} />
              <span>Most</span>
            </button>
            <button
              className={listenOrder === "shuffle" ? "active" : ""}
              title={
                listenOrder === "shuffle"
                  ? "Shuffle — click again to reshuffle"
                  : "Shuffle — randomize the visible tracks"
              }
              aria-pressed={listenOrder === "shuffle"}
              onClick={() => {
                if (listenOrder === "shuffle") onReshuffle?.();
                else onListenOrderChange("shuffle");
              }}
            >
              <Shuffle size={15} />
              <span>Shuffle</span>
            </button>
          </div>
        )}
        <div className="view-toggle" role="group" aria-label="View mode">
          <button
            className={viewMode === "list" ? "active" : ""}
            title="List view"
            onClick={() => setView("list")}
          >
            <List size={16} />
          </button>
          <button
            className={viewMode === "grid" ? "active" : ""}
            title="Grid view"
            onClick={() => setView("grid")}
          >
            <LayoutGrid size={16} />
          </button>
        </div>
        {onShare && (
          <button
            className="library-share"
            title="Share this playlist"
            onClick={onShare}
          >
            <Share2 size={15} />
          </button>
        )}
        {bulkEnabled && (
          <div className="bulk-controls">
            <button
              className={`bulk-toggle${bulkMode ? " active" : ""}`}
              title={bulkMode ? "Exit selection mode" : "Select multiple tracks"}
              aria-pressed={bulkMode}
              onClick={() => (bulkMode ? exitBulk() : setBulkMode(true))}
            >
              <CheckSquare size={15} />
              <span>Select</span>
            </button>
            {bulkMode && (
              <button
                className="bulk-selectall"
                onClick={allVisibleSelected ? clearSelection : selectAllVisible}
                disabled={bulkBusy || tracks.length === 0}
              >
                {allVisibleSelected ? "Deselect all" : "Select all"}
              </button>
            )}
            {bulkMode && selectedVisible.length > 0 && naming ? (
              <div className="bulk-name">
                <input
                  autoFocus
                  placeholder="New playlist name"
                  value={nameDraft}
                  disabled={bulkBusy}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") runCreatePlaylist();
                    else if (e.key === "Escape") {
                      setNaming(false);
                      setNameDraft("");
                    }
                  }}
                />
                <button
                  className="bulk-create"
                  onClick={runCreatePlaylist}
                  disabled={bulkBusy || !nameDraft.trim()}
                >
                  Create ({selectedVisible.length})
                </button>
                <button
                  className="bulk-clear"
                  onClick={() => {
                    setNaming(false);
                    setNameDraft("");
                  }}
                  disabled={bulkBusy}
                >
                  Cancel
                </button>
              </div>
            ) : (
              bulkMode &&
              selectedVisible.length > 0 && (
                <>
                  {onCreatePlaylistWithTracks && (
                    <button
                      className="bulk-action"
                      onClick={() => {
                        setAddMenuOpen(false);
                        setNaming(true);
                      }}
                      disabled={bulkBusy}
                      title="Create a new playlist from the selected tracks"
                    >
                      <Plus size={14} /> New Playlist
                    </button>
                  )}
                  {onBulkAddToPlaylist && playlists.length > 0 && (
                    <div className="bulk-addwrap" ref={addMenuRef}>
                      <button
                        className="bulk-action"
                        onClick={() => setAddMenuOpen((o) => !o)}
                        disabled={bulkBusy}
                        aria-expanded={addMenuOpen}
                        aria-haspopup="menu"
                        title="Add the selected tracks to an existing playlist"
                      >
                        <ListPlus size={14} /> Add to ▾
                      </button>
                      {addMenuOpen && (
                        <div className="bulk-addmenu" role="menu">
                          {playlists.map((p) => (
                            <button
                              key={p.id}
                              role="menuitem"
                              onClick={() => runAddToPlaylist(p.id)}
                              disabled={bulkBusy}
                            >
                              {p.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  <button className="bulk-delete" onClick={runBulkDelete} disabled={bulkBusy}>
                    <Trash2 size={14} /> Delete ({selectedVisible.length})
                  </button>
                  <button className="bulk-clear" onClick={clearSelection} disabled={bulkBusy}>
                    Clear
                  </button>
                </>
              )
            )}
          </div>
        )}
        <span className="track-count">
          {tracks.length} track{tracks.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="library-scroll" key={fadeKey}>
        {viewMode === "grid" ? (
          tracks.length === 0 ? (
            <div className="grid-empty">
              {heading
                ? "This playlist is empty — add tracks with the + button."
                : "Library is empty — use “Import Folder” or “Add URL” to add music."}
            </div>
          ) : (
            <div className="library-grid">
              {tracks.map((t, idx) => (
                <div
                  key={t.id}
                  className={`grid-card${t.id === nowPlayingId ? " playing" : ""}${
                    bulkActive && selectedIds.has(t.id) ? " selected" : ""
                  }`}
                  title={`${t.title ?? "Untitled"}${t.artist ? ` — ${t.artist}` : ""}`}
                  onClick={(e) => (bulkActive ? toggleAt(idx, e.shiftKey) : onActivate(t))}
                  onDoubleClick={() => onActivate(t)}
                >
                  <div className="grid-cover">
                    {bulkActive && (
                      <input
                        type="checkbox"
                        className="grid-select"
                        checked={selectedIds.has(t.id)}
                        aria-label="Select track"
                        onChange={() => {}}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleAt(idx, e.shiftKey);
                        }}
                      />
                    )}
                    <GridCover track={t} />
                    {curator && (
                      <button
                        className="grid-edit"
                        title="Edit title & tags"
                        onClick={(e) => {
                          e.stopPropagation();
                          onEdit(t);
                        }}
                      >
                        <Pencil size={13} />
                      </button>
                    )}
                  </div>
                  <div className="grid-title">{t.title ?? "Untitled"}</div>
                  <div className="grid-artist">{t.artist ?? "—"}</div>
                </div>
              ))}
            </div>
          )
        ) : (
        <table className="library-table">
          <thead>
            <tr>
              {bulkActive && (
                <th className="sel-col">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={allVisibleSelected}
                    onChange={() => (allVisibleSelected ? clearSelection() : selectAllVisible())}
                  />
                </th>
              )}
              <th className="cap-col" title="Capability">
                <Flag size={12} />
              </th>
              <th className="type-col">Type</th>
              <th className="fav-col" title="Favorite">
                <Heart size={12} />
              </th>
              {columns.map((c) => (
                <th key={c.field} className={c.num ? "num" : undefined}>
                  <span
                    className={`col-label${tableSortEnabled ? "" : " disabled"}`}
                    onClick={() => toggleSort(c.field)}
                  >
                    {c.label}
                    {arrow(c.field)}
                  </span>
                </th>
              ))}
              {curator && <th className="add-col" />}
            </tr>
          </thead>
          <tbody>
            {tracks.length === 0 ? (
              <tr>
                <td
                  className="empty-row"
                  colSpan={columns.length + 3 + (curator ? 1 : 0) + (bulkActive ? 1 : 0)}
                >
                  {emptyMessage ??
                    (heading
                      ? "This playlist is empty — add tracks with the + button."
                      : "Library is empty — use “Import Folder” or “Add URL” to add music.")}
                </td>
              </tr>
            ) : (
              tracks.map((t, idx) => {
                const cap = capabilityIcon(t);
                return (
                  <tr
                    key={t.id}
                    className={`${t.id === nowPlayingId ? "playing" : ""}${
                      missingIds?.has(t.id) ? " missing" : ""
                    }${bulkActive && selectedIds.has(t.id) ? " selected" : ""}`}
                    onClick={bulkActive ? (e) => toggleAt(idx, e.shiftKey) : undefined}
                    onDoubleClick={() => onActivate(t)}
                  >
                    {bulkActive && (
                      <td className="sel-col">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(t.id)}
                          aria-label="Select track"
                          onChange={() => {}}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleAt(idx, e.shiftKey);
                          }}
                        />
                      </td>
                    )}
                    <td className="cap-col">
                      {missingIds?.has(t.id) ? (
                        <button
                          className="cap-missing"
                          title="Local file not found — click to relocate it"
                          onClick={(e) => {
                            e.stopPropagation();
                            onRelink?.(t);
                          }}
                        >
                          <AlertCircle size={15} />
                        </button>
                      ) : (
                        <span className={`cap-icon ${cap.className}`} title={cap.label}>
                          <cap.Icon size={15} />
                        </span>
                      )}
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
                    {(() => {
                      const fav = t.rating >= 1;
                      return (
                        <td className="fav-col">
                          <button
                            className={`fav-btn${fav ? " on" : ""}`}
                            title={fav ? "Remove from Favorites" : "Add to Favorites"}
                            aria-label={fav ? "Remove from Favorites" : "Add to Favorites"}
                            aria-pressed={fav}
                            onClick={(e) => {
                              e.stopPropagation();
                              onToggleFavorite?.(t);
                            }}
                          >
                            <Heart size={15} fill={fav ? "currentColor" : "none"} />
                          </button>
                        </td>
                      );
                    })()}
                    {columns.map((c) => {
                      const clickableArtist =
                        c.field === "artist" && onArtist && t.artist;
                      return (
                        <td key={c.field} className={c.num ? "num" : undefined}>
                          {clickableArtist ? (
                            <button
                              className="artist-link"
                              title={`Show all by ${t.artist}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                onArtist!(t.artist!);
                              }}
                            >
                              {t.artist}
                            </button>
                          ) : (
                            c.cell(t)
                          )}
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
        )}
      </div>
    </section>
  );
}
