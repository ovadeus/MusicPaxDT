import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Music, Plus, RefreshCw } from "lucide-react";
import * as ipc from "../lib/ipc";
import { mediaTypeMeta } from "../lib/mediaTypes";
import { formatDuration } from "./LibraryTable";
import type { MediaType, Track } from "../lib/types";

interface Props {
  /// Play a (synthesised) stream track — reuses the app's stream players.
  onPlay: (track: Track) => void;
  /// Publishes the loaded feed as a play queue so next/prev advance through it.
  onQueue: (tracks: Track[]) => void;
  /// Save a feed item into the library; the arg is the saved title.
  onSaved: (title: string) => void;
  /// The currently-playing stream URI, for row highlighting.
  playingUri: string | null;
  onError: (message: string) => void;
}

const CATEGORIES = [
  "All",
  "Music",
  "Podcast",
  "Audiobook",
  "Radio",
  "Movie",
  "Tutorial",
  "Other",
] as const;

const PAGE_SIZE = 50;

/// Relative thumbnails are served from the site root.
function absThumb(url: string | null): string | null {
  if (!url) return null;
  return url.startsWith("/") ? `https://musicpax.com${url}` : url;
}

function catToMediaType(cat: string | null): MediaType {
  switch ((cat ?? "").toLowerCase()) {
    case "podcast":
      return "podcast";
    case "audiobook":
      return "audiobook";
    case "radio":
      return "radio";
    case "movie":
      return "movie";
    case "tutorial":
      return "tutorial";
    default:
      return "music"; // Music / Other / unknown
  }
}

/// The URL we'd actually play: the YouTube watch page (embedded in-app) or a
/// direct stream URL; falls back to the source URL.
function playableUri(it: ipc.FeedItem): string {
  const yt = (it.sourceType ?? "").toLowerCase() === "youtube";
  return (yt ? it.sourceUrl : it.streamUrl || it.sourceUrl) ?? "";
}

/// Turn a feed row into a transient STREAM_PLAYABLE Track so the existing
/// YouTube / direct-stream players handle playback. The id is negative so it
/// never collides with a real library row.
function feedToTrack(it: ipc.FeedItem): Track {
  const yt = (it.sourceType ?? "").toLowerCase() === "youtube";
  return {
    id: -it.id - 1,
    title: it.title,
    artist: it.artist,
    album: it.album,
    year: it.year ? Number(it.year) || null : null,
    genre: null,
    bpm: null,
    musicalKey: null,
    durationMs: it.duration != null ? it.duration * 1000 : null,
    uri: playableUri(it),
    sourceKind: yt ? "youtube" : "stream",
    capability: "STREAM_PLAYABLE",
    mediaType: catToMediaType(it.category),
    fingerprint: null,
    musicbrainzId: null,
    artPath: absThumb(it.thumbnail) ?? it.coverImage ?? null,
    rating: 0,
    playCount: it.playCount ?? 0,
    addedAt: 0,
  };
}

