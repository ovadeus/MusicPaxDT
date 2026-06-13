import { useEffect, useRef } from "react";
import { onVuLevels } from "../lib/ipc";

const WIDTH = 180;
const HEIGHT = 44;
const BAR_H = 14;
const DECAY_PER_FRAME = 0.92; // smooth fall-back
const PEAK_HOLD_FRAMES = 30;

interface Props {
  /// Stream lanes (YouTube/radio) can't be metered for real — their audio is
  /// sandboxed — so animate a synthesized level while they play.
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

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let raf = 0;
    let disposed = false;

    onVuLevels((levels) => {
      if (modeRef.current.synthetic) return; // streams use the synth, not engine events
      const [l, r] = channels.current;
      l.rms = Math.max(l.rms, levels.rmsL);
      l.peak = Math.max(l.peak, levels.peakL);
      r.rms = Math.max(r.rms, levels.rmsR);
      r.peak = Math.max(r.peak, levels.peakR);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    // A plausible, musical-looking level: each channel wanders toward a new
    // random target now and then, with light per-frame jitter.
    const feedSynth = (i: number) => {
      const s = synth.current[i];
      if (Math.random() < 0.09) s.target = 0.4 + Math.random() * 0.55;
      s.value += (s.target - s.value) * 0.28;
      const v = Math.max(0, Math.min(1, s.value + (Math.random() - 0.5) * 0.12));
      const ch = channels.current[i];
      ch.peak = Math.max(ch.peak, v);
      ch.rms = Math.max(ch.rms, v * 0.72);
    };

    const draw = () => {
      const { synthetic: syn, active: act } = modeRef.current;
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (canvas && ctx) {
        ctx.clearRect(0, 0, WIDTH, HEIGHT);
        channels.current.forEach((ch, i) => {
          if (syn && act) feedSynth(i);
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
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      unlisten?.();
    };
  }, []);

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
