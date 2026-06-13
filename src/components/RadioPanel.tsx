import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ImagePlus, Link2, Pencil, Play, Plus, Radio as RadioIcon, Star, X } from "lucide-react";
import * as ipc from "../lib/ipc";
import type { RadioStation } from "../lib/types";

interface Props {
  curator: boolean;
  nowPlayingUrl: string | null;
  onPlay: (station: RadioStation) => void;
  onAdded: (name: string) => void;
  onInfo: (message: string) => void;
  onError: (message: string) => void;
}

const FAV_KEY = "radio.favorites";

/// Browse and search internet radio (Radio Browser). Star stations to keep
/// favorites (persisted in app settings), and toggle Favorites to show only
/// those. Click a station to play it inline; in Curator mode, add it to the
/// library as a STREAM_PLAYABLE track so it can join playlists.
export default function RadioPanel({
  curator,
  nowPlayingUrl,
  onPlay,
  onAdded,
  onInfo,
  onError,
}: Props) {
  const [query, setQuery] = useState("");
  const [stations, setStations] = useState<RadioStation[]>([]);
  const [favorites, setFavorites] = useState<RadioStation[]>([]);
  const [showFavorites, setShowFavorites] = useState(false);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [customUrl, setCustomUrl] = useState("");
  const [resolving, setResolving] = useState(false);
  const [editing, setEditing] = useState<RadioStation | null>(null);
  const [editName, setEditName] = useState("");
  const [editThumb, setEditThumb] = useState("");
  const debounce = useRef<number | undefined>(undefined);

  // Load persisted favorites once.
  useEffect(() => {
    ipc
      .getSettings()
      .then((s) => {
        try {
          const raw = s[FAV_KEY];
          if (raw) setFavorites(JSON.parse(raw) as RadioStation[]);
        } catch {
          /* ignore malformed */
        }
      })
      .catch(() => {});
  }, []);

  // Fetch top/search results — but not while browsing favorites (those are local).
  useEffect(() => {
    if (showFavorites) {
      setLoading(false);
      return;
    }
    setLoading(true);
    window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => {
      const q = query.trim();
      const req = q ? ipc.radioSearch(q, 80) : ipc.radioTop(80);
      req
        .then(setStations)
        .catch((e) => onError(`Radio unavailable: ${e}`))
        .finally(() => setLoading(false));
    }, 250);
    return () => window.clearTimeout(debounce.current);
  }, [query, showFavorites, onError]);

  const favUrls = useMemo(() => new Set(favorites.map((f) => f.url)), [favorites]);
  const isFav = (s: RadioStation) => favUrls.has(s.url);

  const persist = (next: RadioStation[]) => {
    setFavorites(next);
    ipc.setSetting(FAV_KEY, JSON.stringify(next)).catch((e) => onError(`${e}`));
  };

  const toggleFav = (s: RadioStation) => {
    if (isFav(s)) {
      persist(favorites.filter((f) => f.url !== s.url));
      onInfo(`Removed “${s.name}” from Favorites`);
    } else {
      persist([...favorites, s]);
      onInfo(`Added “${s.name}” to Favorites`);
    }
  };

  const openEditor = (s: RadioStation) => {
    setEditing(s);
    setEditName(s.name);
    setEditThumb(s.favicon ?? "");
  };

  const chooseImage = async () => {
    try {
      const file = await open({
        multiple: false,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
      });
      if (typeof file === "string") setEditThumb(await ipc.readImageDataUrl(file));
    } catch (e) {
      onError(`${e}`);
    }
  };

  const saveEdit = () => {
    if (!editing) return;
    const name = editName.trim() || editing.name;
    const favicon = editThumb.trim() || null;
    // Edit the favorite (identity = url); auto-favorite if it wasn't saved yet.
    const exists = favUrls.has(editing.url);
    const next = exists
      ? favorites.map((f) => (f.url === editing.url ? { ...f, name, favicon } : f))
      : [...favorites, { ...editing, name, favicon }];
    persist(next);
    setEditing(null);
    onInfo(`Saved “${name}”`);
  };

  const add = async (s: RadioStation) => {
    try {
      await ipc.importRadioStation(s);
      onAdded(s.name);
    } catch (e) {
      onError(`${e}`);
    }
  };

  // Resolve a pasted link → a station, save it to favorites, and play it.
  const addCustom = async () => {
    const url = customUrl.trim();
    if (!url) return;
    setResolving(true);
    try {
      const station = await ipc.resolveRadioStream(url);
      if (!favUrls.has(station.url)) persist([station, ...favorites]);
      setCustomUrl("");
      setAdding(false);
      setShowFavorites(true);
      onPlay(station);
      onAdded(station.name);
    } catch (e) {
      onError(`${e}`);
    } finally {
      setResolving(false);
    }
  };

  // What to show. Favorites-only view = just favorites (filtered by query).
  // "Show all" = favorites pinned on top (so custom streams, which live only
  // in favorites and aren't in the public directory, always appear), then the
  // directory results with any duplicates removed.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matchFav = (s: RadioStation) =>
      !q ||
      s.name.toLowerCase().includes(q) ||
      (s.tags ?? "").toLowerCase().includes(q) ||
      (s.country ?? "").toLowerCase().includes(q);
    const favMatch = favorites.filter(matchFav);
    if (showFavorites) return favMatch;
    const favSet = new Set(favMatch.map((f) => f.url));
    return [...favMatch, ...stations.filter((s) => !favSet.has(s.url))];
  }, [showFavorites, stations, favorites, query]);

  return (
    <section className="radio-panel">
      <div className="radio-toolbar">
        <RadioIcon size={18} className="radio-title-icon" />
        <h2 className="radio-title">Internet Radio</h2>
        <input
          type="search"
          className="search-box"
          placeholder={
            showFavorites ? "Filter favorites…" : "Search stations — name, genre, city…"
          }
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {curator && (
          <button
            className="fav-toggle"
            onClick={() => setAdding((v) => !v)}
            title="Add a station by stream or page URL"
          >
            <Link2 size={14} />
            Add stream
          </button>
        )}
        <button
          className={`fav-toggle${showFavorites ? " active" : ""}`}
          onClick={() => setShowFavorites((v) => !v)}
          title={showFavorites ? "Show all stations" : "Show favorites only"}
        >
          <Star size={14} fill={showFavorites ? "currentColor" : "none"} />
          {showFavorites ? "Show all" : `Favorites (${favorites.length})`}
        </button>
        <span className="track-count">
          {loading ? "loading…" : `${visible.length} stations`}
        </span>
      </div>

      {adding && (
        <div className="radio-add-stream">
          <input
            type="url"
            className="search-box"
            placeholder="Paste a stream or player URL (e.g. https://…/stream.mp3 or a station page)"
            value={customUrl}
            autoFocus
            onChange={(e) => setCustomUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addCustom()}
          />
          <button className="import-button" onClick={addCustom} disabled={resolving || !customUrl.trim()}>
            {resolving ? "Resolving…" : "Add & Play"}
          </button>
        </div>
      )}

      <div className="radio-grid">
        {!loading && visible.length === 0 && (
          <p className="settings-hint">
            {showFavorites
              ? "No favorites yet — tap the ☆ on a station to save it here."
              : "No stations found. Try a broader search."}
          </p>
        )}
        {visible.map((s) => {
          const live = nowPlayingUrl === s.url;
          const fav = isFav(s);
          return (
            <div
              className={`radio-card${live ? " playing" : ""}`}
              key={s.uuid || s.url}
              onDoubleClick={() => onPlay(s)}
            >
              <div className="radio-favicon">
                {s.favicon ? (
                  <img
                    src={s.favicon}
                    alt=""
                    onError={(e) => (e.currentTarget.style.display = "none")}
                  />
                ) : (
                  <RadioIcon size={18} />
                )}
              </div>
              <div className="radio-meta">
                <div className="radio-name" title={s.name}>
                  {s.name}
                </div>
                <div className="radio-sub">
                  {[s.country, s.codec, s.bitrate ? `${s.bitrate}kbps` : null, s.tags]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              </div>
              {curator && (
                <button
                  className="radio-fav"
                  title="Rename / set thumbnail"
                  onClick={() => openEditor(s)}
                >
                  <Pencil size={13} />
                </button>
              )}
              <button
                className={`radio-fav${fav ? " on" : ""}`}
                title={fav ? "Remove from favorites" : "Add to favorites"}
                onClick={() => toggleFav(s)}
              >
                <Star size={14} fill={fav ? "currentColor" : "none"} />
              </button>
              <button className="radio-play" title="Play station" onClick={() => onPlay(s)}>
                <Play size={14} fill="currentColor" />
              </button>
              {curator && (
                <button className="radio-add" title="Add to library" onClick={() => add(s)}>
                  <Plus size={14} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {editing && (
        <div className="settings-overlay" onClick={() => setEditing(null)}>
          <div className="settings-panel edit-panel" onClick={(e) => e.stopPropagation()}>
            <div className="settings-header">
              <h2>Edit station</h2>
              <button className="settings-close" onClick={() => setEditing(null)} title="Close">
                <X size={15} />
              </button>
            </div>

            <label className="edit-field">
              <span>Name</span>
              <input
                autoFocus
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && saveEdit()}
              />
            </label>

            <label className="edit-field">
              <span>Thumbnail image URL</span>
              <input
                value={editThumb}
                placeholder="https://…/logo.png  (or choose a file →)"
                onChange={(e) => setEditThumb(e.target.value)}
              />
            </label>

            <div className="edit-thumb-row">
              <div className="edit-thumb-preview">
                {editThumb ? (
                  <img src={editThumb} alt="" onError={(e) => (e.currentTarget.style.opacity = "0.2")} />
                ) : (
                  <RadioIcon size={22} />
                )}
              </div>
              <button className="addurl-button" onClick={chooseImage}>
                <ImagePlus size={14} /> Choose image…
              </button>
              {editThumb && (
                <button className="addurl-button" onClick={() => setEditThumb("")}>
                  Clear
                </button>
              )}
            </div>

            <div className="edit-actions">
              <button className="import-button" onClick={saveEdit}>
                Save
              </button>
            </div>
            <p className="settings-hint">
              Saving keeps this station in Favorites with your name and thumbnail.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
