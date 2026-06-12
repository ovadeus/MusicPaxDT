import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import LibraryTable from "./components/LibraryTable";
import Logo from "./components/Logo";
import NowPlayingBar from "./components/NowPlayingBar";
import ReceiverPanel from "./components/ReceiverPanel";
import SourceSelector, { type SelectableSource } from "./components/SourceSelector";
import * as ipc from "./lib/ipc";
import type {
  AudioDevice,
  EngineStatus,
  LineInSource,
  NowPlaying,
  PlaybackState,
  RecordingState,
  SortSpec,
  Track,
} from "./lib/types";
import "./styles/theme.css";

export default function App() {
  const [tracks, setTracks] = useState<Track[]>([]);
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

  const showStatus = useCallback((msg: string) => {
    setStatus(msg);
    window.setTimeout(() => setStatus((cur) => (cur === msg ? null : cur)), 6000);
  }, []);

  const refreshTracks = useCallback(async () => {
    try {
      setTracks(await ipc.listTracks({ query, sort }));
    } catch (e) {
      showStatus(`Failed to load library: ${e}`);
    }
  }, [query, sort, showStatus]);

  // Debounced search + sort refresh.
  const debounce = useRef<number | undefined>(undefined);
  useEffect(() => {
    window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(refreshTracks, 150);
    return () => window.clearTimeout(debounce.current);
  }, [refreshTracks]);

  // Devices + engine event subscriptions.
  useEffect(() => {
    ipc
      .getAudioDevices()
      .then(setDevices)
      .catch((e) => showStatus(`Audio devices unavailable: ${e}`));

    const subs = [
      ipc.onPosition(setPositionMs),
      ipc.onPlaybackState(setPlayState),
      ipc.onRecordingState(setRecState),
    ];
    return () => {
      subs.forEach((p) => p.then((un) => un()));
    };
  }, [showStatus]);

  const handleSelectSource = async (next: SelectableSource) => {
    try {
      if (next === "library") {
        await ipc.stop();
        setEngineStat(null);
        setSource("library");
        return;
      }
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

  const handleActivate = async (track: Track) => {
    try {
      await ipc.loadTrack(track.id);
      await ipc.play();
      setNow(await ipc.nowPlaying());
      setEngineStat(null);
      setSource("library");
      setPositionMs(0);
    } catch (e) {
      showStatus(`${e}`);
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
          <button className="import-button" onClick={handleImport} disabled={busy}>
            {busy ? "Importing…" : "Import Folder"}
          </button>
        </div>
      </header>

      {status && <div className="status-banner">{status}</div>}

      {lineIn ? (
        <ReceiverPanel
          source={lineIn}
          status={engineStat}
          recording={recState}
          onStatus={setEngineStat}
          onError={showStatus}
          onRecordingSaved={(title) => {
            showStatus(`Saved “${title}” to the library`);
            refreshTracks();
          }}
        />
      ) : (
        <LibraryTable
          tracks={tracks}
          query={query}
          onQueryChange={setQuery}
          sort={sort}
          onSortChange={setSort}
          onActivate={handleActivate}
          nowPlayingId={playState === "stopped" ? null : (now?.track.id ?? null)}
        />
      )}

      <NowPlayingBar
        track={lineIn ? null : (now?.track ?? null)}
        lineInLabel={
          lineIn
            ? `Line In — ${lineIn.charAt(0).toUpperCase()}${lineIn.slice(1)}`
            : null
        }
        state={playState}
        positionMs={positionMs}
        volume={volume}
        onPlay={() => ipc.play().catch((e) => showStatus(`${e}`))}
        onPause={() => ipc.pause().catch((e) => showStatus(`${e}`))}
        onStop={handleStop}
        onSeek={(ms) => ipc.seek(ms).catch((e) => showStatus(`${e}`))}
        onVolume={handleVolume}
      />
    </div>
  );
}
