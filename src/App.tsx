import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Sparkles } from "lucide-react";
import AddUrlModal from "./components/AddUrlModal";
import EnrichReviewModal from "./components/EnrichReviewModal";
import ModeMenu, { type UiMode } from "./components/ModeMenu";
import RadioPanel from "./components/RadioPanel";
import RadioPlayer from "./components/RadioPlayer";
import TrackEditModal from "./components/TrackEditModal";
import LibraryTable from "./components/LibraryTable";
import Logo from "./components/Logo";
import NowPlayingBar from "./components/NowPlayingBar";
import PlaylistSidebar, { type LibraryView } from "./components/PlaylistSidebar";
import ReceiverPanel from "./components/ReceiverPanel";
import SettingsPanel from "./components/SettingsPanel";
import SourceSelector, { type SelectableSource } from "./components/SourceSelector";
import StreamPlayer from "./components/StreamPlayer";
import * as ipc from "./lib/ipc";
import type {
  AudioDevice,
  EngineStatus,
  EnrichProposal,
  LineInSource,
  NowPlaying,
  PlaybackState,
  PlaylistInfo,
  RadioStation,
  RecordingState,
  SortSpec,
  Track,
} from "./lib/types";
import "./styles/theme.css";

export default function App() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [view, setView] = useState<LibraryView>({ kind: "all" });
  const [playlists, setPlaylists] = useState<PlaylistInfo[]>([]);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortSpec>({ field: "added_at", dir: "desc" });
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
  const [addUrlOpen, setAddUrlOpen] = useState(false);
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
      if (view.kind === "playlist") {
        setTracks(await ipc.playlistTracks(view.id));
      } else {
        setTracks(await ipc.listTracks({ query, sort }));
      }
    } catch (e) {
      showStatus(`Failed to load library: ${e}`);
    }
  }, [view, query, sort, showStatus]);

  // Debounced refresh on view/search/sort change.
  const debounce = useRef<number | undefined>(undefined);
  useEffect(() => {
    window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(refreshTracks, 150);
    return () => window.clearTimeout(debounce.current);
  }, [refreshTracks]);

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
    ];
    return () => {
      subs.forEach((p) => p.then((un) => un()));
    };
  }, [showStatus, refreshPlaylists]);

  // Both per-row and batch enrich PROPOSE changes (no writes); the review
  // modal then lets the user approve per field before anything is applied.
  const runProposal = async (ids: number[], singleId?: number) => {
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
      const report = await ipc.proposeEnrichment(ids);
      if (report.proposals.length === 0) {
        showStatus(
          report.total === 1
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
          (track.sourceKind === "youtube" || track.sourceKind === "radio")
        ) {
          await ipc.stop().catch(() => {});
          setNow(null);
          setStream(track);
          setStreamPlaying(true);
          setStreamPos(0);
          setStreamDur(0);
          setStreamSeek(null);
          setEngineStat(null);
          // radio tracks keep the Radio panel open; others go to Library
          if (track.sourceKind !== "radio") setSource("library");
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

  // Natural end of an OWNED track → advance.
  const prevPlayState = useRef<PlaybackState>("stopped");
  useEffect(() => {
    const was = prevPlayState.current;
    prevPlayState.current = playState;
    const { id, positionMs: pos, durationMs } = nowRef.current;
    if (
      was === "playing" &&
      playState === "stopped" &&
      id != null &&
      durationMs > 0 &&
      pos >= durationMs - 2500
    ) {
      playNext(id);
    }
  }, [playState, playNext]);

  // ----- handlers -----------------------------------------------------------

  const handleSelectSource = async (next: SelectableSource) => {
    try {
      if (next === "library") {
        await ipc.stop();
        setEngineStat(null);
        setSource("library");
        return;
      }
      if (next === "radio") {
        // Browse panel; the engine stays idle until a station is played.
        await ipc.stop().catch(() => {});
        setEngineStat(null);
        setNow(null);
        setSource("radio");
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
    source !== "library" && source !== "radio" ? (source as LineInSource) : null;

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
              <button
                className="addurl-button"
                onClick={() => setAddUrlOpen(true)}
                title="Add a YouTube URL or mirror a Spotify playlist"
              >
                Add URL
              </button>
              {source === "library" && (
                <button
                  className="addurl-button enrich-all"
                  onClick={handleEnrichAll}
                  disabled={tracks.length === 0 || enrichProgress != null}
                  title="Auto-fill tags for the visible tracks (free MusicBrainz/fingerprint first, AI only if configured)"
                >
                  <Sparkles size={14} /> Enrich
                </button>
              )}
              <button className="import-button" onClick={handleImport} disabled={busy}>
                {busy ? "Importing…" : "Import Folder"}
              </button>
              <button
                className="addurl-button"
                onClick={handleImportMpx}
                disabled={busy}
                title="Import a MusicPax .mpx playlist"
              >
                Import .mpx
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
            onSelect={setView}
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
          <LibraryTable
            tracks={tracks}
            heading={view.kind === "playlist" ? view.name : undefined}
            searchable={view.kind === "all"}
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
          />
        </div>
      )}

      {stream && stream.sourceKind === "radio" && (
        <RadioPlayer
          track={stream}
          playing={streamPlaying}
          volume={volume}
          onPlayingChange={setStreamPlaying}
          onError={showStatus}
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
          onEnded={() => playNext(stream.id)}
          onClose={() => setStream(null)}
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
      />

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

      {addUrlOpen && (
        <AddUrlModal
          onClose={() => setAddUrlOpen(false)}
          onError={showStatus}
          onDone={(msg) => {
            showStatus(msg);
            refreshPlaylists();
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
