import { useState } from "react";
import { GripVertical, Plus, X } from "lucide-react";
import type { PlaylistInfo } from "../lib/types";

export type LibraryView =
  | { kind: "all" }
  | { kind: "feed" }
  | { kind: "playlist"; id: number; name: string };

interface Props {
  playlists: PlaylistInfo[];
  view: LibraryView;
  curator: boolean;
  /// User-resizable width (px); see SidebarResizer.
  width?: number;
  onSelect: (view: LibraryView) => void;
  onPlayPlaylist: (id: number, name: string) => void;
  onCreate: (name: string) => void;
  onDelete: (id: number) => void;
  /// Persist a new playlist order after a drag-and-drop reorder.
  onReorder: (ids: number[]) => void;
}

/// The "building" rail: every playlist can mix local OWNED files and
/// STREAM_PLAYABLE entries; mirrored playlists land here automatically.
/// Create/delete controls only appear in Curator mode.
export default function PlaylistSidebar({
  playlists,
  view,
  curator,
  width,
  onSelect,
  onPlayPlaylist,
  onCreate,
  onDelete,
  onReorder,
}: Props) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  // Drag-and-drop reorder state.
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [over, setOver] = useState<{ index: number; below: boolean } | null>(null);
  const clearDrag = () => {
    setDragIndex(null);
    setOver(null);
  };
  const doDrop = () => {
    if (dragIndex != null && over != null) {
      const to = over.below ? over.index + 1 : over.index;
      const ids = playlists.map((p) => p.id);
      const next = ids.slice();
      const [item] = next.splice(dragIndex, 1);
      next.splice(to > dragIndex ? to - 1 : to, 0, item);
      if (next.some((id, k) => id !== ids[k])) onReorder(next);
    }
    clearDrag();
  };

  const submit = () => {
    const trimmed = name.trim();
    if (trimmed) onCreate(trimmed);
    setName("");
    setCreating(false);
  };

  return (
    <aside
      className="playlist-sidebar"
      style={width != null ? { width, flexShrink: 0 } : undefined}
    >
      <button
        className={`sidebar-item${view.kind === "all" ? " active" : ""}`}
        onClick={() => onSelect({ kind: "all" })}
      >
        All Tracks
      </button>

      <button
        className={`sidebar-item${view.kind === "feed" ? " active" : ""}`}
        onClick={() => onSelect({ kind: "feed" })}
        title="The live MusicPax.com feed"
      >
        MusicPax Feed
      </button>

      <div className="sidebar-heading">
        <span>Playlists</span>
        {curator && (
          <button
            className="sidebar-add"
            title="New playlist"
            onClick={() => setCreating(true)}
          >
            <Plus size={13} />
          </button>
        )}
      </div>

      {creating && (
        <input
          autoFocus
          className="sidebar-new-input"
          placeholder="Playlist name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") setCreating(false);
          }}
          onBlur={submit}
        />
      )}

      {playlists.map((p, i) => {
        const dropCls =
          over?.index === i && dragIndex !== i
            ? over.below
              ? " drop-below"
              : " drop-above"
            : "";
        return (
          <div
            key={p.id}
            className={`sidebar-item playlist${
              view.kind === "playlist" && view.id === p.id ? " active" : ""
            }${dragIndex === i ? " dragging" : ""}${dropCls}`}
            draggable
            onDragStart={(e) => {
              setDragIndex(i);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              setOver({ index: i, below: e.clientY > r.top + r.height / 2 });
            }}
            onDrop={(e) => {
              e.preventDefault();
              doDrop();
            }}
            onDragEnd={clearDrag}
            onClick={() => onSelect({ kind: "playlist", id: p.id, name: p.name })}
            onDoubleClick={() => onPlayPlaylist(p.id, p.name)}
            title="Drag to reorder · double-click to play"
          >
            <GripVertical size={13} className="sidebar-grip" />
            <span className="sidebar-name" title={p.name}>
              {p.name}
            </span>
            <span className="sidebar-count">{p.trackCount}</span>
            {curator && (
              <button
                className="sidebar-delete"
                title="Delete playlist (tracks stay in the library)"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(p.id);
                }}
              >
                <X size={11} />
              </button>
            )}
          </div>
        );
      })}
    </aside>
  );
}
