import { Fragment } from "react";
import { X } from "lucide-react";
import Markdown from "./Markdown";

/// The Markdown subset our liner-notes renderer supports, shown as a
/// type-this → get-that cheat sheet. Examples are rendered live by the same
/// Markdown component used for the notes, so the preview is always accurate.
const ROWS: { md: string; label: string }[] = [
  { md: "# Heading", label: "Heading (## and ### are smaller)" },
  { md: "**bold**", label: "Bold" },
  { md: "*italic*", label: "Italic" },
  { md: "- Bullet\n- Another", label: "Bulleted list" },
  { md: "1. First\n2. Second", label: "Numbered list" },
  { md: "[MusicPax](https://musicpax.com)", label: "Link" },
  { md: "> A quote", label: "Blockquote" },
  { md: "`inline code`", label: "Inline code" },
  { md: "---", label: "Horizontal rule" },
];

export default function MarkdownCheatSheet({ onClose }: { onClose: () => void }) {
  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel cheat-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Markdown cheat sheet</h2>
          <button className="settings-close" onClick={onClose} title="Close">
            <X size={15} />
          </button>
        </div>
        <p className="settings-hint" style={{ marginTop: 0 }}>
          Liner notes support these basics — type the left, get the right.
        </p>
        <div className="cheat-grid">
          <div className="cheat-head">Type this</div>
          <div className="cheat-head">You get</div>
          {ROWS.map((r) => (
            <Fragment key={r.md}>
              <code className="cheat-src">{r.md}</code>
              <div className="cheat-out" title={r.label}>
                <Markdown text={r.md} />
              </div>
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}
