import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, Music, X } from "lucide-react";
import type { Track } from "../lib/types";

interface Props {
  track: Track;
  playing: boolean;
  volume: number; // 0..1
  seekRequestMs: number | null;
  onSeeked: () => void;
  onPlayingChange: (playing: boolean) => void;
  onTime: (positionMs: number, durationMs: number) => void;
  onEnded: () => void;
  onClose: () => void;
  onError: (message: string) => void;
  /// When set, the video fills this measured rect (theater / in-app fullscreen).
  theaterRect?: { top: number; left: number; width: number; height: number } | null;
}

const VIDEO_EXTS = ["mp4", "m4v", "webm", "mov", "mkv", "avi", "ogv"];

function isVideoUrl(uri: string): boolean {
  const path = uri.split(/[?#]/)[0].toLowerCase();
  const ext = path.split(".").pop() ?? "";
  return VIDEO_EXTS.includes(ext);
}

/// Plays a direct media URL (Archive.org etc.) inline — the STREAM_PLAYABLE
/// path for `source_kind = "stream"`. A <video> element handles both audio and
/// video: audio files play hidden; video shows a small dockable player. Unlike
/// live radio these files are seekable and report duration / end-of-track (so
/// playlists advance). Real VU is tapped when the host allows CORS.
export default function DirectStreamPlayer(props: Props) {
  const { track, playing, volume, seekRequestMs, onSeeked, onPlayingChange, onTime, onEnded } =
    props;
  const ref = useRef<HTMLVideoElement | null>(null);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const isVideo = isVideoUrl(track.uri);
  const [docked, setDocked] = useState(false);

  // Load once for this mount (App keys us by uri). Start playback synchronously
  // so the click's user-activation isn't lost (no await before .play(), or the
  // webview blocks autoplay). The VU meter is synthesized for this lane.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.src = track.uri;
    el.load();
    if (playingRef.current) el.play().catch(() => onPlayingChange(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.uri]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (playing) el.play().catch(() => onPlayingChange(false));
    else el.pause();
  }, [playing, onPlayingChange]);

  useEffect(() => {
    if (ref.current) ref.current.volume = volume;
  }, [volume]);

  useEffect(() => {
    if (seekRequestMs != null && ref.current) {
      ref.current.currentTime = seekRequestMs / 1000;
      onSeeked();
    }
  }, [seekRequestMs, onSeeked]);

  const media = (visible: boolean) => (
    <video
      ref={ref}
      hidden={!visible}
      playsInline
      className="direct-video"
      onPlaying={() => onPlayingChange(true)}
      onPause={() => onPlayingChange(false)}
      onEnded={onEnded}
      onTimeUpdate={() => {
        const el = ref.current;
        if (el) onTime(Math.round(el.currentTime * 1000), Math.round((el.duration || 0) * 1000));
      }}
      onError={() =>
        props.onError(
          `Could not play “${track.title ?? "stream"}” — the link may be offline or blocked.`,
        )
      }
    />
  );

  // Audio-only: a hidden element is enough (it still plays).
  if (!isVideo) return media(false);

  const theater = props.theaterRect ?? null;
  const theaterStyle = theater
    ? {
        position: "fixed" as const,
        top: theater.top,
        left: theater.left,
        width: theater.width,
        height: theater.height,
        right: "auto" as const,
        bottom: "auto" as const,
      }
    : undefined;

  // Video: a small dockable player, mirroring the YouTube embed chrome.
  return (
    <>
      {docked && !theater && (
        <button
          className="stream-dock-tab"
          onClick={() => setDocked(false)}
          title={`Show player — ${track.title ?? "stream"}`}
        >
          <ChevronLeft size={16} className="stream-dock-chevron" />
          <Music size={14} className="stream-dock-icon" />
        </button>
      )}
      <div
        className={`stream-player${docked && !theater ? " docked" : ""}${theater ? " theater" : ""}`}
        style={theaterStyle}
      >
        <div className="stream-player-header">
          <span className="stream-player-title" title={track.title ?? ""}>
            <Music size={13} className="np-stream-icon" />
            {track.title ?? "Stream"}
          </span>
          <button
            className="stream-player-dock"
            onClick={() => setDocked(true)}
            title="Dock — hide the video, keep playing"
          >
            <ChevronRight size={16} />
          </button>
          <a
            className="stream-player-link"
            href={track.uri}
            target="_blank"
            rel="noreferrer"
            title="Open the file"
          >
            <ExternalLink size={13} />
          </a>
          <button className="stream-player-close" onClick={props.onClose} title="Stop stream">
            <X size={14} />
          </button>
        </div>
        {media(true)}
      </div>
    </>
  );
}
