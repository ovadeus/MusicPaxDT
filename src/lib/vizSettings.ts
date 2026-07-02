/// User-tunable settings for the audioMotion-analyzer visualizer, persisted so
/// the look survives restarts. The settings board edits these live.

export interface VizSettings {
  mode: number; // audioMotion mode (10 = area graph, 1/2/4/8 = octave bands)
  gradient: string;
  radial: boolean;
  reflex: boolean;
  mirror: boolean;
  ledBars: boolean;
  lumiBars: boolean;
  roundBars: boolean;
  outlineBars: boolean;
  showPeaks: boolean;
  linearBoost: number; // sensitivity (1 = off … 3)
  radius: number; // radial size: inner-radius fraction (bigger = larger ring)
  frequencyScale: string; // "log" | "bark" | "mel" | "linear"
  barSpace: number; // gap between bars (0 = solid … 0.9)
  smoothing: number; // temporal smoothing (0 = snappy … 0.95 = fluid)
}

export const VIZ_MODES: { value: number; label: string }[] = [
  { value: 10, label: "Area graph (fluid)" },
  { value: 2, label: "Fine bars" },
  { value: 4, label: "Bars" },
  { value: 8, label: "Octave bars" },
  { value: 1, label: "Full resolution" },
];

export const VIZ_GRADIENTS = ["prism", "rainbow", "classic", "orangered", "steelblue"];

export const VIZ_FREQ_SCALES = ["log", "bark", "mel", "linear"];

/// One-click looks that set a bundle of options at once.
export const VIZ_PRESETS: { label: string; patch: Partial<VizSettings> }[] = [
  {
    label: "Fluid",
    patch: { mode: 10, radial: false, reflex: true, mirror: false, gradient: "prism", roundBars: false },
  },
  {
    label: "Radial bloom",
    patch: { mode: 4, radial: true, reflex: false, gradient: "prism", roundBars: true, radius: 0.6 },
  },
  {
    label: "LED bars",
    patch: { mode: 4, radial: false, reflex: true, ledBars: true, roundBars: false, gradient: "classic" },
  },
  {
    label: "Mirror wave",
    patch: { mode: 2, radial: false, reflex: true, mirror: true, roundBars: false, gradient: "rainbow" },
  },
];

export const DEFAULT_VIZ: VizSettings = {
  mode: 10,
  gradient: "prism",
  radial: false,
  reflex: true,
  mirror: false,
  ledBars: false,
  lumiBars: false,
  roundBars: true,
  outlineBars: false,
  showPeaks: false,
  linearBoost: 2.2,
  radius: 0.6,
  frequencyScale: "log",
  barSpace: 0.1,
  smoothing: 0.7,
};

const KEY = "viz.settings";

export function loadViz(): VizSettings {
  try {
    return { ...DEFAULT_VIZ, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    return { ...DEFAULT_VIZ };
  }
}

export function saveViz(s: VizSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
