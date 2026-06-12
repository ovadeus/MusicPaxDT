import { useEffect, useRef } from "react";
import { onVuLevels } from "../lib/ipc";

const WIDTH = 180;
const HEIGHT = 44;
const BAR_H = 14;
const DECAY_PER_FRAME = 0.92; // smooth fall-back
const PEAK_HOLD_FRAMES = 30;

interface Channel {
  rms: number;
  peak: number;
  peakHold: number;
  holdFrames: number;
}

// Map linear amplitude to meter travel; sqrt gives a useful visual range
// without going full dB math.
function travel(v: number): number {
  return Math.min(1, Math.sqrt(Math.max(0, v)));
}

export default function VuMeter() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const channels = useRef<[Channel, Channel]>([
    { rms: 0, peak: 0, peakHold: 0, holdFrames: 0 },
    { rms: 0, peak: 0, peakHold: 0, holdFrames: 0 },
  ]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let raf = 0;
    let disposed = false;

    onVuLevels((levels) => {
      const [l, r] = channels.current;
      l.rms = Math.max(l.rms, levels.rmsL);
      l.peak = Math.max(l.peak, levels.peakL);
      r.rms = Math.max(r.rms, levels.rmsR);
      r.peak = Math.max(r.peak, levels.peakR);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    const draw = () => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (canvas && ctx) {
        ctx.clearRect(0, 0, WIDTH, HEIGHT);
        channels.current.forEach((ch, i) => {
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
      title="Output level (peak / RMS)"
    />
  );
}
