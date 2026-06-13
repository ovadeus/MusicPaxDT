import { useEffect, useMemo, useRef, useState } from "react";
import { Play, Plus, Radio as RadioIcon, Star } from "lucide-react";
import * as ipc from "../lib/ipc";
import type { RadioStation } from "../lib/types";

interface Props {
  curator: boolean;
  nowPlayingUrl: string | null;
  onPlay: (station: RadioStation) => void;
  onAdded: (name: string) => void;
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
  onError,
}: Props) {
  const [query, setQuery] = useState("");
  const [stations, setStations] = useState<RadioStation[]>([]);
  const [favorites, setFavorites] = useState<RadioStation[]>([]);
  const [showFavorites, setShowFavorites] = useState(false);
  const [loading, setLoading] = useState(true);
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
    if (isFav(s)) persist(favorites.filter((f) => f.url !== s.url));
    else persist([...favorites, s]);
  };

  const add = async (s: RadioStation) => {
    try {
      await ipc.importRadioStation(s);
      onAdded(s.name);
    } catch (e) {
      onError(`${e}`);
    }
  };

  // What to show: favorites (filtered locally by query) or fetched stations.
  const visible = useMemo(() => {
    if (!showFavorites) return stations;
    const q = query.trim().toLowerCase();
    if (!q) return favorites;
    return favorites.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.tags ?? "").toLowerCase().includes(q) ||
        (s.country ?? "").toLowerCase().includes(q),
    );
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
    </section>
  );
}
