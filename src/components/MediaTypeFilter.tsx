import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Filter } from "lucide-react";
import { MEDIA_TYPES } from "../lib/mediaTypes";
import type { MediaType } from "../lib/types";

interface Props {
  value: MediaType | null;
  onChange: (t: MediaType | null) => void;
}

/// Compact media-type filter. A single trigger button (showing the active type's
/// icon + label, or "All") opens a dropdown of the type options — replacing the
/// old inline chip row that overflowed the toolbar.
export default function MediaTypeFilter({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const active = MEDIA_TYPES.find((m) => m.key === value);
  const pick = (t: MediaType | null) => {
    onChange(t);
    setOpen(false);
  };

  return (
    <div className="mtype-filter" ref={ref}>
      <button
        className={`mtype-trigger${value != null ? " active" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title="Filter by type"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {active ? (
          <active.Icon size={15} style={{ color: active.color }} />
        ) : (
          <Filter size={14} />
        )}
        <span className="mtype-trigger-label">{active ? active.label : "All"}</span>
        <ChevronDown size={13} />
      </button>

      {open && (
        <div className="mtype-dropdown" role="menu">
          <button className="mtype-option" role="menuitem" onClick={() => pick(null)}>
            <Filter size={15} />
            <span className="mtype-option-label">All types</span>
            {value == null && <Check size={15} className="mtype-check" />}
          </button>
          {MEDIA_TYPES.map((m) => (
            <button
              key={m.key}
              className="mtype-option"
              role="menuitem"
              onClick={() => pick(m.key)}
            >
              <m.Icon size={15} style={{ color: m.color }} />
              <span className="mtype-option-label">{m.label}</span>
              {value === m.key && <Check size={15} className="mtype-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
