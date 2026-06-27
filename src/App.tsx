import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ChevronLeft,
  Film,
  Image as ImageIcon,
  Maximize2,
  Minimize2,
  PictureInPicture2,
  Settings as SettingsIcon,
} from "lucide-react";
import MpxLogo from "./components/MpxLogo";
import ManageMusicMenu from "./components/ManageMusicMenu";
import GoLivePanel from "./components/GoLivePanel";
import AddUrlModal from "./components/AddUrlModal";
import YouTubeSearchView from "./components/YouTubeSearchView";
import EnrichReviewModal from "./components/EnrichReviewModal";
import ModeMenu, { type UiMode } from "./components/ModeMenu";
import NowPlayingPanel from "./components/NowPlayingPanel";
import RadioPanel from "./components/RadioPanel";
import RadioPlayer from "./components/RadioPlayer";
import StreamPanel from "./components/StreamPanel";
import DirectStreamPlayer from "./components/DirectStreamPlayer";
import TrackEditModal from "./components/TrackEditModal";
import LibraryTable from "./components/LibraryTable";
import Logo from "./components/Logo";
import MiniPlayer from "./components/MiniPlayer";
import NowPlayingBar from "./components/NowPlayingBar";
import PlaylistSidebar, { type LibraryView } from "./components/PlaylistSidebar";
import ReceiverPanel from "./components/ReceiverPanel";
import SettingsPanel from "./components/SettingsPanel";
import SidebarResizer from "./components/SidebarResizer";
import SourceSelector, { type SelectableSource } from "./components/SourceSelector";
import StreamPlayer from "./components/StreamPlayer";
import * as ipc from "./lib/ipc";
import type {
  AudioDevice,
  EngineStatus,
  EnrichProposal,
  LineInSource,
  MediaType,
  NowPlaying,
  PlaybackState,
  PlaylistInfo,
  RadioStation,
  RecordingState,
  SortSpec,
  Track,
} from "./lib/types";
import "./styles/theme.css";

const VIDEO_URI_EXTS = ["mp4", "m4v", "webm", "mov", "mkv", "avi", "ogv"];

