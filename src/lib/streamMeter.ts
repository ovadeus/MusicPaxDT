// Real VU metering for the radio lane. An internet-radio <audio> element is
// same-origin to us, so we CAN tap it with the Web Audio API — but only if the
// stream server sends CORS headers. Without them, createMediaElementSource()
// reroutes the audio into the graph as silence (a browser privacy rule), which
// would mute the station. So we probe CORS first and only wire up the graph
// when it's safe; callers fall back to a synthesized meter otherwise.
//
// YouTube can't use this at all — its audio lives inside a cross-origin
// sandboxed iframe the Web Audio API cannot reach.

import type { VuLevels } from "./types";

let ctx: AudioContext | null = null;
let source: MediaElementAudioSourceNode | null = null;
let splitter: ChannelSplitterNode | null = null;
let analyserL: AnalyserNode | null = null;
let analyserR: AnalyserNode | null = null;
let bufL: Float32Array | null = null;
let bufR: Float32Array | null = null;

/// Does this stream allow cross-origin reads? A plain CORS GET that resolves
/// (rather than throwing) means the server sent Access-Control-Allow-Origin, so
/// the Web Audio graph will receive real samples instead of silence. We abort
/// the moment headers arrive so we never pull the (endless) stream body.
export async function corsAllowed(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 4000);
  try {
    await fetch(url, { method: "GET", mode: "cors", signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timeout);
    controller.abort();
  }
}

/// Wire a (CORS-cleared, crossOrigin="anonymous") audio element into a stereo
/// analyser graph. Call only after corsAllowed() returned true and BEFORE the
/// element starts loading its source, so crossOrigin takes effect. The element
/// must be freshly mounted: createMediaElementSource can run once per element.
export function connect(el: HTMLAudioElement): boolean {
  disconnect();
  try {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    source = ctx.createMediaElementSource(el);
    splitter = ctx.createChannelSplitter(2);
    analyserL = ctx.createAnalyser();
    analyserR = ctx.createAnalyser();
    analyserL.fftSize = 1024;
    analyserR.fftSize = 1024;
    analyserL.smoothingTimeConstant = 0;
    analyserR.smoothingTimeConstant = 0;
    source.connect(splitter);
    splitter.connect(analyserL, 0);
    splitter.connect(analyserR, 1);
    source.connect(ctx.destination); // keep the audio audible
    bufL = new Float32Array(analyserL.fftSize);
    bufR = new Float32Array(analyserR.fftSize);
    return true;
  } catch {
    disconnect();
    return false;
  }
}

export function disconnect(): void {
  try {
    source?.disconnect();
    splitter?.disconnect();
    analyserL?.disconnect();
    analyserR?.disconnect();
  } catch {
    /* nodes may already be torn down with the element */
  }
  source = null;
  splitter = null;
  analyserL = null;
  analyserR = null;
  bufL = null;
  bufR = null;
}

function rms(buf: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

function peak(buf: Float32Array): number {
  let p = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > p) p = a;
  }
  return p;
}

/// Current real stereo levels, or null when no live graph is connected (the
/// caller should then fall back to the synthesized meter).
export function getLevels(): VuLevels | null {
  if (!analyserL || !analyserR || !bufL || !bufR) return null;
  analyserL.getFloatTimeDomainData(bufL);
  analyserR.getFloatTimeDomainData(bufR);
  return { rmsL: rms(bufL), peakL: peak(bufL), rmsR: rms(bufR), peakR: peak(bufR) };
}

export function isLive(): boolean {
  return analyserL != null;
}
