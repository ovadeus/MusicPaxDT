import { useEffect, useState } from "react";
import { ChevronDown, RadioTower, X } from "lucide-react";
import * as ipc from "../lib/ipc";
import type { BroadcastConfig, BroadcastStatus } from "../lib/ipc";

interface Props {
  onClose: () => void;
  onError: (message: string) => void;
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
export default function GoLivePanel({ onClose, onError }: Props) {
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

  const live = status.state !== "idle";
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
    <div className="settings-overlay" onClick={busy ? undefined : onClose}>
      <div className="settings-panel golive-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>
            <RadioTower size={18} /> Go Live
          </h2>
          <button className="settings-close" onClick={onClose} title="Close">
            <X size={15} />
          </button>
        </div>

        <div className={`golive-status golive-${status.state}`}>
          <span className="golive-dot" />
          <span className="golive-state">{STATE_LABEL[status.state]}</span>
          {status.state === "live" && (
            <span className="golive-elapsed">{formatElapsed(status.elapsedMs)}</span>
          )}
          {status.message && status.state !== "live" && (
            <span className="golive-msg">{status.message}</span>
          )}
        </div>

        {config && (
          <div className="golive-form">
            <div className="golive-row">
              <label className="golive-field golive-grow">
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
            </div>

            <div className="golive-row">
              <label className="golive-field golive-grow">
                <span>Mount point</span>
                <input
                  value={config.mount}
                  placeholder="/your-radio"
                  disabled={live}
                  onChange={(e) => set("mount", e.target.value)}
                />
              </label>
              <label className="golive-field golive-port">
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
            </div>

            <div className="golive-row">
              <label className="golive-field golive-port">
                <span>Username</span>
                <input
                  value={config.username}
                  placeholder="source"
                  disabled={live}
                  onChange={(e) => set("username", e.target.value)}
                />
              </label>
              <label className="golive-field golive-grow">
                <span>Source password</span>
                <input
                  type="password"
                  value={password}
                  placeholder={hasPassword ? "•••••••• (saved)" : "from Radio King → Live"}
                  disabled={live}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
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
              <>
                <label className="golive-field">
                  <span>Station name</span>
                  <input
                    value={config.name}
                    disabled={live}
                    onChange={(e) => set("name", e.target.value)}
                  />
                </label>
                <div className="golive-row">
                  <label className="golive-field golive-grow">
                    <span>Genre</span>
                    <input
                      value={config.genre}
                      disabled={live}
                      onChange={(e) => set("genre", e.target.value)}
                    />
                  </label>
                  <label className="golive-field golive-grow">
                    <span>Website</span>
                    <input
                      value={config.url}
                      disabled={live}
                      onChange={(e) => set("url", e.target.value)}
                    />
                  </label>
                </div>
                <label className="golive-check">
                  <input
                    type="checkbox"
                    checked={config.public}
                    disabled={live}
                    onChange={(e) => set("public", e.target.checked)}
                  />
                  List this stream in public Icecast directories
                </label>
              </>
            )}

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
        )}

        <p className="settings-hint">
          Find your host, port, mount and source password in your Radio King{" "}
          <strong>Live</strong> tab. MUSICPAX airs your <strong>output mix</strong> —
          library playback + line-in/aux — encoded to MP3. YouTube/internet-radio is
          never re-streamed. <br />
          <strong>RØDECaster tip:</strong> set the RØDECaster's program output as your
          aux/line-in source so its hardware mix (mic + music) is what goes out.
        </p>
      </div>
    </div>
  );
}
