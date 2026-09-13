import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AudioLines,
  ChevronLeft,
  Film,
  Image as ImageIcon,
  Maximize2,
  Minimize2,
  PictureInPicture2,
} from "lucide-react";
import MpxLogo from "./components/MpxLogo";
import { YouTubeIcon, SpotifyIcon, AiIcon } from "./components/BrandIcons";
import CommandPalette, { type PaletteAction } from "./components/CommandPalette";
import AIAssistantModal from "./components/AIAssistantModal";
import ManageMusicMenu from "./components/ManageMusicMenu";
import Visualizer from "./components/Visualizer";
import VizSettingsBoard from "./components/VizSettingsBoard";
import { loadViz, saveViz, type VizSettings } from "./lib/vizSettings";
import {
  loadColumnPrefs,
  saveColumnPrefs,
  type ColumnPrefs,
} from "./lib/columnPrefs";
import GoLivePanel from "./components/GoLivePanel";
import AddUrlModal from "./components/AddUrlModal";
import BuildPlaylistWithAIModal from "./components/BuildPlaylistWithAIModal";
import WelcomeModal from "./components/WelcomeModal";
import SharePlaylistModal from "./components/SharePlaylistModal";
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
import MusicPaxFeed from "./components/MusicPaxFeed";
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
  FolderInfo,
  PlaylistInfo,
  RadioStation,
  RecordingState,
  SortSpec,
  Track,
} from "./lib/types";
import "./styles/theme.css";

const VIDEO_URI_EXTS = ["mp4", "m4v", "webm", "mov", "mkv", "avi", "ogv"];
type ListenOrder = "recent" | "most_played" | "shuffle";

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

function seededTrackScore(id: number, seed: number): number {
  let x = Math.imul(id ^ seed, 0x45d9f3b);
  x = Math.imul((x >>> 16) ^ x, 0x45d9f3b);
  return ((x >>> 16) ^ x) >>> 0;
}

function orderForListening(list: Track[], order: ListenOrder, shuffleSeed: number): Track[] {
  if (order === "recent") {
    return [...list].sort((a, b) => (b.addedAt - a.addedAt) || a.id - b.id);
  }
  if (order === "most_played") {
    return [...list].sort(
      (a, b) => (b.playCount - a.playCount) || (b.addedAt - a.addedAt) || a.id - b.id,
    );
  }
  return [...list].sort(
    (a, b) => seededTrackScore(a.id, shuffleSeed) - seededTrackScore(b.id, shuffleSeed),
  );
}

