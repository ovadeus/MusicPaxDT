import { ChevronRight } from "lucide-react";

interface Props {
  width: number;
  min: number;
  max: number;
  onChange: (width: number) => void;
  onCommit: (width: number) => void;
}

/// A draggable seam with a centered gripper that resizes the column to its
/// left. Drag logic is self-contained (window pointer listeners) so it keeps
/// tracking even when the cursor leaves the thin handle.
export default function SidebarResizer({ width, min, max, onChange, onCommit }: Props) {
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    let latest = width;
    const move = (ev: PointerEvent) => {
      latest = Math.min(max, Math.max(min, startW + (ev.clientX - startX)));
      onChange(latest);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("col-resizing");
      onCommit(latest);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.body.classList.add("col-resizing");
  };

  return (
    <div
      className="col-resizer"
      role="separator"
      aria-orientation="vertical"
      title="Drag to resize"
      onPointerDown={onPointerDown}
      onDoubleClick={() => onCommit(200)}
    >
      <span className="col-resizer-grip" aria-hidden>
        <ChevronRight size={13} />
      </span>
    </div>
  );
}
