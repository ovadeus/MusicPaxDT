import { useEffect, useRef, useState } from "react";
import { Play, Plus, Radio as RadioIcon } from "lucide-react";
import * as ipc from "../lib/ipc";
import type { RadioStation } from "../lib/types";

interface Props {
  curator: boolean;
  nowPlayingUrl: string | null;
  onPlay: (station: RadioStation) => void;
  onAdded: (name: string) => void;
  onError: (message: string) => void;
}

/// Browse and search internet radio (Radio Browser). Click a station to play
/// it inline; in Curator mode, add it to the library as a STREAM_PLAYABLE
/// track so it can join playlists.
export default function RadioPanel({
  curator,
  nowPlayingUrl,
  onPlay,
  onAdded,
  onError,
}: Props) {
  const [query, setQuery] = useState("");
  const [stations, setStations] = useState<RadioStation[]>([]);
  const [loading, setLoading] = useState(true);
  const debounce = useRef<number | undefined>(undefined);

  useEffect(() => {
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
  }, [query, onError]);

  const add = async (s: RadioStation) => {
    try {
      await ipc.importRadioStation(s);
      onAdded(s.name);
    } catch (e) {
      onError(`${e}`);
    }
  };

  return (
    <section className="radio-panel">
      <div className="radio-toolbar">
        <RadioIcon size={18} className="radio-title-icon" />
        <h2 className="radio-title">Internet Radio</h2>
        <input
          type="search"
          className="search-box"
          placeholder="Search stations — name, genre, city…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="track-count">
          {loading ? "loading…" : `${stations.length} stations`}
        </span>
      </div>

      <div className="radio-grid">
        {!loading && stations.length === 0 && (
          <p className="settings-hint">No stations found. Try a broader search.</p>
        )}
        {stations.map((s) => {
          const live = nowPlayingUrl === s.url;
          return (
            <div
              className={`radio-card${live ? " playing" : ""}`}
              key={s.uuid || s.url}
              onDoubleClick={() => onPlay(s)}
            >
              <div className="radio-favicon">
                {s.favicon ? (
                  <img src={s.favicon} alt="" onError={(e) => (e.currentTarget.style.display = "none")} />
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
