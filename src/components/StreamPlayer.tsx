import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, SquarePlay, X } from "lucide-react";
import * as ipc from "../lib/ipc";
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
  /// The embed reported the current video is unplayable (removed / private /
  /// embed-disabled / region-blocked). Fired once per video so the app can
  /// auto-heal by re-resolving to a working replacement.
  onFatalError?: (videoId: string) => void;
  /// When set, the player fills this measured rect (theater / in-app fullscreen)
  /// instead of the small floating box. The iframe is never remounted, so
  /// playback is uninterrupted.
  theaterRect?: {
    top: number;
    left: number;
    width: number;
    height: number;
    z?: number;
  } | null;
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
  const { track, playing, volume, seekRequestMs, onSeeked } = props;
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
  // Which video we've already reported as failed, so onError fires the app's
  // auto-heal at most once per video (avoids repeat calls while it re-resolves).
  const erroredRef = useRef<string | null>(null);
  // After a track swap (loadVideoById) the embed emits transient state events —
  // a brief "paused", or a stale "ended" from the outgoing video. If we forward
  // those, the freshly-loaded track lands paused (or double-skips). Ignore
  // pause/ended until the NEW video has actually reported "playing".
  const lastLoadAtRef = useRef(Date.now());
  const settledRef = useRef(false);

  const post = (func: string, args: unknown[] = []) => {
    iframeRef.current?.contentWindow?.postMessage(
      JSON.stringify({ event: "command", func, args }),
      "*",
    );
  };

  // Mount once: a persistent message listener + handshake. Not keyed on the
  // video, so switching tracks never tears the API connection down.
  useEffect(() => {
    // Apply a YouTube player-state code (0 ended, 1 playing, 2 paused),
    // suppressing the transient pause/ended the embed emits while a new track
    // is loading — until that track reports "playing" (settledRef) or a short
    // window elapses. Keeps switching tracks from landing paused / double-skipping.
    const applyState = (n: number) => {
      const swapping = !settledRef.current && Date.now() - lastLoadAtRef.current < 3000;
      if (n === 1) {
        settledRef.current = true;
        cbRef.current.onPlayingChange(true);
      } else if (n === 2) {
        if (!swapping) cbRef.current.onPlayingChange(false);
      } else if (n === 0) {
        if (!swapping) cbRef.current.onEnded();
      }
    };
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
      if (data.event === "onError" && typeof data.info === "number") {
        // 2 = bad id, 100 = removed/private, 101/150 = embedding disabled or
        // region-blocked. All mean this video won't play — ask for a re-resolve.
        const current = loadedRef.current;
        if ([2, 100, 101, 150].includes(data.info) && current && erroredRef.current !== current) {
          erroredRef.current = current;
          cbRef.current.onFatalError?.(current);
        }
      } else if (data.event === "onStateChange" && typeof data.info === "number") {
        applyState(data.info);
      } else if (data.event === "infoDelivery" && data.info && typeof data.info === "object") {
        const info = data.info as {
          currentTime?: number;
          duration?: number;
          playerState?: number;
        };
        // youtube-nocookie embeds deliver state through infoDelivery.playerState
        // — the standalone onStateChange event frequently never arrives over raw
        // postMessage, so end-of-video MUST be detected here or playlists stall.
        if (typeof info.playerState === "number") applyState(info.playerState);
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
    erroredRef.current = null; // a fresh video may fail on its own merits
    settledRef.current = false; // guard transient states until this one plays
    lastLoadAtRef.current = Date.now();
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
        zIndex: theater.z,
      }
    : undefined;

  return (
    <>
      {docked && !theater && (
        <button
          className="stream-dock-tab"
          onClick={() => setDocked(false)}
          title={`Show player — ${track.title ?? "stream"}`}
        >
          <ChevronLeft size={16} className="stream-dock-chevron" />
          <SquarePlay size={14} className="stream-dock-icon" />
        </button>
      )}
      <div
        className={`stream-player${docked && !theater ? " docked" : ""}${theater ? " theater" : ""}`}
        style={theaterStyle}
      >
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
        <button
          className="stream-player-link"
          onClick={() => ipc.openExternal(track.uri)}
          title="Open on YouTube"
        >
          <ExternalLink size={13} />
        </button>
        <button
          className="stream-player-close"
          onClick={() => setDocked(true)}
          title="Hide the video — keeps playing (reopen from the tab)"
        >
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
