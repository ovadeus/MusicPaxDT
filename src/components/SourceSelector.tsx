export type SelectableSource =
  | "library"
  | "phono"
  | "tape"
  | "cd"
  | "aux"
  | "radio"
  | "stream";

interface Source {
  key: string;
  label: string;
  enabled: boolean;
}

const SOURCES: Source[] = [
  { key: "phono", label: "Phono", enabled: true },
  { key: "tape", label: "Tape", enabled: true },
  { key: "cd", label: "CD", enabled: true },
  { key: "aux", label: "Aux", enabled: true },
  { key: "radio", label: "Radio", enabled: true },
  { key: "library", label: "Library", enabled: true },
  { key: "stream", label: "Stream", enabled: true },
];

interface Props {
  active: SelectableSource;
  onSelect: (source: SelectableSource) => void;
}

export default function SourceSelector({ active, onSelect }: Props) {
  return (
    <nav className="source-selector" aria-label="Source selector">
      {SOURCES.map((s) => (
        <button
          key={s.key}
          className={`source-button${s.key === active ? " active" : ""}`}
          disabled={!s.enabled}
          title={s.enabled ? s.label : "coming soon"}
          onClick={() => {
            if (s.enabled && s.key !== active) {
              onSelect(s.key as SelectableSource);
            }
          }}
        >
          {s.label}
        </button>
      ))}
    </nav>
  );
}
