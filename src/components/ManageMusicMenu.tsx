import { useEffect, useRef, useState } from "react";
import {
  Bot,
  ChevronDown,
  FileMusic,
  FolderPlus,
  HeartPulse,
  Music,
  Plus,
  RadioTower,
  Sparkles,
  Wand2,
} from "lucide-react";

interface Props {
  busy?: boolean;
  /// Enrich / Clean Data only apply to the visible library, with nothing
  /// already running.
  canEnrich: boolean;
  /// Pulse the trigger red when a broadcast is on air.
  onAir?: boolean;
  onImportFolder: () => void;
  onImportMpx: () => void;
  onClean: () => void;
  onEnrich: () => void;
  /// Health-check + re-resolve dead YouTube streams (self-healing library).
  onRepair: () => void;
  /// Shown only when an AI provider (key or Ollama) is configured.
  aiAvailable?: boolean;
  onAiAssistant?: () => void;
  onGoLive: () => void;
}

/// Curator "Manage Music" dropdown — every build/edit/broadcast tool in one
/// place: bring music in, tidy it, then go live.
export default function ManageMusicMenu(props: Props) {
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

  const item = (
    label: string,
    Icon: typeof Plus,
    run: () => void,
    opts?: { disabled?: boolean; title?: string },
  ) => (
    <button
      className={`addmedia-item${opts?.disabled ? " disabled" : ""}`}
      title={opts?.title}
      disabled={opts?.disabled}
      onClick={() => {
        if (opts?.disabled) return;
        setOpen(false);
        run();
      }}
    >
      <Icon size={15} />
      {label}
    </button>
  );

  const enrichDisabled = !props.canEnrich
    ? { disabled: true, title: "Open the Library with tracks to use this" }
    : undefined;

  return (
    <div className="addmedia-menu" ref={ref}>
      <button
        className={`addurl-button addmedia-trigger${props.onAir ? " on-air" : ""}`}
        onClick={() => setOpen((v) => !v)}
        disabled={props.busy}
        title={props.onAir ? "On air — open Go Live to stop" : "Manage your music"}
      >
        {props.onAir ? <span className="addmedia-onair-dot" /> : <Music size={14} />}
        Manage Music <ChevronDown size={14} />
      </button>

      {open && (
        <div className="addmedia-dropdown" role="menu">
          {item("Import Music Folder", FolderPlus, props.onImportFolder)}
          {item("Import .mpx Playlist", FileMusic, props.onImportMpx)}
          <div className="mode-sep" />
          {item("Clean Data", Wand2, props.onClean, enrichDisabled)}
          {item("Enrich", Sparkles, props.onEnrich, enrichDisabled)}
          {item("Repair Dead Links", HeartPulse, props.onRepair, {
            title: "Find unavailable YouTube tracks and re-resolve them",
          })}
          {props.aiAvailable &&
            props.onAiAssistant &&
            item("AI Assistant", Bot, props.onAiAssistant, props.busy ? { disabled: true } : undefined)}
          <div className="mode-sep" />
          {item("Go Live", RadioTower, props.onGoLive)}
        </div>
      )}
    </div>
  );
}
