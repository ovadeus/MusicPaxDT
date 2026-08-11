import { Headphones, Settings as SettingsIcon, SlidersHorizontal } from "lucide-react";

export type UiMode = "listening" | "curator";

interface Props {
  mode: UiMode;
  onMode: (mode: UiMode) => void;
  onOpenSettings: () => void;
}

/// Top-right interface control: a segmented Listening/Curator toggle (one click
/// to switch — no dropdown) plus a Settings button. Curator mode reveals the
/// import / add / enrich / edit tools; Listening keeps them out of the way.
export default function ModeMenu({ mode, onMode, onOpenSettings }: Props) {
  return (
    <div className="mode-menu">
      <div className="mode-switch" role="group" aria-label="Interface mode">
        <button
          className={`mode-seg${mode === "listening" ? " active" : ""}`}
          onClick={() => onMode("listening")}
          aria-pressed={mode === "listening"}
          title="Listening — just the music, no editing tools"
        >
          <Headphones size={14} />
          <span className="mode-seg-label">Listen</span>
        </button>
        <button
          className={`mode-seg${mode === "curator" ? " active" : ""}`}
          onClick={() => onMode("curator")}
          aria-pressed={mode === "curator"}
          title="Curator — import, add URLs, enrich, edit & build playlists"
        >
          <SlidersHorizontal size={14} />
          <span className="mode-seg-label">Curate</span>
        </button>
      </div>
      <button
        className="mode-settings"
        onClick={onOpenSettings}
        title="Settings"
        aria-label="Settings"
      >
        <SettingsIcon size={15} />
      </button>
    </div>
  );
}
