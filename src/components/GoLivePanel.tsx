import { useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  FolderOpen,
  Mic,
  MicOff,
  RadioTower,
  RefreshCw,
} from "lucide-react";
import * as ipc from "../lib/ipc";
import type { BroadcastConfig, BroadcastStatus, MicConfig, MicMode, MicStatus } from "../lib/ipc";
import type { AudioDevice } from "../lib/types";

/// Mic meter: peak → dBFS → 0..100 over a 60 dB range.
function levelPercent(level: number): number {
  if (level <= 0) return 0;
  const db = 20 * Math.log10(level);
  return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
}

function fmtDb(db: number): string {
  return `${db > 0 ? "+" : ""}${db} dB`;
}

interface Props {
  onClose: () => void;
  onError: (message: string) => void;
  /// The Live Media folder — the only tracks that can go on air. Null until chosen.
  liveDir: string | null;
  liveCount: number;
  /// True while a folder scan is running (disables the folder buttons).
  busyMedia?: boolean;
  onSelectFolder: () => void;
  onRescan: () => void;
}

const BITRATES = [128, 192, 256, 320];

const STATE_LABEL: Record<BroadcastStatus["state"], string> = {
  idle: "Offline",
  connecting: "Connecting…",
  live: "ON AIR",
  reconnecting: "Reconnecting…",
  error: "Error",
};

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}

