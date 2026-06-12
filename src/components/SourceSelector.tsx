interface Source {
  key: string;
  label: string;
  enabled: boolean;
}

// Milestone 1: only the Library source is live. The rest render disabled,
// like input buttons on a receiver that aren't hooked up yet.
const SOURCES: Source[] = [
  { key: "phono", label: "Phono", enabled: false },
  { key: "tape", label: "Tape", enabled: false },
  { key: "cd", label: "CD", enabled: false },
  { key: "aux", label: "Aux", enabled: false },
  { key: "radio", label: "Radio", enabled: false },
  { key: "library", label: "Library", enabled: true },
  { key: "stream", label: "Stream", enabled: false },
];

export default function SourceSelector() {
  return (
    <nav className="source-selector" aria-label="Source selector">
      {SOURCES.map((s) => (
        <button
          key={s.key}
          className={`source-button${s.enabled ? " active" : ""}`}
          disabled={!s.enabled}
          title={s.enabled ? s.label : "coming soon"}
        >
          {s.label}
        </button>
      ))}
    </nav>
  );
}
