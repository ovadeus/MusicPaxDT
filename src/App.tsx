import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import AddUrlModal from "./components/AddUrlModal";
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
  LineInSource,
  NowPlaying,
  PlaybackState,
  PlaylistInfo,
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
  const [formatLabel, setFormatLabel] = useState("");
  const [stream, setStream] = useState<Track | null>(null);

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
    ];
    return () => {
      subs.forEach((p) => p.then((un) => un()));
    };
  }, [showStatus, refreshPlaylists]);

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
        } else if (track.capability === "STREAM_PLAYABLE" && track.sourceKind === "youtube") {
          await ipc.stop().catch(() => {});
          setNow(null);
          setStream(track);
          setEngineStat(null);
          setSource("library");
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
      setStream(null);
      const stat = await ipc.startLineIn(next as LineInSource);
      setNow(null);
      setEngineStat(stat);
      setSource(next);
    } catch (e) {
      showStatus(`${e}`);
    }
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

  const lineIn = source !== "library" ? (source as LineInSource) : null;

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
          <button className="import-button" onClick={handleImport} disabled={busy}>
            {busy ? "Importing…" : "Import Folder"}
          </button>
          <button
            className="settings-button"
            onClick={() => setSettingsOpen(true)}
            title="Settings"
          >
            ⚙
          </button>
        </div>
      </header>

      {status && <div className="status-banner">{status}</div>}

      {lineIn ? (
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
            onSelect={setView}
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

      {stream && (
        <StreamPlayer
          track={stream}
          onEnded={() => playNext(stream.id)}
          onClose={() => setStream(null)}
        />
      )}

      <NowPlayingBar
        track={lineIn || stream ? null : (now?.track ?? null)}
        lineInLabel={
          lineIn
            ? `Line In — ${lineIn.charAt(0).toUpperCase()}${lineIn.slice(1)}`
            : stream
              ? `📡 ${stream.title ?? "Stream"}`
              : null
        }
        state={stream ? "playing" : playState}
        positionMs={stream ? 0 : positionMs}
        volume={volume}
        onPlay={() => ipc.play().catch((e) => showStatus(`${e}`))}
        onPause={() => ipc.pause().catch((e) => showStatus(`${e}`))}
        onStop={handleStop}
        onSeek={(ms) => ipc.seek(ms).catch((e) => showStatus(`${e}`))}
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
    </div>
  );
}
