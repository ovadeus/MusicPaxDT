import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderInput,
  FolderPlus,
  GripVertical,
  MoreVertical,
  Pencil,
  Plus,
  Share2,
  Trash2,
} from "lucide-react";
import type { FolderInfo, PlaylistInfo } from "../lib/types";

export type LibraryView =
  | { kind: "all" }
  | { kind: "favorites" }
  | { kind: "feed" }
  | { kind: "playlist"; id: number; name: string };

interface Props {
  playlists: PlaylistInfo[];
  folders: FolderInfo[];
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
  /// A playlist row was dropped: possibly a new folder (null = root) and the
  /// full playlist id order (display order across all groups).
  onRowDrop: (playlistId: number, folderId: number | null, orderedIds: number[]) => void;
  /// Kebab "Move to folder" (also used by drop-on-folder-header).
  onMoveToFolder: (playlistId: number, folderId: number | null) => void;
  // Folder management.
  onCreateFolder: (name: string) => void;
  onRenameFolder: (id: number, name: string) => void;
  /// Deleting a folder moves its playlists back to root.
  onDeleteFolder: (id: number) => void;
  onToggleFolder: (id: number, collapsed: boolean) => void;
  onReorderFolders: (ids: number[]) => void;
}

type Menu =
  | { type: "playlist"; id: number; x: number; y: number }
  | { type: "folder"; id: number; x: number; y: number };

type Drag =
  | { type: "playlist"; id: number }
  | { type: "folder"; id: number };

