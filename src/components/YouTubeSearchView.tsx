import { useRef, useState } from "react";
import {
  ArrowLeft,
  CalendarDays,
  Check,
  Link2,
  ListMusic,
  Search,
  SquarePlay,
} from "lucide-react";
import * as ipc from "../lib/ipc";
import type { YtSearchResult, YtSort } from "../lib/ipc";
import type { Track } from "../lib/types";
import { formatDuration } from "./LibraryTable";

interface Props {
  onClose: () => void;
  onError: (message: string) => void;
  onInfo: (message: string) => void;
  onPlay: (track: Track) => void;
}

const SORTS: { value: YtSort; label: string }[] = [
  { value: "relevance", label: "Relevance" },
  { value: "date", label: "Upload date" },
  { value: "views", label: "View count" },
  { value: "rating", label: "Rating" },
];

/// Full-page YouTube search (MusicPax-style): search by keyword, browse result
/// cards, and add any video to the library as a STREAM_PLAYABLE track — or play
/// it inline. Uses the keyless web search unless a Data API key is configured.
export default function YouTubeSearchView({ onClose, onError, onInfo, onPlay }: Props) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<YtSort>("relevance");
  const [results, setResults] = useState<YtSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [page, setPage] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // The global status banner sits behind this full-page overlay, so confirm
  // "Added" with a toast rendered inside the view.
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  // When the box holds a YouTube link, the action adds it directly instead of
  // searching — so this one page covers both "paste a URL" and "search".
  const isUrl = /youtu(\.be|be\.com|be-nocookie\.com)/i.test(query.trim());

  const showToast = (msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  };

  const run = async () => {
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    setSearched(true);
    setPage(0);
    try {
      setResults(await ipc.youtubeSearch(q, sort));
    } catch (e) {
      onError(`${e}`);
    } finally {
      setLoading(false);
    }
  };

  // Add a pasted YouTube URL straight to the library (same import path as a
  // search-result card), then clear the box.
  const addUrl = async () => {
    const u = query.trim();
    if (!u) return;
    setAdding(true);
    try {
      const track = await ipc.importStreamUrl(u);
      onInfo(`Added “${track.title ?? "video"}” to the library`);
      showToast(`Added “${track.title ?? "video"}”`);
      setQuery("");
    } catch (e) {
      onError(`${e}`);
    } finally {
      setAdding(false);
    }
  };

  const add = async (r: YtSearchResult, play: boolean) => {
    setBusyId(r.videoId);
    try {
      const track = await ipc.importStreamUrl(r.url);
      if (play) {
        onPlay(track);
        return;
      }
      onInfo(`Added “${track.title ?? r.title}” to the library`);
      setAdded((s) => new Set(s).add(r.videoId));
      showToast(`Added “${track.title ?? r.title}”`);
    } catch (e) {
      onError(`${e}`);
    } finally {
      setBusyId(null);
    }
  };

  // Show 8 at a time; "Show More" rotates through the fetched pool (wrapping
  // so each click yields a fresh set of 8).
  const PAGE_SIZE = 8;
  const visible =
    results.length <= PAGE_SIZE
      ? results
      : Array.from(
          { length: PAGE_SIZE },
          (_, i) => results[(page * PAGE_SIZE + i) % results.length],
        );

  return (
    <div className="yt-view">
      {toast && (
        <div className="yt-toast">
          <Check size={15} /> {toast}
        </div>
      )}
      <div className="yt-view-top">
        <h1 className="yt-view-title">YouTube Search</h1>
        <button className="yt-back" onClick={onClose}>
          <ArrowLeft size={16} /> Back
        </button>
      </div>

      <div className="yt-find-card">
        <div className="yt-find-head">
          <SquarePlay size={22} className="yt-find-icon" />
          <span>Find YouTube Videos</span>
        </div>
        <p className="yt-find-sub">
          Search for music and videos — or paste a YouTube link to add it directly.
        </p>
        <div className="yt-find-row">
          <div className="yt-find-input">
            {isUrl ? <Link2 size={16} /> : <Search size={16} />}
            <input
              type="search"
              placeholder="Search videos, or paste a YouTube link…"
              value={query}
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (isUrl ? addUrl() : run())}
            />
          </div>
          {!isUrl && (
            <select
              className="yt-sort"
              value={sort}
              onChange={(e) => setSort(e.target.value as YtSort)}
            >
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          )}
          {isUrl ? (
            <button className="yt-search-btn" onClick={addUrl} disabled={adding}>
              <ListMusic size={16} /> {adding ? "Adding…" : "Add to Library"}
            </button>
          ) : (
            <button className="yt-search-btn" onClick={run} disabled={!query.trim() || loading}>
              <Search size={16} /> {loading ? "Searching…" : "Search"}
            </button>
          )}
        </div>
      </div>

      {searched && (
        <div className="yt-results-head">
          <h2>Results</h2>
          {!loading && (
            <span className="yt-count">
              {results.length} video{results.length === 1 ? "" : "s"} found
            </span>
          )}
        </div>
      )}

      {loading && <p className="settings-hint yt-empty">Searching YouTube…</p>}
      {!loading && searched && results.length === 0 && (
        <p className="settings-hint yt-empty">No results — try different keywords.</p>
      )}

      <div className="yt-grid">
        {visible.map((r) => (
          <div className="yt-card" key={r.videoId}>
            <div
              className="yt-card-thumb"
              onDoubleClick={() => add(r, true)}
              title="Double-click to play"
            >
              <img
                src={`https://i.ytimg.com/vi/${r.videoId}/mqdefault.jpg`}
                alt=""
                loading="lazy"
                onError={(e) => (e.currentTarget.style.visibility = "hidden")}
              />
              <span className="yt-badge">
                <SquarePlay size={12} /> YouTube
              </span>
              {r.durationMs != null && (
                <span className="yt-duration">{formatDuration(r.durationMs)}</span>
              )}
            </div>
            <div className="yt-card-body">
              <div className="yt-card-title" title={r.title}>
                {r.title}
              </div>
              <div className="yt-card-channel">{r.channel}</div>
              {r.published && (
                <div className="yt-card-date">
                  <CalendarDays size={12} /> {r.published}
                </div>
              )}
            </div>
            <div className="yt-card-actions">
              <button
                className="yt-card-btn"
                onClick={() => add(r, true)}
                disabled={busyId === r.videoId}
                title="Play in the app"
              >
                <SquarePlay size={14} /> Watch
              </button>
              <button
                className={`yt-card-btn ${added.has(r.videoId) ? "added" : "primary"}`}
                onClick={() => add(r, false)}
                disabled={busyId === r.videoId}
                title={added.has(r.videoId) ? "Added to library" : "Add to library"}
              >
                {added.has(r.videoId) ? (
                  <>
                    <Check size={14} /> Added
                  </>
                ) : (
                  <>
                    <ListMusic size={14} /> Add to Library
                  </>
                )}
              </button>
            </div>
          </div>
        ))}
      </div>

      {!loading && results.length > PAGE_SIZE && (
        <div className="yt-more">
          <button className="yt-more-btn" onClick={() => setPage((p) => p + 1)}>
            Show More
          </button>
        </div>
      )}
    </div>
  );
}
