import { useState } from "react";
import { Plus, X } from "lucide-react";
import type { PlaylistInfo } from "../lib/types";

export type LibraryView = { kind: "all" } | { kind: "playlist"; id: number; name: string };

interface Props {
  playlists: PlaylistInfo[];
  view: LibraryView;
  onSelect: (view: LibraryView) => void;
  onCreate: (name: string) => void;
  onDelete: (id: number) => void;
}

/// The "building" rail: every playlist can mix local OWNED files and
/// STREAM_PLAYABLE entries; mirrored playlists land here automatically.
export default function PlaylistSidebar({ playlists, view, onSelect, onCreate, onDelete }: Props) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  const submit = () => {
    const trimmed = name.trim();
    if (trimmed) onCreate(trimmed);
    setName("");
    setCreating(false);
  };

  return (
    <aside className="playlist-sidebar">
      <button
        className={`sidebar-item${view.kind === "all" ? " active" : ""}`}
        onClick={() => onSelect({ kind: "all" })}
      >
        All Tracks
      </button>

      <div className="sidebar-heading">
        <span>Playlists</span>
        <button
          className="sidebar-add"
          title="New playlist"
          onClick={() => setCreating(true)}
        >
          <Plus size={13} />
        </button>
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

      {playlists.map((p) => (
        <div
          key={p.id}
          className={`sidebar-item playlist${
            view.kind === "playlist" && view.id === p.id ? " active" : ""
          }`}
          onClick={() => onSelect({ kind: "playlist", id: p.id, name: p.name })}
        >
          <span className="sidebar-name" title={p.name}>
            {p.name}
          </span>
          <span className="sidebar-count">{p.trackCount}</span>
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
        </div>
      ))}
    </aside>
  );
}