/// The "building" rail: playlists (optionally grouped into single-level
/// folders) mixing local OWNED files and STREAM_PLAYABLE entries. Rows and
/// folder headers drag to reorder; dropping a playlist on a folder header
/// files it there. Kebab menus carry Rename/Share/Move/Delete (destructive
/// and rename entries only in Curator mode).
export default function PlaylistSidebar({
  playlists,
  folders,
  view,
  curator,
  width,
  onSelect,
  onPlayPlaylist,
  onCreate,
  onDelete,
  onRename,
  onShare,
  onRowDrop,
  onMoveToFolder,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onToggleFolder,
  onReorderFolders,
}: Props) {
  const [creating, setCreating] = useState<"playlist" | "folder" | null>(null);
  const [name, setName] = useState("");

  // Kebab menu (playlist or folder), anchored at fixed coords so the dropdown
  // never clips inside the scrolling sidebar.
  const [menu, setMenu] = useState<Menu | null>(null);
  // Inline rename (playlist or folder shares one input state).
  const [renaming, setRenaming] = useState<{ type: "playlist" | "folder"; id: number } | null>(
    null,
  );
  const [renameDraft, setRenameDraft] = useState("");
  const cancelRename = useRef(false);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  // Drag state: what's being dragged, and what we're over.
  const [drag, setDrag] = useState<Drag | null>(null);
  const [overRow, setOverRow] = useState<{ id: number; below: boolean } | null>(null);
  const [overFolder, setOverFolder] = useState<number | null>(null);
  const clearDrag = () => {
    setDrag(null);
    setOverRow(null);
    setOverFolder(null);
  };

  const rootPlaylists = playlists.filter((p) => p.folderId == null);
  const inFolder = (fid: number) => playlists.filter((p) => p.folderId === fid);

  /// Display order of all playlists (folders first, then root), with `moved`
  /// re-homed to `targetFolder` and inserted relative to `anchor`.
  const buildOrder = (
    moved: number,
    targetFolder: number | null,
    anchor: { id: number; below: boolean } | null,
  ): number[] => {
    const groups: { fid: number | null; ids: number[] }[] = [
      ...folders.map((f) => ({ fid: f.id, ids: inFolder(f.id).map((p) => p.id) })),
      { fid: null, ids: rootPlaylists.map((p) => p.id) },
    ];
    for (const g of groups) {
      const i = g.ids.indexOf(moved);
      if (i >= 0) g.ids.splice(i, 1);
    }
    const target = groups.find((g) => g.fid === targetFolder);
    if (target) {
      if (anchor) {
        const at = target.ids.indexOf(anchor.id);
        if (at >= 0) target.ids.splice(anchor.below ? at + 1 : at, 0, moved);
        else target.ids.push(moved);
      } else {
        target.ids.push(moved);
      }
    }
    return groups.flatMap((g) => g.ids);
  };

  const dropOnRow = (targetId: number, targetFolder: number | null) => {
    if (drag?.type !== "playlist" || drag.id === targetId) return clearDrag();
    const anchor = overRow?.id === targetId ? overRow : { id: targetId, below: false };
    onRowDrop(drag.id, targetFolder, buildOrder(drag.id, targetFolder, anchor));
    clearDrag();
  };

  const dropOnFolderHeader = (fid: number) => {
    if (drag?.type === "playlist") {
      onMoveToFolder(drag.id, fid);
    } else if (drag?.type === "folder" && drag.id !== fid) {
      const ids = folders.map((f) => f.id);
      const from = ids.indexOf(drag.id);
      const to = ids.indexOf(fid);
      if (from >= 0 && to >= 0) {
        ids.splice(from, 1);
        ids.splice(to, 0, drag.id);
        onReorderFolders(ids);
      }
    }
    clearDrag();
  };

  const submitCreate = () => {
    const trimmed = name.trim();
    if (trimmed && creating === "playlist") onCreate(trimmed);
    if (trimmed && creating === "folder") onCreateFolder(trimmed);
    setName("");
    setCreating(null);
  };

  const commitRename = () => {
    if (!renaming) return;
    const trimmed = renameDraft.trim();
    const current =
      renaming.type === "playlist"
        ? playlists.find((p) => p.id === renaming.id)?.name
        : folders.find((f) => f.id === renaming.id)?.name;
    const target = renaming;
    setRenaming(null);
    if (!trimmed || trimmed === current) return;
    if (target.type === "playlist") onRename(target.id, trimmed);
    else onRenameFolder(target.id, trimmed);
  };

  const renameInput = (key: string) => (
    <input
      key={key}
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
          setRenaming(null);
        } else {
          commitRename();
        }
      }}
    />
  );

  const kebab = (m: Menu) => (
    <button
      className={`sidebar-kebab${
        menu?.type === m.type && menu.id === m.id ? " open" : ""
      }`}
      title={m.type === "folder" ? "Folder options" : "Playlist options"}
      onClick={(e) => {
        e.stopPropagation();
        if (menu?.type === m.type && menu.id === m.id) {
          setMenu(null);
        } else {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({ ...m, x: r.right, y: r.bottom + 4 });
        }
      }}
    >
      <MoreVertical size={13} />
    </button>
  );

  const playlistRow = (p: PlaylistInfo) => {
    if (renaming?.type === "playlist" && renaming.id === p.id) {
      return renameInput(`rn-p-${p.id}`);
    }
    const dropCls =
      overRow?.id === p.id && drag?.type === "playlist" && drag.id !== p.id
        ? overRow.below
          ? " drop-below"
          : " drop-above"
        : "";
    return (
      <div
        key={p.id}
        className={`sidebar-item playlist${
          view.kind === "playlist" && view.id === p.id ? " active" : ""
        }${drag?.type === "playlist" && drag.id === p.id ? " dragging" : ""}${dropCls}${
          p.folderId != null ? " in-folder" : ""
        }`}
        draggable
        onDragStart={(e) => {
          setDrag({ type: "playlist", id: p.id });
          e.dataTransfer.effectAllowed = "move";
          // WebKit requires data for a drag session to start reliably.
          e.dataTransfer.setData("text/plain", String(p.id));
        }}
        onDragOver={(e) => {
          if (drag?.type !== "playlist") return;
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          setOverFolder(null);
          setOverRow({ id: p.id, below: e.clientY > r.top + r.height / 2 });
        }}
        onDrop={(e) => {
          e.preventDefault();
          dropOnRow(p.id, p.folderId ?? null);
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
        {kebab({ type: "playlist", id: p.id, x: 0, y: 0 })}
      </div>
    );
  };

  const menuPlaylist =
    menu?.type === "playlist" ? playlists.find((p) => p.id === menu.id) : undefined;
  const menuFolder = menu?.type === "folder" ? folders.find((f) => f.id === menu.id) : undefined;

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
        className={`sidebar-item${view.kind === "favorites" ? " active" : ""}`}
        onClick={() => onSelect({ kind: "favorites" })}
        title="Tracks you've hearted"
      >
        My Favorites
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
          <span className="sidebar-heading-actions">
            <button
              className="sidebar-add"
              title="New folder"
              onClick={() => setCreating("folder")}
            >
              <FolderPlus size={13} />
            </button>
            <button
              className="sidebar-add"
              title="New playlist"
              onClick={() => setCreating("playlist")}
            >
              <Plus size={13} />
            </button>
          </span>
        )}
      </div>

      {creating && (
        <input
          autoFocus
          className="sidebar-new-input"
          placeholder={creating === "folder" ? "Folder name" : "Playlist name"}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitCreate();
            if (e.key === "Escape") setCreating(null);
          }}
          onBlur={submitCreate}
        />
      )}

      {folders.map((f) => {
        const children = inFolder(f.id);
        return (
          <div key={`f${f.id}`} className="sidebar-folder">
            {renaming?.type === "folder" && renaming.id === f.id ? (
              renameInput(`rn-f-${f.id}`)
            ) : (
              <div
                className={`sidebar-item folder-header${
                  drag?.type === "folder" && drag.id === f.id ? " dragging" : ""
                }${overFolder === f.id ? " drop-target" : ""}`}
                draggable
                onDragStart={(e) => {
                  setDrag({ type: "folder", id: f.id });
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", `folder:${f.id}`);
                }}
                onDragOver={(e) => {
                  if (!drag) return;
                  e.preventDefault();
                  setOverRow(null);
                  setOverFolder(f.id);
                }}
                onDragLeave={() => setOverFolder((cur) => (cur === f.id ? null : cur))}
                onDrop={(e) => {
                  e.preventDefault();
                  dropOnFolderHeader(f.id);
                }}
                onDragEnd={clearDrag}
                onClick={() => onToggleFolder(f.id, !f.collapsed)}
                title="Click to expand/collapse · drop a playlist here to file it"
              >
                {f.collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                <Folder size={13} className="sidebar-folder-icon" />
                <span className="sidebar-name" title={f.name}>
                  {f.name}
                </span>
                <span className="sidebar-count">{children.length}</span>
                {kebab({ type: "folder", id: f.id, x: 0, y: 0 })}
              </div>
            )}
            {!f.collapsed && children.map(playlistRow)}
          </div>
        );
      })}

      {rootPlaylists.map(playlistRow)}

      {menu && menuPlaylist && (
        <div
          className="sidebar-menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {curator && (
            <button
              onClick={() => {
                setRenameDraft(menuPlaylist.name);
                setRenaming({ type: "playlist", id: menuPlaylist.id });
                setMenu(null);
              }}
            >
              <Pencil size={13} /> Rename
            </button>
          )}
          <button
            onClick={() => {
              onShare(menuPlaylist.id, menuPlaylist.name);
              setMenu(null);
            }}
          >
            <Share2 size={13} /> Share
          </button>
          {curator && folders.length > 0 && (
            <>
              <div className="sidebar-menu-sep" />
              {folders
                .filter((f) => f.id !== menuPlaylist.folderId)
                .map((f) => (
                  <button
                    key={f.id}
                    onClick={() => {
                      onMoveToFolder(menuPlaylist.id, f.id);
                      setMenu(null);
                    }}
                  >
                    <FolderInput size={13} /> Move to “{f.name}”
                  </button>
                ))}
              {menuPlaylist.folderId != null && (
                <button
                  onClick={() => {
                    onMoveToFolder(menuPlaylist.id, null);
                    setMenu(null);
                  }}
                >
                  <FolderInput size={13} /> Remove from folder
                </button>
              )}
            </>
          )}
          {curator && (
            <>
              <div className="sidebar-menu-sep" />
              <button
                className="danger"
                onClick={() => {
                  onDelete(menuPlaylist.id);
                  setMenu(null);
                }}
              >
                <Trash2 size={13} /> Delete
              </button>
            </>
          )}
        </div>
      )}

      {menu && menuFolder && (
        <div
          className="sidebar-menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {curator ? (
            <>
              <button
                onClick={() => {
                  setRenameDraft(menuFolder.name);
                  setRenaming({ type: "folder", id: menuFolder.id });
                  setMenu(null);
                }}
              >
                <Pencil size={13} /> Rename
              </button>
              <button
                className="danger"
                onClick={() => {
                  onDeleteFolder(menuFolder.id);
                  setMenu(null);
                }}
              >
                <Trash2 size={13} /> Delete folder
              </button>
              <p className="sidebar-menu-note">Playlists inside move back to the list.</p>
            </>
          ) : (
            <p className="sidebar-menu-note">Folder options need Curator mode.</p>
          )}
        </div>
      )}
    </aside>
  );
}
