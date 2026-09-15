import { Folder, RadioTower } from "lucide-react";
import type { Track } from "../lib/types";

interface Props {
  /// The Live Media folder (absolute path).
  dir: string;
  tracks: Track[];
  /// Selected folder as a path relative to `dir`; null shows everything.
  selected: string | null;
  onSelect: (folder: string | null) => void;
}

function trimSlash(p: string): string {
  return p.replace(/\/+$/, "");
}

/// Folder of a Live Media track relative to the Live folder ("" at the top).
export function liveFolderOf(dir: string, uri: string): string {
  const base = `${trimSlash(dir)}/`;
  const rel = uri.startsWith(base) ? uri.slice(base.length) : uri;
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}

/// True when the track sits in `folder` or anywhere beneath it.
export function inLiveFolder(dir: string, uri: string, folder: string): boolean {
  const f = liveFolderOf(dir, uri);
  return f === folder || f.startsWith(`${folder}/`);
}

/// Live mode's left nav: the Live Media folder's own directory tree, each
/// folder acting as a playlist. Built from the track paths, so it mirrors the
/// disk exactly and needs no extra bookkeeping — and it never shows anything
/// that isn't a local file, because nothing else is in the list.
export default function LiveMediaSidebar({ dir, tracks, selected, onSelect }: Props) {
  // Count each track into its folder and every ancestor, so a parent folder's
  // number covers everything beneath it and no level of the tree is missing.
  const counts = new Map<string, number>();
  for (const t of tracks) {
    let f = liveFolderOf(dir, t.uri);
    while (f) {
      counts.set(f, (counts.get(f) ?? 0) + 1);
      const i = f.lastIndexOf("/");
      f = i < 0 ? "" : f.slice(0, i);
    }
  }
  const folders = [...counts.keys()].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
  const rootName = trimSlash(dir).split("/").pop() || dir;

  return (
    <aside className="playlist-sidebar live-sidebar">
      <button
        className={`sidebar-item${selected == null ? " active" : ""}`}
        onClick={() => onSelect(null)}
        title={dir}
      >
        <RadioTower size={13} />
        <span className="sidebar-name">{rootName}</span>
        <span className="sidebar-count">{tracks.length}</span>
      </button>

      <div className="sidebar-heading">
        <span>Folders</span>
      </div>
      {folders.map((f) => {
        const depth = f.split("/").length - 1;
        const label = f.slice(f.lastIndexOf("/") + 1);
        return (
          <button
            key={f}
            className={`sidebar-item live-folder${selected === f ? " active" : ""}`}
            style={{ paddingLeft: 10 + depth * 14 }}
            onClick={() => onSelect(f)}
            title={f}
          >
            <Folder size={13} className="sidebar-folder-icon" />
            <span className="sidebar-name">{label}</span>
            <span className="sidebar-count">{counts.get(f)}</span>
          </button>
        );
      })}
      {folders.length === 0 && (
        <p className="live-sidebar-empty">
          No subfolders — organise the Live Media folder into folders and they
          appear here as playlists.
        </p>
      )}
    </aside>
  );
}
