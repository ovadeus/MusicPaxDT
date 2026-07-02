import { X } from "lucide-react";
import {
  VIZ_FREQ_SCALES,
  VIZ_GRADIENTS,
  VIZ_MODES,
  VIZ_PRESETS,
  type VizSettings,
} from "../lib/vizSettings";

interface Props {
  settings: VizSettings;
  onChange: (patch: Partial<VizSettings>) => void;
  onClose: () => void;
}

const TOGGLES: { key: keyof VizSettings; label: string }[] = [
  { key: "radial", label: "Radial" },
  { key: "reflex", label: "Reflect" },
  { key: "mirror", label: "Mirror" },
  { key: "ledBars", label: "LED" },
  { key: "lumiBars", label: "Lumi" },
  { key: "roundBars", label: "Round" },
  { key: "outlineBars", label: "Outline" },
  { key: "showPeaks", label: "Peaks" },
];

/// Compact, MusicPax-styled live control board for the visualizer (a simplified
/// take on the audioMotion demo controls).
export default function VizSettingsBoard({ settings, onChange, onClose }: Props) {
  return (
    <div className="viz-board">
      <div className="viz-board-head">
        <span>Visualizer</span>
        <button className="viz-board-close" onClick={onClose} title="Close">
          <X size={14} />
        </button>
      </div>

      <div className="viz-presets">
        {VIZ_PRESETS.map((p) => (
          <button key={p.label} className="viz-preset" onClick={() => onChange(p.patch)}>
            {p.label}
          </button>
        ))}
      </div>

      <label className="viz-field">
        <span>Style</span>
        <select value={settings.mode} onChange={(e) => onChange({ mode: Number(e.target.value) })}>
          {VIZ_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </label>

      <label className="viz-field">
        <span>Colors</span>
        <select value={settings.gradient} onChange={(e) => onChange({ gradient: e.target.value })}>
          {VIZ_GRADIENTS.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
      </label>

      <label className="viz-field">
        <span>Sensitivity</span>
        <input
          type="range"
          min={1}
          max={3}
          step={0.1}
          value={settings.linearBoost}
          onChange={(e) => onChange({ linearBoost: Number(e.target.value) })}
        />
      </label>

      {settings.radial && (
        <label className="viz-field">
          <span>Size</span>
          <input
            type="range"
            min={0.2}
            max={0.85}
            step={0.05}
            value={settings.radius}
            onChange={(e) => onChange({ radius: Number(e.target.value) })}
          />
        </label>
      )}

      <label className="viz-field">
        <span>Frequencies</span>
        <select
          value={settings.frequencyScale}
          onChange={(e) => onChange({ frequencyScale: e.target.value })}
        >
          {VIZ_FREQ_SCALES.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </label>

      <label className="viz-field">
        <span>Smoothing</span>
        <input
          type="range"
          min={0}
          max={0.95}
          step={0.05}
          value={settings.smoothing}
          onChange={(e) => onChange({ smoothing: Number(e.target.value) })}
        />
      </label>

      <label className="viz-field">
        <span>Bar gap</span>
        <input
          type="range"
          min={0}
          max={0.6}
          step={0.05}
          value={settings.barSpace}
          onChange={(e) => onChange({ barSpace: Number(e.target.value) })}
        />
      </label>

      <div className="viz-toggles">
        {TOGGLES.map((t) => (
          <button
            key={t.key}
            className={`viz-toggle${settings[t.key] ? " active" : ""}`}
            onClick={() => onChange({ [t.key]: !settings[t.key] } as Partial<VizSettings>)}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}
