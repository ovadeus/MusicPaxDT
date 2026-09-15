import { ArrowRight } from "lucide-react";
import MpxLogo from "./MpxLogo";

interface Props {
  /// The version already downloaded, verified and staged.
  version: string;
  /// While broadcasting, the card holds: relaunching would drop the stream.
  onAir: boolean;
  onRelaunch: () => void;
}

/// The "Relaunch to update" card. It only ever appears once a new version is
/// fully staged, so the click is a restart, not a download — the whole point
/// is that updating feels like nothing. Sits bottom-left, out of the way, and
/// stays until acted on rather than nagging.
export default function UpdateCard({ version, onAir, onRelaunch }: Props) {
  return (
    <button
      className={`update-card${onAir ? " held" : ""}`}
      onClick={onRelaunch}
      title={
        onAir
          ? "The update installs when you relaunch — after your broadcast"
          : "Relaunch now to finish updating"
      }
    >
      <MpxLogo className="update-card-logo" />
      <span className="update-card-text">
        <span className="update-card-title">
          {onAir ? "Update ready" : "Relaunch to update"}
        </span>
        <span className="update-card-sub">
          {onAir ? "relaunches after your broadcast" : `v${version}`}
        </span>
      </span>
      <ArrowRight size={18} className="update-card-arrow" />
    </button>
  );
}
