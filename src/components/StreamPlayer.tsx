import { useEffect, useRef } from "react";
import type { Track } from "../lib/types";

interface Props {
  track: Track;
  onEnded: () => void;
  onClose: () => void;
}

function videoIdFrom(uri: string): string | null {
  const m = uri.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

/// Official YouTube IFrame embed — the only way STREAM_PLAYABLE YouTube
/// content plays in STACK. No DSP, no recording, no stream access; the audio
/// engine refuses these tracks by design. Ended-detection uses the IFrame
/// API postMessage protocol so playlists can auto-advance.
export default function StreamPlayer({ track, onEnded, onClose }: Props) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const endedRef = useRef(onEnded);
  endedRef.current = onEnded;

  const videoId = videoIdFrom(track.uri);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (typeof e.data !== "string" || !e.origin.includes("youtube")) return;
      try {
        const data = JSON.parse(e.data);
        if (data.event === "onStateChange" && data.info === 0) {
          endedRef.current();
        }
      } catch {
        // not a player message
      }
    };
    window.addEventListener("message", onMessage);

    // Handshake so the embed starts posting events to us.
    const listen = window.setInterval(() => {
      iframeRef.current?.contentWindow?.postMessage(
        JSON.stringify({ event: "listening", id: "stack-stream", channel: "widget" }),
        "*",
      );
    }, 500);
    const stopHandshake = window.setTimeout(() => window.clearInterval(listen), 5000);

    return () => {
      window.removeEventListener("message", onMessage);
      window.clearInterval(listen);
      window.clearTimeout(stopHandshake);
    };
  }, [videoId]);

  if (!videoId) return null;

  return (
    <div className="stream-player">
      <div className="stream-player-header">
        <span className="stream-player-title" title={track.title ?? ""}>
          📡 {track.title ?? "Stream"}
        </span>
        <a
          className="stream-player-link"
          href={track.uri}
          target="_blank"
          rel="noreferrer"
          title="Open on YouTube"
        >
          ↗
        </a>
        <button className="stream-player-close" onClick={onClose} title="Stop stream">
          ✕
        </button>
      </div>
      <iframe
        ref={iframeRef}
        title="YouTube player"
        width="384"
        height="216"
        src={`https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&enablejsapi=1`}
        frameBorder="0"
        allow="autoplay; encrypted-media; picture-in-picture"
        allowFullScreen
      />
    </div>
  );
}