function FeedThumb({ src }: { src: string | null }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div className="feed-thumb feed-thumb-placeholder">
        <Music size={16} />
      </div>
    );
  }
  return (
    <img
      className="feed-thumb"
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

/// The live MusicPax.com feed as an in-app list. Metadata + links only — never
/// downloads media. Infinite scroll loads one page at a time; thumbnails are
/// lazy. Clicking a row plays it through the app's stream players.
export default function MusicPaxFeed({ onPlay, onQueue, onSaved, playingUri, onError }: Props) {
  const [items, setItems] = useState<ipc.FeedItem[]>([]);
  const [page, setPage] = useState(0);
  const [hasNext, setHasNext] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [category, setCategory] = useState<string>("All");
  const [saved, setSaved] = useState<Set<number>>(new Set());
  const [savingId, setSavingId] = useState<number | null>(null);

  const saveItem = async (it: ipc.FeedItem) => {
    const yt = (it.sourceType ?? "").toLowerCase() === "youtube";
    setSavingId(it.id);
    try {
      const track = yt
        ? await ipc.importStreamUrl(it.sourceUrl ?? "")
        : await ipc.importDirectStream(it.streamUrl || it.sourceUrl || "");
      setSaved((s) => new Set(s).add(it.id));
      onSaved(track.title ?? it.title ?? "track");
    } catch (e) {
      onError(`${e}`);
    } finally {
      setSavingId(null);
    }
  };

  const inFlight = useRef(false);
  const sentinelRef = useRef<HTMLTableRowElement | null>(null);

  const loadPage = useCallback(
    async (next: number, cat: string, append: boolean) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setLoading(true);
      setError(null);
      try {
        const res = await ipc.musicPaxFeed(next, PAGE_SIZE, cat === "All" ? null : cat);
        setItems((prev) => (append ? [...prev, ...res.data] : res.data));
        setPage(res.pagination.currentPage);
        setHasNext(res.pagination.hasNextPage);
        setTotal(res.pagination.totalItems);
      } catch (e) {
        setError(`${e}`);
        if (!append) onError(`${e}`);
      } finally {
        setLoading(false);
        inFlight.current = false;
      }
    },
    [onError],
  );

  // (Re)start on mount and whenever the category changes.
  useEffect(() => {
    setItems([]);
    setPage(0);
    setHasNext(true);
    setTotal(null);
    loadPage(1, category, false);
  }, [category, loadPage]);

  // Infinite scroll: load the next page when the sentinel scrolls into view.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasNext || error) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasNext && !inFlight.current && !error) {
          loadPage(page + 1, category, true);
        }
      },
      { rootMargin: "240px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [page, hasNext, error, category, loadPage]);

  // Keep the app's play queue in sync so a finished track advances to the next.
  useEffect(() => {
    onQueue(items.map(feedToTrack));
  }, [items, onQueue]);

  const COLS = 6;

  return (
    <section className="library">
      <div className="library-toolbar">
        <h2 className="library-heading">MusicPax Feed</h2>
        <select
          className="feed-category"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          title="Filter by category"
        >
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <span className="track-count">
          {total != null ? `${items.length} of ${total}` : `${items.length}`}
        </span>
      </div>

      <div className="library-scroll">
        <table className="library-table feed-table">
          <thead>
            <tr>
              <th className="feed-thumb-col" />
              <th>Title</th>
              <th>Artist</th>
              <th className="feed-add-col">Add</th>
              <th className="type-col">Type</th>
              <th className="num">Length</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => {
              const mt = mediaTypeMeta(catToMediaType(it.category));
              const playing = !!playingUri && playableUri(it) === playingUri;
              return (
                <tr
                  key={it.id}
                  className={`feed-row${playing ? " playing" : ""}`}
                  onClick={() => onPlay(feedToTrack(it))}
                  title="Click to play"
                >
                  <td className="feed-thumb-col">
                    <FeedThumb src={absThumb(it.thumbnail) ?? it.coverImage} />
                  </td>
                  <td className="feed-title">{it.title ?? "—"}</td>
                  <td>{it.artist ?? "—"}</td>
                  <td className="feed-add-col">
                    <button
                      className={`feed-save${saved.has(it.id) ? " saved" : ""}`}
                      disabled={savingId === it.id || saved.has(it.id)}
                      title="Save to My Library"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!saved.has(it.id)) saveItem(it);
                      }}
                    >
                      {saved.has(it.id) ? (
                        <>
                          <Check size={13} /> Saved
                        </>
                      ) : (
                        <>
                          <Plus size={14} /> Save to My Library
                        </>
                      )}
                    </button>
                  </td>
                  <td className="type-col">
                    <span className="type-badge" title={it.category ?? mt.label}>
                      <mt.Icon size={14} style={{ color: mt.color }} />
                      <span className="type-label">{it.category ?? mt.label}</span>
                    </span>
                  </td>
                  <td className="num">{formatDuration((it.duration ?? 0) * 1000)}</td>
                </tr>
              );
            })}

            {error && (
              <tr>
                <td className="feed-status" colSpan={COLS}>
                  {error}{" "}
                  <button className="feed-retry" onClick={() => loadPage(page + 1, category, true)}>
                    <RefreshCw size={13} /> Retry
                  </button>
                </td>
              </tr>
            )}

            {!error && loading && (
              <tr>
                <td className="feed-status" colSpan={COLS}>
                  Loading…
                </td>
              </tr>
            )}

            {!error && !loading && items.length === 0 && (
              <tr>
                <td className="feed-status" colSpan={COLS}>
                  Nothing in this category.
                </td>
              </tr>
            )}

            {/* Infinite-scroll sentinel (only while more pages remain). */}
            {hasNext && !error && (
              <tr ref={sentinelRef} className="feed-sentinel">
                <td colSpan={COLS} />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
