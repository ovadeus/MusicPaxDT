import { useEffect, useMemo, useRef, useState } from "react";
import { Command, ListMusic, Music, Search } from "lucide-react";
import type { PlaylistInfo, Track } from "../lib/types";

/// A palette command — a labelled action (navigate, open a modal, run a tool).
export interface PaletteAction {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

interface Item {
  key: string;
  kind: "action" | "playlist" | "track";
  label: string;
  sub?: string;
  run: () => void;
}

interface Props {
  onClose: () => void;
  actions: PaletteAction[];
  tracks: Track[];
  playlists: PlaylistInfo[];
  onPlayTrack: (t: Track) => void;
  onOpenPlaylist: (id: number, name: string) => void;
}

/// ⌘K command palette: fuzzy-jump to any track, playlist, or app action from
/// the keyboard. Actions + playlists show by default; tracks join once you type
/// (keeps the empty state fast on big libraries).
export default function CommandPalette({
  onClose,
  actions,
  tracks,
  playlists,
  onPlayTrack,
  onOpenPlaylist,
}: Props) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  const items = useMemo<Item[]>(() => {
    const query = q.trim().toLowerCase();
    const actionItems: Item[] = actions.map((a) => ({
      key: `a:${a.id}`,
      kind: "action",
      label: a.label,
      sub: a.hint,
      run: a.run,
    }));
    const playlistItems: Item[] = playlists.map((p) => ({
      key: `p:${p.id}`,
      kind: "playlist",
      label: p.name,
      sub: `${p.trackCount} track${p.trackCount === 1 ? "" : "s"}`,
      run: () => onOpenPlaylist(p.id, p.name),
    }));

    if (!query) {
      // Fast default: just actions + playlists (tracks join once searching).
      return [...actionItems, ...playlistItems].slice(0, 40);
    }

    const has = (s?: string) => (s ?? "").toLowerCase().includes(query);
    const rank = (label: string, sub?: string) => {
      const l = label.toLowerCase();
      if (l.startsWith(query)) return 0;
      if (l.includes(query)) return 1;
      return has(sub) ? 2 : 3;
    };
    const trackItems: Item[] = tracks.map((t) => ({
      key: `t:${t.id}`,
      kind: "track",
      label: t.title ?? "Untitled",
      sub: t.artist ?? undefined,
      run: () => onPlayTrack(t),
    }));
    return [...actionItems, ...playlistItems, ...trackItems]
      .filter((it) => has(it.label) || has(it.sub))
      .sort((a, b) => rank(a.label, a.sub) - rank(b.label, b.sub))
      .slice(0, 50);
  }, [q, actions, playlists, tracks, onPlayTrack, onOpenPlaylist]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${sel}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const activate = (i: number) => {
    const it = items[i];
    if (!it) return;
    onClose();
    it.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      activate(sel);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const icon = (kind: Item["kind"]) =>
    kind === "track" ? <Music size={15} /> : kind === "playlist" ? <ListMusic size={15} /> : <Command size={15} />;

  return (
    <div className="palette-overlay" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Search size={16} />
          <input
            autoFocus
            placeholder="Search tracks, playlists, actions…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <kbd className="palette-esc">esc</kbd>
        </div>
        <div className="palette-list" ref={listRef}>
          {items.length === 0 ? (
            <div className="palette-empty">No matches</div>
          ) : (
            items.map((it, i) => (
              <button
                key={it.key}
                data-idx={i}
                className={`palette-item${i === sel ? " active" : ""}`}
                onMouseMove={() => setSel(i)}
                onClick={() => activate(i)}
              >
                <span className={`palette-icon ${it.kind}`}>{icon(it.kind)}</span>
                <span className="palette-label">{it.label}</span>
                {it.sub && <span className="palette-sub">{it.sub}</span>}
                <span className="palette-kind">{it.kind}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
