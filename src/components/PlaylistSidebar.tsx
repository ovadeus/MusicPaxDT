import { useEffect, useRef, useState } from "react";
import { GripVertical, MoreVertical, Pencil, Plus, Share2, Trash2 } from "lucide-react";
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
  /// Rename a playlist from the row's kebab menu (inline input).
  onRename: (id: number, name: string) => void;
  /// Share a playlist from the row's kebab menu.
  onShare: (id: number, name: string) => void;
  /// Persist a new playlist order after a drag-and-drop reorder.
  onReorder: (ids: number[]) => void;
}

/// The "building" rail: every playlist can mix local OWNED files and
/// STREAM_PLAYABLE entries; mirrored playlists land here automatically.
/// Each row has a kebab menu (Rename/Share/Delete — destructive and rename
/// entries only in Curator mode); create control only appears in Curator mode.
export default function PlaylistSidebar({
  playlists,
  view,
  curator,
  width,
  onSelect,
  onPlayPlaylist,
  onCreate,
  onDelete,
  onRename,
  onShare,
  onReorder,
}: Props) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  // Kebab menu: which playlist's menu is open, anchored where (fixed coords so
  // the dropdown never clips inside the scrolling sidebar).
  const [menuFor, setMenuFor] = useState<{ id: number; x: number; y: number } | null>(null);
  // Inline rename state.
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const cancelRename = useRef(false);

  useEffect(() => {
    if (!menuFor) return;
    const close = () => setMenuFor(null);
    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
    };
  }, [menuFor]);

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

  const commitRename = (id: number) => {
    const trimmed = renameDraft.trim();
    setRenamingId(null);
    if (trimmed && trimmed !== playlists.find((p) => p.id === id)?.name) {
      onRename(id, trimmed);
    }
  };

  const menuPlaylist = menuFor ? playlists.find((p) => p.id === menuFor.id) : undefined;

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
        if (renamingId === p.id) {
          return (
            <input
              key={p.id}
              autoFocus
              className="sidebar-new-input"
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                else if (e.key === "Escape") {
                  cancelRename.current = true;
                  e.currentTarget.blur();
                }
              }}
              onBlur={() => {
                if (cancelRename.current) {
                  cancelRename.current = false;
                  setRenamingId(null);
                } else {
                  commitRename(p.id);
                }
              }}
            />
          );
        }
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
            <button
              className={`sidebar-kebab${menuFor?.id === p.id ? " open" : ""}`}
              title="Playlist options"
              onClick={(e) => {
                e.stopPropagation();
                if (menuFor?.id === p.id) {
                  setMenuFor(null);
                } else {
                  const r = e.currentTarget.getBoundingClientRect();
                  setMenuFor({ id: p.id, x: r.right, y: r.bottom + 4 });
                }
              }}
            >
              <MoreVertical size={13} />
            </button>
          </div>
        );
      })}

      {menuFor && menuPlaylist && (
        <div
          className="sidebar-menu"
          style={{ left: menuFor.x, top: menuFor.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {curator && (
            <button
              onClick={() => {
                setRenameDraft(menuPlaylist.name);
                setRenamingId(menuPlaylist.id);
                setMenuFor(null);
              }}
            >
              <Pencil size={13} /> Rename
            </button>
          )}
          <button
            onClick={() => {
              onShare(menuPlaylist.id, menuPlaylist.name);
              setMenuFor(null);
            }}
          >
            <Share2 size={13} /> Share
          </button>
          {curator && (
            <button
              className="danger"
              onClick={() => {
                onDelete(menuPlaylist.id);
                setMenuFor(null);
              }}
            >
              <Trash2 size={13} /> Delete
            </button>
          )}
        </div>
      )}
    </aside>
  );
}
