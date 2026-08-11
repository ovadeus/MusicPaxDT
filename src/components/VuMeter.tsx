import { useEffect, useRef } from "react";
import { onVuLevels } from "../lib/ipc";
import * as streamMeter from "../lib/streamMeter";

const WIDTH = 180;
const HEIGHT = 44;
const BAR_H = 14;
const DECAY_PER_FRAME = 0.92; // smooth fall-back
const PEAK_HOLD_FRAMES = 30;

interface Props {
  /// Stream lanes can't always be metered for real. Radio is tapped via Web
  /// Audio when the server allows CORS (real levels); YouTube is sandboxed and
  /// has no signal at all. When no real levels are available and `synthetic`
  /// is set, we animate a plausible level instead.
  synthetic?: boolean;
  /// Whether sound is currently playing (drives the synthetic animation).
  active?: boolean;
}

interface Channel {
  rms: number;
  peak: number;
  peakHold: number;
  holdFrames: number;
}

interface Synth {
  value: number;
  target: number;
}

// Map linear amplitude to meter travel; sqrt gives a useful visual range
// without going full dB math.
function travel(v: number): number {
  return Math.min(1, Math.sqrt(Math.max(0, v)));
}

export default function VuMeter({ synthetic = false, active = false }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const channels = useRef<[Channel, Channel]>([
    { rms: 0, peak: 0, peakHold: 0, holdFrames: 0 },
    { rms: 0, peak: 0, peakHold: 0, holdFrames: 0 },
  ]);
  const synth = useRef<[Synth, Synth]>([
    { value: 0, target: 0 },
    { value: 0, target: 0 },
  ]);
  // Keep the latest mode flags visible to the rAF loop without re-binding it.
  const modeRef = useRef({ synthetic, active });
  modeRef.current = { synthetic, active };
  // Kick the (self-idling) animation loop from outside the mount effect.
  const ensureRef = useRef<() => void>(() => {});

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let raf = 0;
    let running = false;
    let disposed = false;

    // Nothing left to animate: all bars decayed and no peak-hold showing.
    const EPS = 0.003;
    const atRest = () =>
      channels.current.every(
        (c) => c.rms < EPS && c.peak < EPS && c.peakHold < EPS && c.holdFrames === 0,
      );

    // (Re)start the loop only if it isn't already running — the loop idles
    // itself when there's no signal, so this is how it wakes back up.
    const ensure = () => {
      if (running || disposed) return;
      running = true;
      raf = requestAnimationFrame(draw);
    };
    ensureRef.current = ensure;

    onVuLevels((levels) => {
      if (modeRef.current.synthetic) return; // streams use the synth, not engine events
      const [l, r] = channels.current;
      l.rms = Math.max(l.rms, levels.rmsL);
      l.peak = Math.max(l.peak, levels.peakL);
      r.rms = Math.max(r.rms, levels.rmsR);
      r.peak = Math.max(r.peak, levels.peakR);
      ensure(); // engine sent signal → make sure we're animating
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    // A plausible, musical-looking level: a slowly-drifting energy floor with
    // periodic beat-like swells and light per-frame jitter. Used only when no
    // real signal is available (YouTube, or radio without CORS).
    const feedSynth = (i: number) => {
      const s = synth.current[i];
      if (Math.random() < 0.05) s.target = 0.35 + Math.random() * 0.5;
      // Occasional accent "hit" to read like a beat.
      if (Math.random() < 0.04) s.target = Math.min(1, s.target + 0.3);
      s.value += (s.target - s.value) * 0.3;
      const v = Math.max(0, Math.min(1, s.value + (Math.random() - 0.5) * 0.1));
      const ch = channels.current[i];
      ch.peak = Math.max(ch.peak, v);
      ch.rms = Math.max(ch.rms, v * 0.72);
    };

    // Real radio levels when the Web Audio tap is live (CORS-cleared stream).
    const feedLive = (levels: ReturnType<typeof streamMeter.getLevels>) => {
      if (!levels) return;
      const [l, r] = channels.current;
      l.rms = Math.max(l.rms, levels.rmsL);
      l.peak = Math.max(l.peak, levels.peakL);
      r.rms = Math.max(r.rms, levels.rmsR);
      r.peak = Math.max(r.peak, levels.peakR);
    };

    const draw = () => {
      const { synthetic: syn, active: act } = modeRef.current;
      const live = streamMeter.getLevels();
      if (live) feedLive(live);
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (canvas && ctx) {
        ctx.clearRect(0, 0, WIDTH, HEIGHT);
        channels.current.forEach((ch, i) => {
          if (!live && syn && act) feedSynth(i);
          const y = i === 0 ? 4 : HEIGHT - BAR_H - 4;
          drawBar(ctx, y, ch);
          ch.rms *= DECAY_PER_FRAME;
          ch.peak *= DECAY_PER_FRAME;
          if (ch.peak > ch.peakHold) {
            ch.peakHold = ch.peak;
            ch.holdFrames = PEAK_HOLD_FRAMES;
          } else if (ch.holdFrames > 0) {
            ch.holdFrames -= 1;
          } else {
            ch.peakHold *= DECAY_PER_FRAME;
          }
        });
      }
      // Keep animating only while there's live/synthetic signal or residual
      // energy to decay; otherwise idle (this is the fix for the 60fps
      // always-on canvas that pegged the webview CPU when nothing was playing).
      if (act || live != null || !atRest()) {
        raf = requestAnimationFrame(draw);
      } else {
        running = false;
      }
    };
    ensure();

    return () => {
      disposed = true;
      running = false;
      cancelAnimationFrame(raf);
      unlisten?.();
    };
  }, []);

  // Synthetic lanes (YouTube / non-CORS radio) have no engine events, so wake
  // the loop when they start playing.
  useEffect(() => {
    if (active) ensureRef.current();
  }, [active]);

  const drawBar = (ctx: CanvasRenderingContext2D, y: number, ch: Channel) => {
    // background track
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.fillRect(0, y, WIDTH, BAR_H);

    // segmented fill: green → yellow → red
    const segments = 24;
    const segW = WIDTH / segments;
    const rmsSegs = Math.round(travel(ch.rms) * segments);
    const peakSegs = Math.round(travel(ch.peak) * segments);
    for (let s = 0; s < segments; s++) {
      const ratio = s / segments;
      const lit = s < rmsSegs ? 1 : s < peakSegs ? 0.45 : 0;
      if (lit === 0) continue;
      const color =
        ratio < 0.65
          ? `rgba(80, 220, 100, ${lit})`
          : ratio < 0.85
            ? `rgba(235, 200, 60, ${lit})`
            : `rgba(240, 80, 70, ${lit})`;
      ctx.fillStyle = color;
      ctx.fillRect(s * segW + 1, y + 1, segW - 2, BAR_H - 2);
    }

    // peak-hold marker
    const holdX = travel(ch.peakHold) * WIDTH;
    if (holdX > 2) {
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillRect(Math.min(holdX, WIDTH - 2), y + 1, 2, BAR_H - 2);
    }
  };

  return (
    <canvas
      ref={canvasRef}
      className="vu-meter"
      width={WIDTH}
      height={HEIGHT}
      title="Output level"
    />
  );
}
