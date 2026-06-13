import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Headphones,
  Settings as SettingsIcon,
  SlidersHorizontal,
} from "lucide-react";

export type UiMode = "listening" | "curator";

interface Props {
  mode: UiMode;
  onMode: (mode: UiMode) => void;
  onOpenSettings: () => void;
}

/// Top-right chevron menu. Switches between a clean Listening surface and
/// Curator mode (which reveals import / add / enrich / edit tools), and opens
/// Settings — keeping those controls out of the listening experience.
export default function ModeMenu({ mode, onMode, onOpenSettings }: Props) {
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

  const pick = (m: UiMode) => {
    onMode(m);
    setOpen(false);
  };

  return (
    <div className="mode-menu" ref={ref}>
      <button
        className="mode-trigger"
        onClick={() => setOpen((v) => !v)}
        title="Mode & settings"
      >
        {mode === "curator" ? (
          <SlidersHorizontal size={14} />
        ) : (
          <Headphones size={14} />
        )}
        <span className="mode-trigger-label">
          {mode === "curator" ? "Curator" : "Listening"}
        </span>
        <ChevronDown size={14} />
      </button>

      {open && (
        <div className="mode-dropdown" role="menu">
          <button className="mode-item" onClick={() => pick("listening")}>
            <Headphones size={15} />
            <span className="mode-item-text">
              <span className="mode-item-title">Listening Mode</span>
              <span className="mode-item-sub">Just the music — no editing tools</span>
            </span>
            {mode === "listening" && <Check size={15} className="mode-check" />}
          </button>

          <button className="mode-item" onClick={() => pick("curator")}>
            <SlidersHorizontal size={15} />
            <span className="mode-item-text">
              <span className="mode-item-title">Curator Mode</span>
              <span className="mode-item-sub">
                Import, add URLs, enrich, edit &amp; build playlists
              </span>
            </span>
            {mode === "curator" && <Check size={15} className="mode-check" />}
          </button>

          <div className="mode-sep" />

          <button
            className="mode-item"
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
          >
            <SettingsIcon size={15} />
            <span className="mode-item-text">
              <span className="mode-item-title">Settings</span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