export default function App() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [view, setView] = useState<LibraryView>({ kind: "all" });
  // When set, the library shows only this artist's tracks (across all sources).
  // Cleared by selecting anything in the sidebar (e.g. "All Tracks").
  const [artistFilter, setArtistFilter] = useState<string | null>(null);
  const [playlists, setPlaylists] = useState<PlaylistInfo[]>([]);
  const [folders, setFolders] = useState<FolderInfo[]>([]);
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
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [addUrlMode, setAddUrlMode] = useState<"youtube" | "spotify" | null>(null);
  const [aiBuildOpen, setAiBuildOpen] = useState(false);
  // First-run welcome: shown until the user saves a key or skips (per install).
  const [showWelcome, setShowWelcome] = useState(() => {
    try {
      return localStorage.getItem("musicpax.onboarded") !== "1";
    } catch {
      return false;
    }
  });
  const [shareTarget, setShareTarget] = useState<{ id: number; name: string } | null>(null);
  const [ytSearchOpen, setYtSearchOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem("library.sidebarWidth"));
    return saved >= 160 && saved <= 480 ? saved : 200;
  });
  const [goLiveOpen, setGoLiveOpen] = useState(false);
  // AI Assistant: provider label (null = not configured → menu entry hidden).
  const [aiLabel, setAiLabel] = useState<string | null>(null);
  const [aiAssistantOpen, setAiAssistantOpen] = useState(false);
  const [visualizerOpen, setVisualizerOpen] = useState(false);
  const [vizBoardOpen, setVizBoardOpen] = useState(false);
  const [vizSettings, setVizSettings] = useState<VizSettings>(loadViz);
  const setViz = useCallback((patch: Partial<VizSettings>) => {
    setVizSettings((s) => {
      const next = { ...s, ...patch };
      saveViz(next);
      return next;
    });
  }, []);
  // Library-table column visibility (Album/Genre/Year/Length), set in Settings.
  const [columnPrefs, setColumnPrefs] = useState<ColumnPrefs>(loadColumnPrefs);
  const setColumnPref = useCallback((key: keyof ColumnPrefs, value: boolean) => {
    setColumnPrefs((s) => {
      const next = { ...s, [key]: value };
      saveColumnPrefs(next);
      return next;
    });
  }, []);
  // System-audio capture for the visualizer (lets YouTube be visualized).
  const [systemCapture, setSystemCapture] = useState(false);
  // Feedback for the system-audio capture flow, shown inside the visualizer
  // overlay (the status banner is hidden behind it).
  const [vizCaptureMsg, setVizCaptureMsg] = useState<string | null>(null);
  const closeVisualizer = useCallback(() => {
    setVisualizerOpen(false);
    setVizBoardOpen(false);
    setSystemCapture(false);
    setVizCaptureMsg(null);
    ipc.stopVizCapture().catch(() => {});
    ipc.stopScreenAudio().catch(() => {});
  }, []);
  useEffect(() => {
    if (!visualizerOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeVisualizer();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visualizerOpen, closeVisualizer]);
  // Gate AI features on the configured provider AND a key being present — but
  // read both from plain DB settings, never the keychain. Reading the keychain
  // on launch makes macOS prompt for the login password every start (the app
  // isn't code-signed); Settings/onboarding mirror "key present" into
  // enrich.key_set.* flags, and the actual key is only read later, when a
  // feature runs. Cloud providers require the user's own key (so no one is
  // billed for someone else's usage); local Ollama needs none.
  const refreshAiLabel = useCallback(() => {
    ipc
      .getSettings()
      .then((s) => {
        const p = s["enrich.ai_provider"];
        // "ready" unless we KNOW the key is missing (flag === "0", written by
        // Settings/onboarding). An absent flag means we haven't checked yet
        // (e.g. first launch after upgrade) — allow it optimistically rather than
        // falsely locking a user who already has a key; if it's actually missing
        // the feature reports it and the flag then becomes "0".
        const ready =
          p === "ollama" ||
          (!!p && p !== "none" && s[`enrich.key_set.${p}`] !== "0");
        setAiLabel(ready ? p : null);
      })
      .catch(() => setAiLabel(null));
  }, []);

  useEffect(() => {
    if (settingsOpen) return; // re-check whenever the Settings dialog closes
    refreshAiLabel();
  }, [settingsOpen, refreshAiLabel]);
  // Theater (in-app fullscreen) for the now-playing media.
  // Window size ladder: full app → mini card → micro bar.
  const [windowSize, setWindowSize] = useState<ipc.WindowSize>("full");
  const mini = windowSize !== "full";
  const micro = windowSize === "micro";
  const [miniVideo, setMiniVideo] = useState(false);
  const miniCoverRef = useRef<HTMLDivElement | null>(null);
  const [miniRect, setMiniRect] = useState<
    { top: number; left: number; width: number; height: number } | null
  >(null);
  const resizeWindow = useCallback((size: ipc.WindowSize) => {
    setWindowSize(size);
    if (size !== "full") setTheater(false);
    // Only the mini card has a cover slot the video can fill.
    if (size !== "mini") setMiniVideo(false);
    ipc.setWindowSize(size).catch(() => {});
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
  const [repairProgress, setRepairProgress] = useState<{
    phase: "checking" | "repairing";
    done: number;
    total: number;
    healed: number;
  } | null>(null);
  const [mode, setMode] = useState<UiMode>(
    () => (localStorage.getItem("ui.mode") as UiMode) || "listening",
  );
  const curator = mode === "curator";
  const [listenOrder, setListenOrder] = useState<ListenOrder>(() => {
    const saved = localStorage.getItem("listen.order");
    return saved === "most_played" || saved === "shuffle" ? saved : "recent";
  });
  const [shuffleSeed, setShuffleSeed] = useState(() => Number(localStorage.getItem("listen.shuffleSeed")) || Date.now());

  const changeMode = (m: UiMode) => {
    setMode(m);
    localStorage.setItem("ui.mode", m);
  };
  const changeListenOrder = (order: ListenOrder) => {
    setListenOrder(order);
    localStorage.setItem("listen.order", order);
    if (order === "shuffle") {
      const next = Date.now();
      setShuffleSeed(next);
      localStorage.setItem("listen.shuffleSeed", String(next));
    }
  };
  const reshuffle = () => {
    const next = Date.now();
    setShuffleSeed(next);
    localStorage.setItem("listen.shuffleSeed", String(next));
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

  // Visualizer: capture a system-audio loopback so YouTube can be visualized.
  // `device` = a specific audio input to capture (a virtual/loopback device —
  // needs no permission); `null` = the no-install ScreenCaptureKit path (needs
  // Screen Recording, which unsigned dev builds keep losing across rebuilds).
  const trySystemAudio = useCallback(async (device: string | null) => {
    const HINTS = [
      "blackhole",
      "loopback",
      "soundflower",
      "vb-audio",
      "vb-cable",
      "voicemeeter",
      "stereo mix",
      "aggregate",
      "multi-output",
      "wave link",
      "ark",
      "audio routing",
      "soundsource",
    ];
    setVizCaptureMsg("Starting system-audio capture…");
    // Explicit device pick → capture that input directly, no Screen Recording.
    if (device) {
      try {
        await ipc.startVizCapture(device);
        setVizCaptureMsg(null);
        setSystemCapture(true);
      } catch (e) {
        setVizCaptureMsg(`Couldn't capture “${device}”: ${e}`);
      }
      return;
    }
    // No device chosen: no-install ScreenCaptureKit (macOS 13+). The first run
    // triggers the Screen-Recording permission prompt.
    try {
      await ipc.startScreenAudio();
      setVizCaptureMsg(null);
      setSystemCapture(true);
      return;
    } catch (screenErr) {
      // Fall back to a loopback input device (BlackHole etc.) if one exists.
      try {
        const devices = await ipc.getAudioInputDevices();
        const match = devices.find((d) => HINTS.some((h) => d.name.toLowerCase().includes(h)));
        if (match) {
          await ipc.startVizCapture(match.name);
          setVizCaptureMsg(null);
          setSystemCapture(true);
          return;
        }
      } catch {
        /* no loopback either — show the ScreenCaptureKit message below */
      }
      setVizCaptureMsg(`${screenErr}`);
    }
  }, []);
  // Stop capture if playback moves away from YouTube while capturing.
  useEffect(() => {
    if (systemCapture && stream?.sourceKind !== "youtube") {
      ipc.stopVizCapture().catch(() => {});
      ipc.stopScreenAudio().catch(() => {});
      setSystemCapture(false);
    }
  }, [stream, systemCapture]);

  const refreshPlaylists = useCallback(async () => {
    try {
      const [lists, dirs] = await Promise.all([
        ipc.listPlaylists(),
        ipc.listPlaylistFolders(),
      ]);
      setPlaylists(lists);
      setFolders(dirs);
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
      } else if (view.kind === "favorites") {
        // "My Favorites": the library, narrowed to hearted tracks (rating >= 1).
        const all = await ipc.listTracks({ query, sort, mediaType });
        ts = all.filter((t) => t.rating >= 1);
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

  // Heart toggle: favorite/unfavorite a track (stored as rating >= 1). Optimistic
  // — update the row in place, and drop it from the list if we're unhearting it
  // inside the My Favorites view.
  const toggleFavorite = useCallback(
    async (t: Track) => {
      const fav = t.rating >= 1;
      try {
        await ipc.setTrackFavorite(t.id, !fav);
        setTracks((prev) => {
          const next = prev.map((x) => (x.id === t.id ? { ...x, rating: fav ? 0 : 1 } : x));
          return view.kind === "favorites" && fav ? next.filter((x) => x.id !== t.id) : next;
        });
      } catch (e) {
        showStatus(`${e}`);
      }
    },
    [view, showStatus],
  );

  // Self-healing library: check every YouTube stream and re-resolve dead ones.
  const handleRepair = useCallback(async () => {
    if (repairProgress) return; // already running
    setRepairProgress({ phase: "checking", done: 0, total: 0, healed: 0 });
    const unlisten = await ipc.onRepairProgress(setRepairProgress);
    try {
      const r = await ipc.repairStreams();
      const bits =
        r.dead === 0
          ? [`checked ${r.checked} — all playable`]
          : [
              `checked ${r.checked}`,
              `${r.dead} unavailable`,
              `${r.healed} re-resolved`,
              ...(r.stillDead > 0 ? [`${r.stillDead} unfixable`] : []),
            ];
      showStatus(`Dead-link repair: ${bits.join(" · ")}`);
      if (r.healed > 0) refreshTracks();
    } catch (e) {
      showStatus(`Repair failed: ${e}`);
    } finally {
      unlisten();
      setRepairProgress(null);
    }
  }, [repairProgress, showStatus, refreshTracks]);

  // Auto-heal: when the YouTube embed reports the playing video is unplayable,
  // re-resolve it to a working replacement once (guarded per track to avoid a
  // loop if the replacement also fails). The player reloads via the new uri.
  const autoHealTried = useRef<Set<number>>(new Set());
  const handleStreamFatal = useCallback(async () => {
    const t = stream;
    if (!t || t.sourceKind !== "youtube" || autoHealTried.current.has(t.id)) return;
    autoHealTried.current.add(t.id);
    showStatus(`“${t.title ?? "This video"}” is unavailable — finding a replacement…`);
    try {
      const r = await ipc.reresolveStream(t.id);
      if (r.healed && r.newUri) {
        const newUri = r.newUri;
        setStream((s) => (s && s.id === t.id ? { ...s, uri: newUri, artPath: null } : s));
        setTracks((prev) =>
          prev.map((x) => (x.id === t.id ? { ...x, uri: newUri, artPath: null } : x)),
        );
        showStatus(`Re-resolved “${t.title ?? "video"}” to a working version`);
      } else {
        showStatus(`Couldn't find a working replacement for “${t.title ?? "this video"}”`);
      }
    } catch (e) {
      showStatus(`Auto-heal failed: ${e}`);
    }
  }, [stream, showStatus]);

  // ⌘K / Ctrl+K toggles the command palette from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);


  // Local files that have moved/ejected — flagged in the table with a relink dot.
  const [missingIds, setMissingIds] = useState<Set<number>>(new Set());
  const refreshMissing = useCallback(() => {
    ipc
      .checkMissingFiles()
      .then((ids) => setMissingIds(new Set(ids)))
      .catch(() => {});
  }, []);
  useEffect(() => {
    refreshMissing();
  }, [refreshMissing]);
  const relinkFile = useCallback(
    async (track: Track) => {
      try {
        const picked = await open({
          multiple: false,
          filters: [
            {
              name: "Audio",
              extensions: ["mp3", "flac", "wav", "aiff", "aif", "m4a", "aac", "ogg", "oga", "opus"],
            },
          ],
        });
        if (typeof picked !== "string") return;
        await ipc.relinkTrack(track.id, picked);
        showStatus(`Relinked “${track.title ?? "track"}”`);
        refreshMissing();
        refreshTracks();
      } catch (e) {
        showStatus(`${e}`);
      }
    },
    [showStatus, refreshMissing, refreshTracks],
  );

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
  const displayTracks = useMemo(
    () => (curator ? tracks : orderForListening(tracks, listenOrder, shuffleSeed)),
    [curator, tracks, listenOrder, shuffleSeed],
  );
  tracksRef.current = displayTracks;
  // The play queue is snapshotted when a library track starts (see playTrack),
  // so searching or switching views afterwards can't derail next/prev — which
  // otherwise walked the live, now-different table. Feed items (negative ids)
  // advance through feedQueueRef instead.
  const queueRef = useRef<Track[]>([]);
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
    async (track: Track, queue?: Track[]) => {
      // Freeze the queue context at play time so a later search/filter can't
      // change what next/prev advance through. Callers that already know the
      // intended queue (e.g. play-a-playlist, whose view refresh is debounced
      // and hasn't landed in tracksRef yet) pass it explicitly. Feed items
      // (negative ids) keep using feedQueueRef, which the feed maintains.
      if (track.id >= 0) queueRef.current = queue ?? tracksRef.current;
      try {
        if (track.capability === "OWNED") {
          setStream(null);
          await ipc.loadTrack(track.id);
          await ipc.play();
          setNow(await ipc.nowPlaying());
          setEngineStat(null);
          setSource("library");
          setPositionMs(0);
          setTracks((prev) =>
            prev.map((t) =>
              t.id === track.id ? { ...t, playCount: t.playCount + 1 } : t,
            ),
          );
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
          if (track.id >= 0) {
            ipc.recordPlay(track.id).catch((e) => showStatus(`${e}`));
            setTracks((prev) =>
              prev.map((t) =>
                t.id === track.id ? { ...t, playCount: t.playCount + 1 } : t,
              ),
            );
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

  // The active playback queue for MusicPax Feed items (synthesised tracks have
  // negative ids and aren't in the library list, so next/prev advance through
  // this instead). The feed keeps it fresh as it loads more pages.
  const feedQueueRef = useRef<Track[]>([]);
  const setFeedQueue = useCallback((q: Track[]) => {
    feedQueueRef.current = q;
  }, []);

  /// Advance to the next track in the current context — across capabilities,
  /// so mixed playlists flow from local files into streams and back. Feed items
  /// (negative ids) advance through the feed queue.
  const playNext = useCallback(
    (afterTrackId: number | null) => {
      const list =
        afterTrackId != null && afterTrackId < 0 ? feedQueueRef.current : queueRef.current;
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

  // Manual "previous track" — step back one in the current context.
  const playPrev = useCallback(
    (beforeTrackId: number | null) => {
      const list =
        beforeTrackId != null && beforeTrackId < 0 ? feedQueueRef.current : queueRef.current;
      if (!list.length || beforeTrackId == null) return;
      const idx = list.findIndex((t) => t.id === beforeTrackId);
      if (idx > 0) void playTrack(list[idx - 1]);
    },
    [playTrack],
  );

  // Playback commands from the tray / global hotkey / (later) macOS media keys.
  // Routes to the engine or the YouTube embed depending on what's playing.
  const handleMediaCommand = useCallback(
    (cmd: string) => {
      const playing = stream ? streamPlaying : playState === "playing";
      switch (cmd) {
        case "playpause":
          if (stream) setStreamPlaying((p) => !p);
          else if (playing) ipc.pause().catch((e) => showStatus(`${e}`));
          else ipc.play().catch((e) => showStatus(`${e}`));
          break;
        case "play":
          if (stream) setStreamPlaying(true);
          else ipc.play().catch((e) => showStatus(`${e}`));
          break;
        case "pause":
          if (stream) setStreamPlaying(false);
          else ipc.pause().catch((e) => showStatus(`${e}`));
          break;
        case "next":
          playNext(nowRef.current.id);
          break;
        case "prev":
          playPrev(nowRef.current.id);
          break;
      }
    },
    [stream, streamPlaying, playState, playNext, playPrev, showStatus],
  );
  useEffect(() => {
    let un: (() => void) | undefined;
    ipc.onMediaCommand(handleMediaCommand).then((fn) => (un = fn));
    return () => un?.();
  }, [handleMediaCommand]);

  // Publish the current track + play state to the OS Now Playing surface
  // (macOS Control Center / media keys / lock screen). The system extrapolates
  // elapsed time from the rate, so we only push on track / play-state change
  // (not every position tick), reading the live position from a ref.
  const npTrack = stream ?? now?.track ?? null;
  const npPlaying = stream ? streamPlaying : playState === "playing";
  const npDuration = stream ? (streamDur > 0 ? streamDur : npTrack?.durationMs ?? null) : (npTrack?.durationMs ?? null);
  const curPosRef = useRef(0);
  curPosRef.current = stream ? streamPos : positionMs;
  useEffect(() => {
    ipc
      .setNowPlaying({
        title: npTrack?.title ?? null,
        artist: npTrack?.artist ?? null,
        album: npTrack?.album ?? null,
        durationMs: npDuration,
        positionMs: curPosRef.current,
        playing: !!npTrack && npPlaying,
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [npTrack?.id, npTrack?.title, npTrack?.artist, npPlaying, npDuration]);

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
        // Pass the playlist as the queue explicitly — the view refresh above is
        // debounced, so tracksRef still holds the previous view at this point.
        await playTrack(ts[0], ts);
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
    if (!mini || micro || !theaterVideo) {
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
  }, [mini, micro, theaterVideo]);

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

  // Command-palette actions (navigation, modals, tools). Rebuilt each render so
  // labels/handlers stay fresh; only realized when the palette is open.
  const paletteActions: PaletteAction[] = [
    { id: "all", label: "Go to All Tracks", run: () => setView({ kind: "all" }) },
    { id: "fav", label: "Go to My Favorites", run: () => setView({ kind: "favorites" }) },
    { id: "feed", label: "Go to MusicPax Feed", run: () => setView({ kind: "feed" }) },
    {
      id: "mode",
      label: curator ? "Switch to Listen mode" : "Switch to Curate mode",
      run: () => changeMode(curator ? "listening" : "curator"),
    },
    { id: "settings", label: "Open Settings", run: () => setSettingsOpen(true) },
    { id: "viz", label: "Open Visualizer", run: () => setVisualizerOpen(true) },
    { id: "mini", label: "Open Mini Player", run: () => resizeWindow("mini") },
    { id: "micro", label: "Open Micro Player", run: () => resizeWindow("micro") },
    { id: "yt", label: "Search YouTube", hint: "add music", run: () => setYtSearchOpen(true) },
    {
      id: "spotify",
      label: "Import Spotify Playlist",
      hint: "add music",
      run: () => setAddUrlMode("spotify"),
    },
    {
      id: "aibuild",
      label: "Build Playlist with AI",
      hint: "add music",
      run: () => setAiBuildOpen(true),
    },
    { id: "folder", label: "Import Music Folder", hint: "add music", run: () => handleImport() },
    { id: "mpx", label: "Import .mpx Playlist", hint: "add music", run: () => handleImportMpx() },
    {
      id: "repair",
      label: "Repair Dead Links",
      hint: "re-resolve dead YouTube streams",
      run: () => handleRepair(),
    },
    { id: "golive", label: "Go Live", hint: "broadcast", run: () => setGoLiveOpen(true) },
    ...(aiLabel
      ? [{ id: "ai", label: "AI Assistant", run: () => setAiAssistantOpen(true) }]
      : []),
  ];

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
              <button
                className="settings-button brand-youtube"
                onClick={() => setYtSearchOpen(true)}
                title="Search YouTube"
                aria-label="Search YouTube"
              >
                <YouTubeIcon size={18} />
              </button>
              <button
                className="settings-button brand-spotify"
                onClick={() => setAddUrlMode("spotify")}
                title="Import Spotify Playlist"
                aria-label="Import Spotify Playlist"
              >
                <SpotifyIcon size={18} />
              </button>
              <button
                className="settings-button brand-ai"
                onClick={() => setAiBuildOpen(true)}
                title="Build Playlist with AI"
                aria-label="Build Playlist with AI"
              >
                <AiIcon size={18} />
              </button>
              <ManageMusicMenu
                busy={busy}
                canEnrich={source === "library" && tracks.length > 0 && enrichProgress == null}
                onAir={onAir}
                onImportFolder={handleImport}
                onImportMpx={handleImportMpx}
                onClean={handleCleanAll}
                onEnrich={handleEnrichAll}
                onRepair={handleRepair}
                aiAvailable={!!aiLabel}
                onAiAssistant={() => setAiAssistantOpen(true)}
                onGoLive={() => setGoLiveOpen(true)}
              />
            </>
          )}
          {!curator && (
            <>
              <button
                className="settings-button"
                onClick={() => resizeWindow("mini")}
                title="Mini player"
              >
                <PictureInPicture2 size={16} />
              </button>
              <button
                className={`settings-button${visualizerOpen ? " active" : ""}`}
                onClick={() => (visualizerOpen ? closeVisualizer() : setVisualizerOpen(true))}
                disabled={!visualizerOpen && !detailTrack}
                title={visualizerOpen ? "Exit visualizer" : "Audio visualizer"}
              >
                <AudioLines size={16} />
              </button>
              <button
                className="settings-button"
                onClick={() => setTheater(!theater)}
                disabled={!theater && !detailTrack}
                title={theater ? "Exit full screen" : "Full screen (theater)"}
              >
                {theater ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
              </button>
            </>
          )}
          <ModeMenu
            mode={mode}
            onMode={changeMode}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        </div>
      </header>

      {/* Slides in directly under the header — an inline bar, not an overlay,
          so editing connection details can't be dismissed by a stray click. */}
      {goLiveOpen && (
        <GoLivePanel onClose={() => setGoLiveOpen(false)} onError={showStatus} />
      )}

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

      {repairProgress && (
        <div className="enrich-banner">
          <div className="mirror-progress-bar">
            <div
              className="mirror-progress-fill"
              style={{
                width: `${
                  repairProgress.total ? (repairProgress.done / repairProgress.total) * 100 : 0
                }%`,
              }}
            />
          </div>
          <div className="mirror-progress-text">
            {repairProgress.phase === "checking"
              ? `Checking streams ${repairProgress.done}/${repairProgress.total} for dead links…`
              : `Re-resolving ${repairProgress.done}/${repairProgress.total} · ${repairProgress.healed} healed`}
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
              tracks={displayTracks}
              onArtist={filterByArtist}
              searchable
              query={query}
              onQueryChange={setQuery}
              sort={sort}
              onSortChange={setSort}
              onActivate={playTrack}
              onEdit={setEditTrack}
              onEnrich={handleEnrichTrack}
              onToggleFavorite={toggleFavorite}
              visibleColumns={columnPrefs}
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
              listenOrder={listenOrder}
              onListenOrderChange={changeListenOrder}
              onReshuffle={reshuffle}
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
            folders={folders}
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
            onRename={(id, name) => {
              ipc
                .renamePlaylist(id, name)
                .then(() => {
                  if (view.kind === "playlist" && view.id === id) {
                    setView({ kind: "playlist", id, name });
                  }
                  refreshPlaylists();
                  showStatus(`Renamed playlist to “${name}”`);
                })
                .catch((e) => showStatus(`${e}`));
            }}
            onShare={(id, name) => setShareTarget({ id, name })}
            onRowDrop={(playlistId, folderId, orderedIds) => {
              // Optimistic: re-home + reorder locally, then persist + reconcile.
              setPlaylists((prev) =>
                orderedIds.flatMap((id) =>
                  prev
                    .filter((p) => p.id === id)
                    .map((p) => (p.id === playlistId ? { ...p, folderId } : p)),
                ),
              );
              const moved = playlists.find((p) => p.id === playlistId);
              const home =
                moved && (moved.folderId ?? null) !== folderId
                  ? ipc.movePlaylistToFolder(playlistId, folderId)
                  : Promise.resolve();
              home
                .then(() => ipc.reorderPlaylists(orderedIds))
                .then(refreshPlaylists)
                .catch((e) => showStatus(`${e}`));
            }}
            onMoveToFolder={(playlistId, folderId) => {
              ipc
                .movePlaylistToFolder(playlistId, folderId)
                .then(refreshPlaylists)
                .catch((e) => showStatus(`${e}`));
            }}
            onCreateFolder={(name) => {
              ipc
                .createPlaylistFolder(name)
                .then(refreshPlaylists)
                .catch((e) => showStatus(`${e}`));
            }}
            onRenameFolder={(id, name) => {
              ipc
                .renamePlaylistFolder(id, name)
                .then(refreshPlaylists)
                .catch((e) => showStatus(`${e}`));
            }}
            onDeleteFolder={(id) => {
              ipc
                .deletePlaylistFolder(id)
                .then(() => {
                  refreshPlaylists();
                  showStatus("Folder deleted — its playlists are back in the list");
                })
                .catch((e) => showStatus(`${e}`));
            }}
            onToggleFolder={(id, collapsed) => {
              // Optimistic toggle; persistence is fire-and-forget.
              setFolders((prev) =>
                prev.map((f) => (f.id === id ? { ...f, collapsed } : f)),
              );
              ipc.setFolderCollapsed(id, collapsed).catch(() => {});
            }}
            onReorderFolders={(ids) => {
              setFolders((prev) => ids.flatMap((id) => prev.filter((f) => f.id === id)));
              ipc
                .reorderPlaylistFolders(ids)
                .then(refreshPlaylists)
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
          {view.kind === "feed" ? (
            <MusicPaxFeed
              onPlay={playTrack}
              onQueue={setFeedQueue}
              onSaved={(title) => {
                showStatus(`Saved “${title}” to the library`);
                refreshTracks();
              }}
              playingUri={stream?.uri ?? null}
              onError={showStatus}
            />
          ) : (
          <LibraryTable
            tracks={displayTracks}
            onArtist={filterByArtist}
            fadeKey={
              view.kind === "playlist" ? `p${view.id}` : `${view.kind}:${artistFilter ?? ""}`
            }
            heading={
              artistFilter ??
              (view.kind === "playlist"
                ? view.name
                : view.kind === "favorites"
                  ? "My Favorites"
                  : undefined)
            }
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
            searchable={(view.kind === "all" || view.kind === "favorites") && !artistFilter}
            emptyMessage={
              view.kind === "favorites"
                ? "No favorites yet — tap the heart on any track to add it."
                : undefined
            }
            query={query}
            onQueryChange={setQuery}
            sort={sort}
            onSortChange={setSort}
            onActivate={playTrack}
            onEdit={setEditTrack}
            onEnrich={handleEnrichTrack}
            onToggleFavorite={toggleFavorite}
            visibleColumns={columnPrefs}
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
            listenOrder={listenOrder}
            onListenOrderChange={changeListenOrder}
            onReshuffle={reshuffle}
            missingIds={missingIds}
            onRelink={relinkFile}
            onBulkDelete={async (ids) => {
              const removed = await ipc.deleteTracks(ids);
              const idset = new Set(ids);
              // If a deleted track was playing or docked, stop it.
              if (stream && idset.has(stream.id)) {
                setStream(null);
                ipc.stop().catch(() => {});
              }
              if (now && idset.has(now.track.id)) {
                setNow(null);
                ipc.stop().catch(() => {});
              }
              refreshPlaylists();
              refreshTracks();
              showStatus(
                `Deleted ${removed} track${removed === 1 ? "" : "s"} from the library`,
              );
            }}
            onBulkAddToPlaylist={async (playlistId, ids) => {
              try {
                const added = await ipc.addTracksToPlaylist(playlistId, ids);
                refreshPlaylists();
                if (view.kind === "playlist" && view.id === playlistId) refreshTracks();
                const skipped = ids.length - added;
                showStatus(
                  `Added ${added} track${added === 1 ? "" : "s"} to playlist` +
                    (skipped > 0 ? ` (${skipped} already there)` : ""),
                );
              } catch (e) {
                showStatus(`${e}`);
                throw e; // let the table keep the selection so the user can retry
              }
            }}
            onCreatePlaylistWithTracks={async (name, ids) => {
              try {
                const id = await ipc.createPlaylist(name);
                const added = await ipc.addTracksToPlaylist(id, ids);
                refreshPlaylists();
                setView({ kind: "playlist", id, name });
                showStatus(
                  `Created “${name}” with ${added} track${added === 1 ? "" : "s"}`,
                );
              } catch (e) {
                showStatus(`${e}`);
                throw e;
              }
            }}
            onShare={
              view.kind === "playlist"
                ? () => setShareTarget({ id: view.id, name: view.name })
                : undefined
            }
          />
          )}
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
          onFatalError={handleStreamFatal}
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
          micro={micro}
          onGrow={() => resizeWindow(micro ? "mini" : "full")}
          onShrink={micro ? undefined : () => resizeWindow("micro")}
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

      {visualizerOpen && (
        <Visualizer
          key={`${stream?.sourceKind ?? "engine"}-${systemCapture}`}
          settings={vizSettings}
          noAudio={stream?.sourceKind === "youtube"}
          systemCapture={systemCapture}
          onSystemAudio={trySystemAudio}
          captureMsg={vizCaptureMsg}
          boardOpen={vizBoardOpen}
          onToggleBoard={() => setVizBoardOpen((o) => !o)}
        />
      )}
      {visualizerOpen && vizBoardOpen && (
        <VizSettingsBoard
          settings={vizSettings}
          onChange={setViz}
          onClose={() => setVizBoardOpen(false)}
        />
      )}

      {aiAssistantOpen && aiLabel && (
        <AIAssistantModal
          providerLabel={aiLabel}
          onClose={() => setAiAssistantOpen(false)}
          onApplied={(n) => {
            showStatus(`Applied ${n} change${n === 1 ? "" : "s"}`);
            refreshTracks();
          }}
          onError={showStatus}
        />
      )}

      {paletteOpen && (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          actions={paletteActions}
          tracks={tracks}
          playlists={playlists}
          onPlayTrack={playTrack}
          onOpenPlaylist={(id, name) => setView({ kind: "playlist", id, name })}
        />
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
          columnPrefs={columnPrefs}
          onColumnPref={setColumnPref}
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

      {aiBuildOpen && (
        <BuildPlaylistWithAIModal
          providerLabel={aiLabel}
          onClose={() => setAiBuildOpen(false)}
          onError={showStatus}
          onDone={(msg) => {
            showStatus(msg);
            refreshPlaylists();
            refreshTracks();
          }}
          onOpenSettings={() => {
            setAiBuildOpen(false);
            setSettingsOpen(true);
          }}
        />
      )}

      {showWelcome && (
        <WelcomeModal
          onError={showStatus}
          onComplete={(saved) => {
            try {
              localStorage.setItem("musicpax.onboarded", "1");
            } catch {
              /* private mode / storage disabled — onboarding just re-shows */
            }
            setShowWelcome(false);
            if (saved) {
              refreshAiLabel();
              showStatus("AI features enabled");
            }
          }}
        />
      )}

      {shareTarget && (
        <SharePlaylistModal
          playlistId={shareTarget.id}
          playlistName={shareTarget.name}
          onClose={() => setShareTarget(null)}
          onError={showStatus}
          onDone={showStatus}
        />
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
