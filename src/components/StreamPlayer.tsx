import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, SquarePlay, X } from "lucide-react";
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
}

function videoIdFrom(uri: string): string | null {
  const m = uri.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

/// Official YouTube IFrame embed — the only way STREAM_PLAYABLE YouTube
/// content plays in STACK (no DSP, no recording, no stream access; the audio
/// engine refuses these tracks by design). Transport, volume, seek and
/// position all bridge over the IFrame API's postMessage protocol — the same
/// mechanism react-player uses on musicpax.com.
export default function StreamPlayer(props: Props) {
  const { track, playing, volume, seekRequestMs, onSeeked, onClose } = props;
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const readyRef = useRef(false);
  // Docked: the player slides off-screen but stays mounted, so the audio
  // keeps playing; a slim edge tab brings it back.
  const [docked, setDocked] = useState(false);

  // Keep latest callbacks without re-binding listeners.
  const cbRef = useRef(props);
  cbRef.current = props;

  const videoId = videoIdFrom(track.uri);
  // The iframe is created once with the first video and never reloaded;
  // subsequent tracks are swapped in via loadVideoById so the API connection
  // (and the all-important "ended" events) survive across a playlist.
  const initialVideoRef = useRef(videoId);
  const loadedRef = useRef<string | null>(videoId);

  const post = (func: string, args: unknown[] = []) => {
    iframeRef.current?.contentWindow?.postMessage(
      JSON.stringify({ event: "command", func, args }),
      "*",
    );
  };

  // Mount once: a persistent message listener + handshake. Not keyed on the
  // video, so switching tracks never tears the API connection down.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (typeof e.data !== "string" || !e.origin.includes("youtube")) return;
      let data: { event?: string; info?: unknown };
      try {
        data = JSON.parse(e.data);
      } catch {
        return;
      }
      if (!readyRef.current) {
        readyRef.current = true;
        post("setVolume", [Math.round(cbRef.current.volume * 100)]);
        // If the track changed before the player was ready, load it now.
        if (loadedRef.current && loadedRef.current !== initialVideoRef.current) {
          post("loadVideoById", [loadedRef.current]);
        } else if (cbRef.current.playing) {
          post("playVideo");
        }
      }
      if (data.event === "onStateChange" && typeof data.info === "number") {
        if (data.info === 0) cbRef.current.onEnded();
        else if (data.info === 1) cbRef.current.onPlayingChange(true);
        else if (data.info === 2) cbRef.current.onPlayingChange(false);
      } else if (data.event === "infoDelivery" && data.info && typeof data.info === "object") {
        const info = data.info as { currentTime?: number; duration?: number };
        if (typeof info.currentTime === "number") {
          cbRef.current.onTime(
            Math.round(info.currentTime * 1000),
            Math.round((info.duration ?? 0) * 1000),
          );
        }
      }
    };
    window.addEventListener("message", onMessage);

    const handshake = window.setInterval(() => {
      if (readyRef.current) {
        window.clearInterval(handshake);
        return;
      }
      iframeRef.current?.contentWindow?.postMessage(
        JSON.stringify({ event: "listening", id: "stack-stream", channel: "widget" }),
        "*",
      );
    }, 300);
    const stopHandshake = window.setTimeout(() => window.clearInterval(handshake), 12_000);

    return () => {
      window.removeEventListener("message", onMessage);
      window.clearInterval(handshake);
      window.clearTimeout(stopHandshake);
    };
  }, []);

  // Track changed → swap the video in place (no iframe reload).
  useEffect(() => {
    if (!videoId || loadedRef.current === videoId) return;
    loadedRef.current = videoId;
    if (readyRef.current) post("loadVideoById", [videoId]);
  }, [videoId]);

  // Transport / volume / seek bridges.
  useEffect(() => {
    if (readyRef.current) post(playing ? "playVideo" : "pauseVideo");
  }, [playing]);
  useEffect(() => {
    if (readyRef.current) post("setVolume", [Math.round(volume * 100)]);
  }, [volume]);
  useEffect(() => {
    if (seekRequestMs != null) {
      post("seekTo", [seekRequestMs / 1000, true]);
      onSeeked();
    }
  }, [seekRequestMs, onSeeked]);

  if (!videoId) return null;

  return (
    <>
      {docked && (
        <button
          className="stream-dock-tab"
          onClick={() => setDocked(false)}
          title={`Show player — ${track.title ?? "stream"}`}
        >
          <ChevronLeft size={16} className="stream-dock-chevron" />
          <SquarePlay size={14} className="stream-dock-icon" />
        </button>
      )}
      <div className={`stream-player${docked ? " docked" : ""}`}>
      <div className="stream-player-header">
        <span className="stream-player-title" title={track.title ?? ""}>
          <SquarePlay size={13} className="np-stream-icon" />
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
          title="Open on YouTube"
        >
          <ExternalLink size={13} />
        </a>
        <button className="stream-player-close" onClick={onClose} title="Stop stream">
          <X size={14} />
        </button>
      </div>
      <iframe
        ref={iframeRef}
        title="YouTube player"
        width="384"
        height="216"
        src={`https://www.youtube-nocookie.com/embed/${initialVideoRef.current}?autoplay=1&enablejsapi=1&playsinline=1&origin=${encodeURIComponent(window.location.origin)}`}
        frameBorder="0"
        allow="autoplay; encrypted-media; picture-in-picture"
        allowFullScreen
      />
      </div>
    </>
  );
}