/// A direct-stream URL that points at a video file (vs. audio).
function isVideoUri(uri: string): boolean {
  const path = uri.split(/[?#]/)[0].toLowerCase();
  const ext = path.split(".").pop() ?? "";
  return VIDEO_URI_EXTS.includes(ext);
}

/// Sort tracks client-side for a chosen column. Used for playlist views, whose
/// rows arrive in curated position order (the server only sorts the library
/// query). `added_at` means "leave in position order". String compares are
/// numeric-aware so "Track 2" precedes "Track 10".
function sortTracks(list: Track[], sort: SortSpec): Track[] {
  if (sort.field === "added_at") return list;
  const dir = sort.dir === "asc" ? 1 : -1;
  const num = (t: Track): number | null =>
    sort.field === "year" ? t.year : sort.field === "duration_ms" ? t.durationMs : null;
  const str = (t: Track): string =>
    sort.field === "artist"
      ? (t.artist ?? "")
      : sort.field === "album"
        ? (t.album ?? "")
        : sort.field === "genre"
          ? (t.genre ?? "")
          : (t.title ?? "");
  return [...list].sort((a, b) => {
    const an = num(a);
    const bn = num(b);
    if (an != null || bn != null) return ((an ?? 0) - (bn ?? 0)) * dir;
    return str(a).localeCompare(str(b), undefined, { numeric: true, sensitivity: "base" }) * dir;
  });
}

export default function App() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [view, setView] = useState<LibraryView>({ kind: "all" });
  // When set, the library shows only this artist's tracks (across all sources).
  // Cleared by selecting anything in the sidebar (e.g. "All Tracks").
  const [artistFilter, setArtistFilter] = useState<string | null>(null);
  const [playlists, setPlaylists] = useState<PlaylistInfo[]>([]);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortSpec>({ field: "added_at", dir: "desc" });
  const [mediaTypeFilter, setMediaTypeFilter] = useState<MediaType | null>(null);
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [deviceId, setDeviceId] = useState("default");
  const [now, setNow] = useState<NowPlaying | null>(null);
  const [playState, setPlayState] = useState<PlaybackState>("stopped");
  const [positionMs, setPositionMs] = useState(0);
  const [volume, setVolume] = useState(1);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<SelectableSource>("library");
  const [engineStat, setEngineStat] = useState<EngineStatus | null>(null);
  const [recState, setRecState] = useState<RecordingState>({
    recording: false,
    recordedMs: 0,
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [addUrlMode, setAddUrlMode] = useState<"youtube" | "spotify" | null>(null);
  const [ytSearchOpen, setYtSearchOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem("library.sidebarWidth"));
    return saved >= 160 && saved <= 480 ? saved : 200;
  });
  const [goLiveOpen, setGoLiveOpen] = useState(false);
  // Theater (in-app fullscreen) for the now-playing media.
  const [mini, setMini] = useState(false);
  const [miniVideo, setMiniVideo] = useState(false);
  const miniCoverRef = useRef<HTMLDivElement | null>(null);
  const [miniRect, setMiniRect] = useState<
    { top: number; left: number; width: number; height: number } | null
  >(null);
  const toggleMini = useCallback((on: boolean) => {
    setMini(on);
    if (on) setTheater(false);
    else setMiniVideo(false);
    ipc.setMiniWindow(on).catch(() => {});
  }, []);
  const [theater, setTheater] = useState(false);
  const [theaterRect, setTheaterRect] = useState<
    { top: number; left: number; width: number; height: number } | null
  >(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [onAir, setOnAir] = useState(false);
  const [editTrack, setEditTrack] = useState<Track | null>(null);
  const [enrichingId, setEnrichingId] = useState<number | null>(null);
  const [enrichProgress, setEnrichProgress] = useState<{
    done: number;
    total: number;
    proposed: number;
    spentUsd: number;
    current: string;
    capped: boolean;
  } | null>(null);
  const [proposals, setProposals] = useState<EnrichProposal[] | null>(null);
  const [mode, setMode] = useState<UiMode>(
    () => (localStorage.getItem("ui.mode") as UiMode) || "listening",
  );
  const curator = mode === "curator";

  const changeMode = (m: UiMode) => {
    setMode(m);
    localStorage.setItem("ui.mode", m);
  };

  const [showNowPlaying, setShowNowPlaying] = useState(
    () => localStorage.getItem("ui.nowPlaying") !== "0",
  );
  const toggleNowPlaying = (show: boolean) => {
    setShowNowPlaying(show);
    localStorage.setItem("ui.nowPlaying", show ? "1" : "0");
  };
  const [formatLabel, setFormatLabel] = useState("");
  const [stream, setStream] = useState<Track | null>(null);
  const [streamPlaying, setStreamPlaying] = useState(true);
  const [streamPos, setStreamPos] = useState(0);
  const [streamDur, setStreamDur] = useState(0);
  const [streamSeek, setStreamSeek] = useState<number | null>(null);

  const showStatus = useCallback((msg: string) => {
    setStatus(msg);
    window.setTimeout(() => setStatus((cur) => (cur === msg ? null : cur)), 8000);
  }, []);

  const refreshPlaylists = useCallback(async () => {
    try {
      setPlaylists(await ipc.listPlaylists());
    } catch (e) {
      showStatus(`Failed to load playlists: ${e}`);
    }
  }, [showStatus]);

  const refreshTracks = useCallback(async () => {
    try {
      const mediaType = mediaTypeFilter;
      let ts: Track[];
      if (source === "stream") {
        // The Stream view is the library, filtered to direct-stream tracks.
        const all = await ipc.listTracks({ query, sort, mediaType });
        ts = all.filter((t) => t.sourceKind === "stream");
      } else if (view.kind === "playlist") {
        // Playlist rows come in curated position order; apply the active column
        // sort client-side (server sort only covers the library query). The type
        // filter is also applied client-side for playlists.
        ts = sortTracks(await ipc.playlistTracks(view.id), sort);
        if (mediaType) ts = ts.filter((t) => t.mediaType === mediaType);
      } else {
        ts = await ipc.listTracks({ query, sort, mediaType });
      }
      // Artist filter is applied last so it narrows whatever set is loaded —
      // for "all of an artist from all sources" this runs over the full library.
      if (artistFilter) {
        const a = artistFilter.trim().toLowerCase();
        ts = ts.filter((t) => (t.artist ?? "").trim().toLowerCase() === a);
      }
      setTracks(ts);
    } catch (e) {
      showStatus(`Failed to load library: ${e}`);
    }
  }, [view, query, sort, showStatus, source, mediaTypeFilter, artistFilter]);

  // Debounced refresh on view/search/sort change.
  const debounce = useRef<number | undefined>(undefined);
  useEffect(() => {
    window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(refreshTracks, 150);
    return () => window.clearTimeout(debounce.current);
  }, [refreshTracks]);

  // Click an artist name → show every track by that artist, from all sources.
  // Resets to the whole-library view (and the "library" source) so nothing is
  // scoped to a playlist or the stream/radio panels.
  const filterByArtist = useCallback((artist: string) => {
    setArtistFilter(artist);
    setView({ kind: "all" });
    setSource("library");
    setQuery("");
  }, []);

  // Devices, playlists, format label + engine event subscriptions.
  useEffect(() => {
    ipc
      .getAudioDevices()
      .then(setDevices)
      .catch((e) => showStatus(`Audio devices unavailable: ${e}`));
    refreshPlaylists();
    ipc
      .recordingFormatLabel()
      .then(setFormatLabel)
      .catch(() => setFormatLabel(""));

    const subs = [
      ipc.onPosition(setPositionMs),
      ipc.onPlaybackState(setPlayState),
      ipc.onRecordingState(setRecState),
      ipc.onEnrichProgress(setEnrichProgress),
      ipc.onBroadcastState((s) => setOnAir(s.state !== "idle")),
    ];
    ipc.goLiveStatus().then((s) => setOnAir(s.state !== "idle")).catch(() => {});
    return () => {
      subs.forEach((p) => p.then((un) => un()));
    };
  }, [showStatus, refreshPlaylists]);

  // Both per-row and batch enrich PROPOSE changes (no writes); the review
  // modal then lets the user approve per field before anything is applied.
  const runProposal = async (
    ids: number[],
    singleId?: number,
    mode: "enrich" | "clean" = "enrich",
  ) => {
    if (ids.length === 0) return;
    try {
      if (singleId == null) {
        const est = await ipc.enrichCostEstimate(ids.length);
        if (est > 0) {
          const ok = window.confirm(
            `Look up ${ids.length} track(s)?\n\nEstimated AI cost if every track needs the LLM: $${est.toFixed(2)} (capped in Settings). Free MusicBrainz/fingerprint matches cost nothing, and you review everything before it's saved.`,
          );
          if (!ok) return;
        }
      }
      if (singleId != null) setEnrichingId(singleId);
      setEnrichProgress({
        done: 0,
        total: ids.length,
        proposed: 0,
        spentUsd: 0,
        current: "",
        capped: false,
      });
      const report =
        mode === "clean"
          ? await ipc.cleanTrackMetadata(ids)
          : await ipc.proposeEnrichment(ids);
      if (report.proposals.length === 0) {
        showStatus(
          mode === "clean"
            ? "Nothing to clean — titles already look tidy."
            : report.total === 1
              ? "No confident match found."
              : `No matches found for ${report.total} track(s).`,
        );
      } else {
        setProposals(report.proposals);
      }
    } catch (e) {
      showStatus(`${e}`);
    } finally {
      setEnrichProgress(null);
      setEnrichingId(null);
    }
  };

  const handleEnrichTrack = (track: Track) => runProposal([track.id], track.id);
  const handleEnrichAll = () => runProposal(tracks.map((t) => t.id));
  const handleCleanAll = () =>
    runProposal(tracks.map((t) => t.id), undefined, "clean");

  // ----- playback routing (the capability gate, UI side) -------------------

  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const nowRef = useRef<{ id: number | null; positionMs: number; durationMs: number }>({
    id: null,
    positionMs: 0,
    durationMs: 0,
  });
  nowRef.current = {
    id: stream ? stream.id : (now?.track.id ?? null),
    positionMs,
    durationMs: now?.track.durationMs ?? 0,
  };

  const playTrack = useCallback(
    async (track: Track) => {
      try {
        if (track.capability === "OWNED") {
          setStream(null);
          await ipc.loadTrack(track.id);
          await ipc.play();
          setNow(await ipc.nowPlaying());
          setEngineStat(null);
          setSource("library");
          setPositionMs(0);
        } else if (
          track.capability === "STREAM_PLAYABLE" &&
          (track.sourceKind === "youtube" ||
            track.sourceKind === "radio" ||
            track.sourceKind === "stream")
        ) {
          await ipc.stop().catch(() => {});
          setNow(null);
          setStream(track);
          setStreamPlaying(true);
          setStreamPos(0);
          setStreamDur(0);
          setStreamSeek(null);
          setEngineStat(null);
          // radio/stream keep their browse panel open; others go to Library
          if (track.sourceKind !== "radio" && track.sourceKind !== "stream") {
            setSource("library");
          }
        } else {
          showStatus("This entry can only be opened externally.");
        }
      } catch (e) {
        showStatus(`${e}`);
      }
    },
    [showStatus],
  );

  /// Advance to the next track in the current view — across capabilities,
  /// so mixed playlists flow from local files into streams and back.
  const playNext = useCallback(
    (afterTrackId: number | null) => {
      const list = tracksRef.current;
      if (!list.length || afterTrackId == null) return;
      const idx = list.findIndex((t) => t.id === afterTrackId);
      if (idx >= 0 && idx + 1 < list.length) {
        void playTrack(list[idx + 1]);
      } else {
        setStream(null);
      }
    },
    [playTrack],
  );

  // Manual "previous track" — step back one in the current list.
  const playPrev = useCallback(
    (beforeTrackId: number | null) => {
      const list = tracksRef.current;
      if (!list.length || beforeTrackId == null) return;
      const idx = list.findIndex((t) => t.id === beforeTrackId);
      if (idx > 0) void playTrack(list[idx - 1]);
    },
    [playTrack],
  );

  // Single entry point for "this track ended → advance", debounced because a
  // lane can emit the end more than once (YouTube reports playerState 0
  // repeatedly near the end, and may also fire onStateChange). Collapsing them
  // keeps us from skipping a track.
  const lastEndAdvance = useRef(0);
  const advanceFromEnd = useCallback(
    (endedId: number | null) => {
      if (endedId == null) return;
      const now = performance.now();
      if (now - lastEndAdvance.current < 2000) return;
      lastEndAdvance.current = now;
      playNext(endedId);
    },
    [playNext],
  );

  // Double-click a playlist → play it from the first track.
  const playPlaylist = useCallback(
    async (id: number, name: string) => {
      try {
        const ts = await ipc.playlistTracks(id);
        setView({ kind: "playlist", id, name });
        if (ts.length === 0) {
          showStatus(`“${name}” is empty`);
          return;
        }
        await playTrack(ts[0]);
      } catch (e) {
        showStatus(`${e}`);
      }
    },
    [playTrack, showStatus],
  );

  // Natural end of an OWNED track → advance. Driven by an explicit engine
  // event (not a position heuristic), so it fires reliably regardless of
  // duration metadata or the position reset that teardown performs.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    ipc.onTrackEnded(() => advanceFromEnd(nowRef.current.id)).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [advanceFromEnd]);

  // ----- handlers -----------------------------------------------------------

  const handleSelectSource = async (next: SelectableSource) => {
    try {
      if (next === "library") {
        await ipc.stop();
        setEngineStat(null);
        setSource("library");
        return;
      }
      if (next === "radio" || next === "stream") {
        // Browse panel; the engine stays idle until something is played.
        await ipc.stop().catch(() => {});
        setEngineStat(null);
        setNow(null);
        setSource(next);
        return;
      }
      setStream(null);
      const stat = await ipc.startLineIn(next as LineInSource);
      setNow(null);
      setEngineStat(stat);
      setSource(next);
    } catch (e) {
      showStatus(`${e}`);
    }
  };

  const playStation = (s: RadioStation) => {
    void playTrack({
      id: -1,
      title: s.name,
      artist: "Radio",
      album: null,
      year: null,
      genre: s.tags,
      bpm: null,
      musicalKey: null,
      durationMs: null,
      uri: s.url,
      sourceKind: "radio",
      capability: "STREAM_PLAYABLE",
      mediaType: "radio",
      fingerprint: null,
      musicbrainzId: null,
      artPath: null,
      rating: 0,
      playCount: 0,
      addedAt: 0,
    });
  };

  const handleImport = async () => {
    const folder = await open({
      directory: true,
      multiple: false,
      title: "Import music folder",
    });
    if (typeof folder !== "string") return;
    setBusy(true);
    try {
      const result = await ipc.importFolder(folder);
      const errs = result.errors.length ? `, ${result.errors.length} errors` : "";
      showStatus(`Imported ${result.imported}, skipped ${result.skipped}${errs}`);
      await refreshTracks();
    } catch (e) {
      showStatus(`Import failed: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const handleImportMpx = async () => {
    const file = await open({
      multiple: false,
      title: "Import MusicPax playlist",
      filters: [{ name: "MusicPax playlist", extensions: ["mpx", "json"] }],
    });
    if (typeof file !== "string") return;
    setBusy(true);
    try {
      const r = await ipc.importMpxPlaylist(file);
      const extra = [
        r.skipped ? `${r.skipped} skipped` : null,
        r.duplicates ? `${r.duplicates} duplicates` : null,
      ]
        .filter(Boolean)
        .join(", ");
      showStatus(
        `Imported “${r.playlistName}” — ${r.imported} track(s)${extra ? ` (${extra})` : ""}`,
      );
      await refreshPlaylists();
      setView({ kind: "playlist", id: r.playlistId, name: r.playlistName });
    } catch (e) {
      showStatus(`MPX import failed: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const handleDeviceChange = async (id: string) => {
    const previous = deviceId;
    setDeviceId(id);
    try {
      await ipc.setOutputDevice(id);
    } catch (e) {
      setDeviceId(previous);
      showStatus(`Device switch failed: ${e}`);
    }
  };

  const handleVolume = (level: number) => {
    setVolume(level);
    ipc.setVolume(level).catch((e) => showStatus(`${e}`));
  };

  const lineIn =
    source !== "library" && source !== "radio" && source !== "stream"
      ? (source as LineInSource)
      : null;

  // The track the Now Playing panel describes: a live stream, else the
  // engine's loaded track.
  const detailTrack = stream ?? now?.track ?? null;

  // Theater: when a live video is playing, the floating player fills the stage;
  // otherwise the stage shows the cover.
  const theaterVideo =
    stream != null &&
    (stream.sourceKind === "youtube" ||
      (stream.sourceKind === "stream" && isVideoUri(stream.uri)));
  const theaterCover = (() => {
    const t = detailTrack;
    if (!t) return null;
    if (t.artPath && /^(https?:|data:)/.test(t.artPath)) return t.artPath;
    const m = t.uri.match(/[?&]v=([A-Za-z0-9_-]{11})/);
    return m ? `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg` : null;
  })();

  // Keep the floating video players matched to the theater stage's box (no
  // remount → uninterrupted playback). Re-measure on resize/layout changes.
  useEffect(() => {
    if (!theater) {
      setTheaterRect(null);
      return;
    }
    const measure = () => {
      const el = stageRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setTheaterRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (stageRef.current) ro.observe(stageRef.current);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [theater, showNowPlaying]);

  // Esc exits theater.
  useEffect(() => {
    if (!theater) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setTheater(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [theater]);

  // Mini player: measure the cover slot so the live video (when toggled on) can
  // fill it on top of the mini overlay.
  useEffect(() => {
    if (!mini || !theaterVideo) {
      setMiniRect(null);
      return;
    }
    const measure = () => {
      const el = miniCoverRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setMiniRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (miniCoverRef.current) ro.observe(miniCoverRef.current);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [mini, theaterVideo]);

  // The rect the floating video players fill: the theater stage, or the mini
  // cover slot (lifted above the mini overlay), or nowhere.
  const videoRect =
    theater && theaterVideo
      ? theaterRect
      : mini && miniVideo && theaterVideo && miniRect
        ? { ...miniRect, z: 250 }
        : null;

  const handleStop = async () => {
    setStream(null);
    try {
      await ipc.stop();
      if (lineIn) {
        setEngineStat(null);
        setSource("library");
      }
    } catch (e) {
      showStatus(`${e}`);
    }
  };

  return (
    <div className="app">
      <header className="app-header">
        <Logo />
        <SourceSelector active={source} onSelect={handleSelectSource} />
        <div className="header-controls">
          {curator && (
            <>
              <select
                className="device-picker"
                value={deviceId}
                onChange={(e) => handleDeviceChange(e.target.value)}
                title="Output device"
              >
                <option value="default">System default output</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                    {d.isDefault ? " (default)" : ""}
                  </option>
                ))}
              </select>
              <ManageMusicMenu
                busy={busy}
                canEnrich={source === "library" && tracks.length > 0 && enrichProgress == null}
                onAir={onAir}
                onImportFolder={handleImport}
                onImportMpx={handleImportMpx}
                onAddYouTube={() => setAddUrlMode("youtube")}
                onAddSpotify={() => setAddUrlMode("spotify")}
                onSearchYouTube={() => setYtSearchOpen(true)}
                onClean={handleCleanAll}
                onEnrich={handleEnrichAll}
                onGoLive={() => setGoLiveOpen(true)}
              />
            </>
          )}
          <button
            className="settings-button"
            onClick={() => toggleMini(true)}
            title="Mini player"
          >
            <PictureInPicture2 size={16} />
          </button>
          <button
            className="settings-button"
            onClick={() => setTheater(!theater)}
            disabled={!theater && !detailTrack}
            title={theater ? "Exit full screen" : "Full screen (theater)"}
          >
            {theater ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
          <button
            className="settings-button"
            onClick={() => setSettingsOpen(true)}
            title="Settings"
          >
            <SettingsIcon size={16} />
          </button>
          <ModeMenu
            mode={mode}
            onMode={changeMode}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        </div>
      </header>

      {status && <div className="status-banner">{status}</div>}

      {enrichProgress && (
        <div className="enrich-banner">
          <div className="mirror-progress-bar">
            <div
              className="mirror-progress-fill"
              style={{
                width: `${enrichProgress.total ? (enrichProgress.done / enrichProgress.total) * 100 : 0}%`,
              }}
            />
          </div>
          <div className="mirror-progress-text">
            Looking up {enrichProgress.done}/{enrichProgress.total} ·{" "}
            {enrichProgress.proposed} found · AI ${enrichProgress.spentUsd.toFixed(2)}
            {enrichProgress.capped ? " · cap reached (free tiers only)" : ""}
            {enrichProgress.current ? ` · ${enrichProgress.current}` : ""}
          </div>
        </div>
      )}

      <div className="app-content">
      <div className="app-main">
      {source === "radio" ? (
        <RadioPanel
          curator={curator}
          nowPlayingUrl={stream?.sourceKind === "radio" ? stream.uri : null}
          onPlay={playStation}
          onAdded={(name) => {
            showStatus(`Added “${name}” to the library`);
            refreshTracks();
          }}
          onInfo={showStatus}
          onError={showStatus}
        />
      ) : source === "stream" ? (
        <div className="library-layout stream-layout">
          <div className="stream-col">
            <StreamPanel
              curator={curator}
              onAdded={(t) => {
                showStatus(`Added “${t.title ?? "stream"}” to the library`);
                refreshTracks();
              }}
              onError={showStatus}
            />
            <LibraryTable
              tracks={tracks}
              onArtist={filterByArtist}
              searchable
              query={query}
              onQueryChange={setQuery}
              sort={sort}
              onSortChange={setSort}
              onActivate={playTrack}
              onEdit={setEditTrack}
              onEnrich={handleEnrichTrack}
              curator={curator}
              enrichingId={enrichingId}
              nowPlayingId={
                stream ? stream.id : playState === "stopped" ? null : (now?.track.id ?? null)
              }
              playlists={playlists}
              onAddToPlaylist={(playlistId, trackId) => {
                ipc
                  .addToPlaylist(playlistId, trackId)
                  .then(() => {
                    refreshPlaylists();
                    showStatus("Added to playlist");
                  })
                  .catch((e) => showStatus(`${e}`));
              }}
              mediaType={mediaTypeFilter}
              onMediaType={setMediaTypeFilter}
            />
          </div>
        </div>
      ) : lineIn ? (
        <ReceiverPanel
          source={lineIn}
          status={engineStat}
          recording={recState}
          formatLabel={formatLabel}
          onOpenSettings={() => setSettingsOpen(true)}
          onStatus={setEngineStat}
          onError={showStatus}
          onRecordingSaved={(title) => {
            showStatus(`Saved “${title}” to the library`);
            refreshTracks();
          }}
        />
      ) : (
        <div className="library-layout">
          <PlaylistSidebar
            playlists={playlists}
            view={view}
            curator={curator}
            width={sidebarWidth}
            onSelect={(v) => {
              setArtistFilter(null);
              setView(v);
            }}
            onPlayPlaylist={playPlaylist}
            onCreate={(name) => {
              ipc
                .createPlaylist(name)
                .then(refreshPlaylists)
                .catch((e) => showStatus(`${e}`));
            }}
            onDelete={(id) => {
              ipc
                .deletePlaylist(id)
                .then(() => {
                  if (view.kind === "playlist" && view.id === id) {
                    setView({ kind: "all" });
                  }
                  return refreshPlaylists();
                })
                .catch((e) => showStatus(`${e}`));
            }}
          />
          <SidebarResizer
            width={sidebarWidth}
            min={160}
            max={480}
            onChange={setSidebarWidth}
            onCommit={(w) => localStorage.setItem("library.sidebarWidth", String(w))}
          />
          <LibraryTable
            tracks={tracks}
            onArtist={filterByArtist}
            heading={artistFilter ?? (view.kind === "playlist" ? view.name : undefined)}
            onRenameHeading={
              view.kind === "playlist"
                ? (name) => {
                    const id = view.id;
                    ipc
                      .renamePlaylist(id, name)
                      .then(() => {
                        setView({ kind: "playlist", id, name });
                        refreshPlaylists();
                        showStatus(`Renamed playlist to “${name}”`);
                      })
                      .catch((e) => showStatus(`${e}`));
                  }
                : undefined
            }
            searchable={view.kind === "all" && !artistFilter}
            query={query}
            onQueryChange={setQuery}
            sort={sort}
            onSortChange={setSort}
            onActivate={playTrack}
            onEdit={setEditTrack}
            onEnrich={handleEnrichTrack}
            curator={curator}
            enrichingId={enrichingId}
            nowPlayingId={
              stream ? stream.id : playState === "stopped" ? null : (now?.track.id ?? null)
            }
            playlists={playlists}
            onAddToPlaylist={(playlistId, trackId) => {
              ipc
                .addToPlaylist(playlistId, trackId)
                .then(() => {
                  refreshPlaylists();
                  if (view.kind === "playlist" && view.id === playlistId) {
                    refreshTracks();
                  }
                  showStatus("Added to playlist");
                })
                .catch((e) => showStatus(`${e}`));
            }}
            mediaType={mediaTypeFilter}
            onMediaType={setMediaTypeFilter}
          />
        </div>
      )}
      </div>

      {showNowPlaying ? (
        <NowPlayingPanel
          track={detailTrack}
          curator={curator}
          onCollapse={() => toggleNowPlaying(false)}
          onError={showStatus}
        />
      ) : (
        <button
          className="np-reopen"
          title="Show Now Playing"
          onClick={() => toggleNowPlaying(true)}
        >
          <ChevronLeft size={16} />
        </button>
      )}

      {theater && (
        <div className="theater-stage" ref={stageRef}>
          {!theaterVideo &&
            (theaterCover ? (
              <img className="theater-cover" src={theaterCover} alt="" />
            ) : (
              <MpxLogo className="theater-logo" />
            ))}
        </div>
      )}
      </div>

      {stream && stream.sourceKind === "radio" && (
        <RadioPlayer
          key={stream.uri}
          track={stream}
          playing={streamPlaying}
          volume={volume}
          onPlayingChange={setStreamPlaying}
          onError={showStatus}
        />
      )}

      {stream && stream.sourceKind === "stream" && (
        <DirectStreamPlayer
          key={stream.uri}
          track={stream}
          playing={streamPlaying}
          volume={volume}
          seekRequestMs={streamSeek}
          onSeeked={() => setStreamSeek(null)}
          onPlayingChange={setStreamPlaying}
          onTime={(pos, dur) => {
            setStreamPos(pos);
            if (dur > 0) setStreamDur(dur);
          }}
          onEnded={() => advanceFromEnd(stream.id)}
          onClose={() => setStream(null)}
          onError={showStatus}
          theaterRect={videoRect}
        />
      )}

      {stream && stream.sourceKind === "youtube" && (
        <StreamPlayer
          track={stream}
          playing={streamPlaying}
          volume={volume}
          seekRequestMs={streamSeek}
          onSeeked={() => setStreamSeek(null)}
          onPlayingChange={setStreamPlaying}
          onTime={(pos, dur) => {
            setStreamPos(pos);
            if (dur > 0) setStreamDur(dur);
          }}
          onEnded={() => advanceFromEnd(stream.id)}
          onClose={() => setStream(null)}
          theaterRect={videoRect}
        />
      )}


      <NowPlayingBar
        track={
          lineIn
            ? null
            : stream
              ? { ...stream, durationMs: streamDur > 0 ? streamDur : stream.durationMs }
              : (now?.track ?? null)
        }
        lineInLabel={
          lineIn ? `Line In — ${lineIn.charAt(0).toUpperCase()}${lineIn.slice(1)}` : null
        }
        state={stream ? (streamPlaying ? "playing" : "paused") : playState}
        positionMs={stream ? streamPos : positionMs}
        volume={volume}
        onPlay={() =>
          stream ? setStreamPlaying(true) : ipc.play().catch((e) => showStatus(`${e}`))
        }
        onPause={() =>
          stream ? setStreamPlaying(false) : ipc.pause().catch((e) => showStatus(`${e}`))
        }
        onStop={handleStop}
        onSeek={(ms) =>
          stream ? setStreamSeek(ms) : ipc.seek(ms).catch((e) => showStatus(`${e}`))
        }
        onVolume={handleVolume}
        onPrev={() => playPrev(nowRef.current.id)}
        onNext={() => playNext(nowRef.current.id)}
        canStep={!lineIn && (stream != null || now != null)}
        vuSynthetic={stream != null}
      />

      {mini && (
        <MiniPlayer
          track={lineIn ? null : detailTrack}
          cover={theaterCover}
          playing={stream ? streamPlaying : playState === "playing"}
          positionMs={stream ? streamPos : positionMs}
          durationMs={
            stream
              ? streamDur > 0
                ? streamDur
                : (detailTrack?.durationMs ?? 0)
              : (now?.track.durationMs ?? 0)
          }
          volume={volume}
          onPlay={() =>
            stream ? setStreamPlaying(true) : ipc.play().catch((e) => showStatus(`${e}`))
          }
          onPause={() =>
            stream ? setStreamPlaying(false) : ipc.pause().catch((e) => showStatus(`${e}`))
          }
          onSeek={(ms) =>
            stream ? setStreamSeek(ms) : ipc.seek(ms).catch((e) => showStatus(`${e}`))
          }
          onVolume={handleVolume}
          onPrev={() => playPrev(nowRef.current.id)}
          onNext={() => playNext(nowRef.current.id)}
          onExit={() => toggleMini(false)}
          canStep={!lineIn && (stream != null || now != null)}
          coverRef={miniCoverRef}
        />
      )}

      {mini && theaterVideo && miniRect && (
        <button
          className="mini-video-toggle"
          title={miniVideo ? "Show cover" : "Show video"}
          style={{
            top: miniRect.top + miniRect.height - 38,
            left: miniRect.left + miniRect.width - 38,
          }}
          onClick={() => setMiniVideo((v) => !v)}
        >
          {miniVideo ? <ImageIcon size={15} /> : <Film size={15} />}
        </button>
      )}

      {settingsOpen && (
        <SettingsPanel
          onClose={() => setSettingsOpen(false)}
          onError={showStatus}
          onSaved={() => {
            ipc
              .recordingFormatLabel()
              .then(setFormatLabel)
              .catch(() => {});
          }}
        />
      )}

      {addUrlMode && (
        <AddUrlModal
          mode={addUrlMode}
          onClose={() => setAddUrlMode(null)}
          onError={showStatus}
          onDone={(msg) => {
            showStatus(msg);
            refreshPlaylists();
            refreshTracks();
          }}
        />
      )}

      {goLiveOpen && (
        <GoLivePanel onClose={() => setGoLiveOpen(false)} onError={showStatus} />
      )}

      {ytSearchOpen && (
        <YouTubeSearchView
          onClose={() => setYtSearchOpen(false)}
          onError={showStatus}
          onInfo={(msg) => {
            showStatus(msg);
            refreshTracks();
          }}
          onPlay={(track) => {
            setYtSearchOpen(false);
            void playTrack(track);
            refreshTracks();
          }}
        />
      )}

      {proposals && (
        <EnrichReviewModal
          proposals={proposals}
          onClose={() => setProposals(null)}
          onError={showStatus}
          onApplied={(n) => {
            showStatus(
              n > 0 ? `Applied ${n} track update(s)` : "No changes applied",
            );
            refreshTracks();
          }}
        />
      )}

      {editTrack && (
        <TrackEditModal
          track={editTrack}
          onClose={() => setEditTrack(null)}
          onError={showStatus}
          onInfo={showStatus}
          onSaved={(updated) => {
            showStatus(`Updated “${updated.title ?? "track"}”`);
            refreshTracks();
            // keep the docked stream label fresh if we just edited it
            setStream((cur) => (cur && cur.id === updated.id ? updated : cur));
            setNow((cur) =>
              cur && cur.track.id === updated.id ? { ...cur, track: updated } : cur,
            );
          }}
          onDeleted={(removed) => {
            showStatus(`Removed “${removed.title ?? "track"}” from the library`);
            // if it was playing or docked, stop it
            if (stream && stream.id === removed.id) {
              setStream(null);
              ipc.stop().catch(() => {});
            }
            if (now?.track.id === removed.id) {
              setNow(null);
              ipc.stop().catch(() => {});
            }
            refreshPlaylists();
            refreshTracks();
          }}
        />
      )}
    </div>
  );
}
