import { useEffect, useRef, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import AudioMotionAnalyzer from "audiomotion-analyzer";
import * as ipc from "../lib/ipc";
import * as streamMeter from "../lib/streamMeter";
import type { AudioDevice } from "../lib/types";
import type { VizSettings } from "../lib/vizSettings";

// Sentinel select value for the no-install ScreenCaptureKit path.
const SCREEN = "__screen__";
// Names that look like a system-output loopback, used to pre-select a good
// default capture device.
const LOOPBACK_HINTS = [
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

interface Props {
  settings: VizSettings;
  /// True when the source's audio can't be analysed (YouTube's sandboxed embed).
  noAudio?: boolean;
  /// True when a system-audio loopback capture is feeding `audio-spectrum`
  /// (overrides noAudio — renders the spectrum instead of the notice).
  systemCapture?: boolean;
  /// Start system-audio capture from the YouTube notice. `device` is an audio
  /// input name to capture (permission-free loopback), or `null` for the
  /// no-install ScreenCaptureKit path.
  onSystemAudio?: (device: string | null) => void;
  /// Feedback from the capture attempt (setup guide / error), shown in-overlay.
  captureMsg?: string | null;
  /// Settings-board toggle (lives bottom-right so the header stays stable).
  boardOpen?: boolean;
  onToggleBoard?: () => void;
}

// Must match the engine's VIZ_BANDS / band layout (meters.rs).
const N_BANDS = 64;
function bandFreqs(): number[] {
  const lo = 30;
  const hi = 16000;
  return Array.from({ length: N_BANDS }, (_, i) =>
    lo * Math.pow(hi / lo, i / (N_BANDS - 1)),
  );
}

/// Push the user settings onto a live audioMotion instance.
function apply(am: AudioMotionAnalyzer, s: VizSettings) {
  am.mode = s.mode;
  am.gradient = s.gradient;
  am.radial = s.radial;
  am.radius = s.radius;
  am.spinSpeed = s.radial ? 1 : 0;
  am.reflexRatio = s.reflex && !s.radial ? 0.4 : 0;
  am.reflexAlpha = 0.3;
  am.mirror = s.mirror ? 1 : 0;
  am.ledBars = s.ledBars;
  am.lumiBars = s.lumiBars;
  am.roundBars = s.roundBars;
  am.outlineBars = s.outlineBars;
  am.showPeaks = s.showPeaks;
  am.linearAmplitude = true;
  am.linearBoost = s.linearBoost;
  am.frequencyScale = s.frequencyScale as "log" | "bark" | "mel" | "linear";
  am.barSpace = s.barSpace;
  am.smoothing = s.smoothing;
  am.fillAlpha = 0.5;
  am.lineWidth = 2;
  am.showScaleX = false;
  am.showScaleY = false;
  am.overlay = false;
  am.showBgColor = false;
}

/// Full-screen audio visualizer (audioMotion-analyzer).
/// - Stream audio (radio / direct, CORS-OK): tap streamMeter's real source.
/// - Engine / OWNED audio (not in the webview): the engine emits a *real*
///   per-band spectrum (`audio-spectrum`); we re-synthesize it with a bank of
///   oscillators so audioMotion shows the track's actual frequencies.
export default function Visualizer({
  settings,
  noAudio,
  systemCapture,
  onSystemAudio,
  captureMsg,
  boardOpen,
  onToggleBoard,
}: Props) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const amRef = useRef<AudioMotionAnalyzer | null>(null);
  const gainsRef = useRef<GainNode[] | null>(null);

  // Capture-source picker (only relevant on the YouTube "unavailable" notice):
  // list audio inputs so the user can pick a loopback device explicitly.
  const [captureDevices, setCaptureDevices] = useState<AudioDevice[]>([]);
  const [captureTarget, setCaptureTarget] = useState<string>(SCREEN);
  const showNotice = !!noAudio && !systemCapture;
  useEffect(() => {
    if (!showNotice) return;
    let alive = true;
    ipc
      .getAudioInputDevices()
      .then((ds) => {
        if (!alive) return;
        setCaptureDevices(ds);
        // Pre-select a loopback-looking device if present, else ScreenCaptureKit.
        const match = ds.find((d) => LOOPBACK_HINTS.some((h) => d.name.toLowerCase().includes(h)));
        setCaptureTarget(match ? match.name : SCREEN);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [showNotice]);

  useEffect(() => {
    const el = mountRef.current;
    // System capture overrides "noAudio" — it feeds audio-spectrum itself.
    if (!el || (noAudio && !systemCapture)) return;
    let am: AudioMotionAnalyzer;
    let unlisten: (() => void) | undefined;
    let tappedEngine = false;
    const ctx = streamMeter.getCtx();
    const src = streamMeter.getSource();
    try {
      if (streamMeter.isLive() && ctx && src) {
        // Real spectrum straight from the webview stream graph.
        am = new AudioMotionAnalyzer(el, { audioCtx: ctx, connectSpeakers: false });
        am.connectInput(src);
      } else {
        // Re-synthesize the engine's emitted spectrum into a bank of tones.
        am = new AudioMotionAnalyzer(el, { connectSpeakers: false });
        const actx = am.audioCtx;
        const master = actx.createGain();
        master.gain.value = 0.8;
        const freqs = bandFreqs();
        const gains: GainNode[] = [];
        for (let i = 0; i < N_BANDS; i++) {
          const osc = actx.createOscillator();
          osc.type = "sine";
          osc.frequency.value = freqs[i];
          const g = actx.createGain();
          g.gain.value = 0;
          osc.connect(g);
          g.connect(master);
          osc.start();
          gains.push(g);
        }
        am.connectInput(master);
        gainsRef.current = gains;

        // OWNED audio: turn on the engine output tap. System capture already
        // feeds audio-spectrum from its own loopback device, so skip the tap.
        if (!systemCapture) {
          tappedEngine = true;
          void ipc.setVisualizer(true).catch(() => {});
        }
        ipc
          .onAudioSpectrum((bands) => {
            const gs = gainsRef.current;
            if (!gs) return;
            const now = actx.currentTime;
            for (let i = 0; i < gs.length && i < bands.length; i++) {
              gs[i].gain.setTargetAtTime(bands[i], now, 0.04);
            }
          })
          .then((u) => (unlisten = u))
          .catch(() => {});
      }
    } catch {
      return;
    }
    amRef.current = am;
    // audioMotion's context starts suspended (autoplay policy) — resume it.
    void am.audioCtx.resume().catch(() => {});
    apply(am, settings);

    return () => {
      unlisten?.();
      if (tappedEngine) void ipc.setVisualizer(false).catch(() => {});
      try {
        gainsRef.current?.forEach((g) => g.disconnect());
      } catch {
        /* already gone */
      }
      gainsRef.current = null;
      try {
        am.destroy();
      } catch {
        /* already destroyed */
      }
      amRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live-apply settings changes from the board.
  useEffect(() => {
    if (amRef.current) apply(amRef.current, settings);
  }, [settings]);

  return (
    <div className="viz-overlay">
      <div className="viz-mount" ref={mountRef} />
      {noAudio && !systemCapture && (
        <div className="viz-unavailable">
          <p className="viz-unavailable-title">Visualizer unavailable for YouTube</p>
          <p className="viz-unavailable-sub">
            YouTube's audio plays in a sandboxed embed we can't read directly. Pick a
            capture source to visualize your system output instead.
          </p>
          <div className="viz-capture-row">
            <select
              className="viz-capture-select"
              value={captureTarget}
              onChange={(e) => setCaptureTarget(e.target.value)}
              title="Capture source"
            >
              <option value={SCREEN}>System audio — no install (Screen Recording)</option>
              {captureDevices.map((d) => (
                <option key={d.id} value={d.name}>
                  {d.name}
                </option>
              ))}
            </select>
            <button
              className="viz-sysaudio-btn"
              onClick={() => onSystemAudio?.(captureTarget === SCREEN ? null : captureTarget)}
            >
              Start capture
            </button>
          </div>
          <p className="viz-capture-tip">
            No loopback device? Route your output through BlackHole, Loopback, ARK, or a
            macOS Aggregate/Multi-Output device, then pick it here — no permission needed.
          </p>
          {captureMsg && <pre className="viz-capture-msg">{captureMsg}</pre>}
        </div>
      )}
      {systemCapture && <div className="viz-sysaudio-tag">Capturing system audio</div>}
      {onToggleBoard && (
        <button
          className={`viz-board-toggle${boardOpen ? " active" : ""}`}
          title="Visualizer settings"
          onClick={onToggleBoard}
        >
          <SlidersHorizontal size={18} />
        </button>
      )}
    </div>
  );
}