/// "Go Live" — broadcast the MUSICPAX output mix to a Radio King / Icecast
/// station. Connection details come from the user's Radio King → Live tab.
///
/// An inline accordion under the header rather than a modal: this is a form
/// you edit *while* on air, and a click-outside-to-dismiss overlay threw the
/// settings away mid-broadcast. Nothing here closes except the collapse
/// button, and collapsing never stops the stream.
export default function GoLivePanel({
  onClose,
  onError,
  liveDir,
  liveCount,
  busyMedia,
  onSelectFolder,
  onRescan,
}: Props) {
  const [config, setConfig] = useState<BroadcastConfig | null>(null);
  const [password, setPassword] = useState("");
  const [hasPassword, setHasPassword] = useState(false);
  const [status, setStatus] = useState<BroadcastStatus>({
    state: "idle",
    elapsedMs: 0,
    sentBytes: 0,
    bitrate: 128,
    message: "",
  });
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);

  // ----- talk-over mic -----------------------------------------------------
  const [micCfg, setMicCfg] = useState<MicConfig | null>(null);
  const [micStat, setMicStat] = useState<MicStatus | null>(null);
  const [inputs, setInputs] = useState<AudioDevice[]>([]);
  const [micBusy, setMicBusy] = useState(false);
  const micOn = micStat?.on ?? false;
  const ptt = (micCfg?.mode ?? "ptt") === "ptt";

  useEffect(() => {
    ipc.getMicConfig().then(setMicCfg).catch((e) => onError(`${e}`));
    ipc.micStatus().then(setMicStat).catch(() => {});
    ipc.getAudioInputDevices().then(setInputs).catch(() => {});
  }, [onError]);

  // While the mic runs, poll for the meter and the "talking" state. 10 Hz is
  // plenty for a level bar and costs nothing (a few atomics).
  useEffect(() => {
    if (!micOn) return;
    const id = window.setInterval(() => {
      ipc.micStatus().then(setMicStat).catch(() => {});
    }, 100);
    return () => window.clearInterval(id);
  }, [micOn]);

  // Push-to-talk on the keyboard: hold Option (⌥). A modifier can't type into
  // a field, so it never fights with editing, and it's easy to hold.
  useEffect(() => {
    if (!micOn || !ptt) return;
    const down = (e: KeyboardEvent) => {
      if (e.key === "Alt" && !e.repeat) void ipc.micHold(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "Alt") void ipc.micHold(false);
    };
    const release = () => void ipc.micHold(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
      release();
    };
  }, [micOn, ptt]);

  const updateMic = (patch: Partial<MicConfig>) => {
    if (!micCfg) return;
    const next = { ...micCfg, ...patch };
    setMicCfg(next);
    ipc.setMic(next).catch((e) => onError(`${e}`));
  };

  const toggleMic = async () => {
    if (!micCfg) return;
    setMicBusy(true);
    try {
      setMicStat(micOn ? await ipc.micStop() : await ipc.micStart(micCfg.device));
    } catch (e) {
      onError(`${e}`);
    } finally {
      setMicBusy(false);
    }
  };

  useEffect(() => {
    ipc
      .getBroadcastConfig()
      .then((s) => {
        const { hasPassword: hp, ...cfg } = s;
        setConfig(cfg);
        setHasPassword(hp);
      })
      .catch((e) => onError(`${e}`));
    ipc.goLiveStatus().then(setStatus).catch(() => {});
    let unlisten: (() => void) | undefined;
    let disposed = false;
    ipc.onBroadcastState(setStatus).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [onError]);

  // Fields lock only while a connection is actually being kept up. An error
  // is exactly when they need editing — locking them there left the user
  // staring at "check your source password" with no way to check it.
  const live = status.state !== "idle" && status.state !== "error";
  const set = <K extends keyof BroadcastConfig>(key: K, value: BroadcastConfig[K]) =>
    setConfig((c) => (c ? { ...c, [key]: value } : c));

  const start = async () => {
    if (!config) return;
    if (!config.host.trim()) {
      onError("Enter your Radio King server host (from the Live tab).");
      return;
    }
    if (!hasPassword && !password.trim()) {
      onError("Enter your source password (from the Radio King Live tab).");
      return;
    }
    const mount = config.mount.trim()
      ? config.mount.startsWith("/")
        ? config.mount
        : `/${config.mount}`
      : "";
    const ok = window.confirm(
      `Go live to ${config.host}:${config.port}${mount}?\n\n` +
        "This broadcasts your MUSICPAX output mix (library playback + line-in/aux). " +
        "YouTube and internet radio are never aired.",
    );
    if (!ok) return;
    setBusy(true);
    try {
      if (password.trim()) {
        await ipc.setBroadcastPassword(password.trim());
        setHasPassword(true);
        setPassword("");
      }
      setStatus(await ipc.goLiveStart(config));
    } catch (e) {
      onError(`${e}`);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      setStatus(await ipc.goLiveStop());
    } catch (e) {
      onError(`${e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`golive-bar golive-${status.state}`}>
      <div className="golive-bar-head">
        <h2>
          <RadioTower size={16} /> Go Live
        </h2>
        <div className="golive-status">
          <span className="golive-dot" />
          <span className="golive-state">{STATE_LABEL[status.state]}</span>
          {status.state === "live" && (
            <span className="golive-elapsed">{formatElapsed(status.elapsedMs)}</span>
          )}
          {status.message && status.state !== "live" && (
            <span className="golive-msg">{status.message}</span>
          )}
        </div>
        <button className="golive-collapse" onClick={onClose} title="Collapse">
          <ChevronUp size={16} />
        </button>
      </div>

      {config && (
        <div className="golive-form">
          <div className="golive-grid">
            <label className="golive-field golive-host">
              <span>Server host</span>
              <input
                value={config.host}
                placeholder="e.g. live.radioking.com"
                disabled={live}
                onChange={(e) => set("host", e.target.value)}
              />
            </label>
            <label className="golive-field golive-port">
              <span>Port</span>
              <input
                type="number"
                value={config.port}
                disabled={live}
                onChange={(e) => set("port", Number(e.target.value) || 0)}
              />
            </label>
            <label className="golive-field golive-mount">
              <span>Mount point</span>
              <input
                value={config.mount}
                placeholder="/your-radio"
                disabled={live}
                onChange={(e) => set("mount", e.target.value)}
              />
            </label>
            <label className="golive-field golive-bitrate">
              <span>Bitrate</span>
              <select
                value={config.bitrate}
                disabled={live}
                onChange={(e) => set("bitrate", Number(e.target.value))}
              >
                {BITRATES.map((b) => (
                  <option key={b} value={b}>
                    {b} kbps
                  </option>
                ))}
              </select>
            </label>
            <label className="golive-field golive-user">
              <span>Username</span>
              <input
                value={config.username}
                placeholder="source"
                disabled={live}
                onChange={(e) => set("username", e.target.value)}
              />
            </label>
            <label className="golive-field golive-pass">
              <span>Source password</span>
              <input
                type="password"
                value={password}
                placeholder={hasPassword ? "•••••••• (saved)" : "from Radio King → Live"}
                disabled={live}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>

            {/* Sits in the same row as the inputs, aligned to their baseline. */}
            <div className="golive-actions">
              {live ? (
                <button className="golive-btn stop" onClick={stop} disabled={busy}>
                  ■ Stop broadcast
                </button>
              ) : (
                <button className="golive-btn go" onClick={start} disabled={busy}>
                  <RadioTower size={15} /> Go Live
                </button>
              )}
            </div>
          </div>

          {/* The on-air folder. Deliberately a hard line, not a per-track
              judgement: what's under this folder can air, nothing else can. */}
          <div className="golive-media">
            <div className="golive-media-row">
              <FolderOpen size={15} />
              <span className="golive-media-label">Live Media folder</span>
              {liveDir ? (
                <span className="golive-media-path" title={liveDir}>
                  {liveDir}
                </span>
              ) : (
                <span className="golive-media-path empty">No folder selected</span>
              )}
              {liveDir && (
                <span className="golive-media-count">
                  {liveCount} {liveCount === 1 ? "track" : "tracks"}
                </span>
              )}
              <button className="golive-media-btn" onClick={onSelectFolder} disabled={busyMedia}>
                {liveDir ? "Change folder…" : "Select folder…"}
              </button>
              {liveDir && (
                <button
                  className="golive-media-btn"
                  onClick={onRescan}
                  disabled={busyMedia}
                  title="Pick up files added since the last scan"
                >
                  <RefreshCw size={13} /> Rescan
                </button>
              )}
            </div>
            <p className="golive-media-note">
              <strong>Live Media</strong> airs only files on this computer — tracks you own
              or are licensed to broadcast. Playlists built from YouTube and other streaming
              sources can't go on air: their terms don't allow re-broadcasting.
            </p>
          </div>

          {/* Talk-over mic: mixed over the music for the broadcast, with the
              music ducked while the DJ talks. */}
          <div className={`golive-mic${micOn ? " on" : ""}`}>
            <div className="golive-mic-row">
              <button
                className={`golive-mic-toggle${micOn ? " on" : ""}`}
                onClick={toggleMic}
                disabled={micBusy || !micCfg}
                title={micOn ? "Turn the mic off" : "Turn the mic on"}
              >
                {micOn ? <Mic size={15} /> : <MicOff size={15} />}
                {micOn ? "Mic on" : "Mic off"}
              </button>
              <select
                className="golive-mic-select"
                value={micCfg?.device ?? ""}
                disabled={micOn}
                title={micOn ? "Turn the mic off to change the input" : "Mic input"}
                onChange={(e) => updateMic({ device: e.target.value || null })}
              >
                <option value="">Default input</option>
                {inputs.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
              <select
                className="golive-mic-select"
                value={micCfg?.mode ?? "ptt"}
                onChange={(e) => updateMic({ mode: e.target.value as MicMode })}
              >
                <option value="ptt">Push to talk — hold ⌥</option>
                <option value="open">Open mic</option>
              </select>
              {micOn && ptt && (
                <button
                  className={`golive-ptt${micStat?.open ? " held" : ""}`}
                  onMouseDown={() => void ipc.micHold(true)}
                  onMouseUp={() => void ipc.micHold(false)}
                  onMouseLeave={() => void ipc.micHold(false)}
                  title="Hold to talk (or hold the ⌥ key)"
                >
                  Hold to talk
                </button>
              )}
              <div className="golive-mic-meter" title="Mic level">
                <div
                  className="golive-mic-meter-fill"
                  style={{ width: `${micOn ? levelPercent(micStat?.level ?? 0) : 0}%` }}
                />
              </div>
              {micOn && micStat?.talking && <span className="golive-mic-live">ON MIC</span>}
            </div>
            <div className="golive-mic-row golive-mic-params">
              <label className="golive-mic-param">
                <span>Mic gain</span>
                <input
                  type="range"
                  min={-20}
                  max={20}
                  step={1}
                  value={micCfg?.gainDb ?? 0}
                  onChange={(e) => updateMic({ gainDb: Number(e.target.value) })}
                />
                <em>{fmtDb(micCfg?.gainDb ?? 0)}</em>
              </label>
              <label className="golive-mic-param">
                <span>Duck music</span>
                <input
                  type="range"
                  min={-30}
                  max={0}
                  step={1}
                  value={micCfg?.duckDb ?? -12}
                  onChange={(e) => updateMic({ duckDb: Number(e.target.value) })}
                />
                <em>{fmtDb(micCfg?.duckDb ?? -12)}</em>
              </label>
              <label className="golive-check golive-mic-monitor">
                <input
                  type="checkbox"
                  checked={micCfg?.monitor ?? false}
                  onChange={(e) => updateMic({ monitor: e.target.checked })}
                />
                Hear mic in speakers
              </label>
            </div>
            <p className="golive-media-note">
              Your mic is mixed over the music for the broadcast; while you talk the
              music ducks by the amount above and comes back when you stop. Using a
              RØDECaster or other desk? Pick it as the input and leave “hear mic in
              speakers” off — you're already monitoring through it.
            </p>
          </div>

          <button
            className="golive-advanced-toggle"
            onClick={() => setAdvanced((v) => !v)}
          >
            <ChevronDown
              size={14}
              style={{ transform: advanced ? "rotate(180deg)" : "none" }}
            />
            Station details (optional)
          </button>
          {advanced && (
            <div className="golive-grid golive-advanced">
              <label className="golive-field golive-host">
                <span>Station name</span>
                <input
                  value={config.name}
                  disabled={live}
                  onChange={(e) => set("name", e.target.value)}
                />
              </label>
              <label className="golive-field golive-mount">
                <span>Genre</span>
                <input
                  value={config.genre}
                  disabled={live}
                  onChange={(e) => set("genre", e.target.value)}
                />
              </label>
              <label className="golive-field golive-mount">
                <span>Website</span>
                <input
                  value={config.url}
                  disabled={live}
                  onChange={(e) => set("url", e.target.value)}
                />
              </label>
              <label className="golive-check">
                <input
                  type="checkbox"
                  checked={config.public}
                  disabled={live}
                  onChange={(e) => set("public", e.target.checked)}
                />
                List this stream in public Icecast directories
              </label>
            </div>
          )}

          <p className="golive-hint">
            Find your host, port, mount and source password in your Radio King{" "}
            <strong>Live</strong> tab. MUSICPAX airs your <strong>output mix</strong> —
            Live Media playback + line-in/aux — encoded to MP3.{" "}
            <strong>RØDECaster tip:</strong> set the RØDECaster's program output as your
            aux/line-in source so its hardware mix (mic + music) is what goes out.
          </p>
        </div>
      )}
    </section>
  );
}
