import { useEffect, useRef, useState } from "react";
import { ChevronRight, ExternalLink } from "lucide-react";
import * as ipc from "../lib/ipc";
import type { Track } from "../lib/types";

interface Props {
  track: Track | null;
  curator: boolean;
  onCollapse: () => void;
  onError: (message: string) => void;
}

/// Default cover when no loop video or album art is available — the MusicPax
/// mark (peace ring + blue up-arrow), drawn inline so it scales cleanly.
function DefaultCover() {
  return (
    <svg className="np-default-cover" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
      <circle cx="60" cy="60" r="52" fill="none" stroke="#2b2f36" strokeWidth="10" />
      <line x1="60" y1="12" x2="60" y2="60" stroke="#2b2f36" strokeWidth="10" />
      {/* blue up-arrow + peace legs */}
      <polygon fill="#29abe2" points="60,30 80,54 66,54 66,108 54,108 54,54 40,54" />
      <polygon fill="#29abe2" points="60,62 30,98 44,98 60,80" />
      <polygon fill="#29abe2" points="60,62 90,98 76,98 60,80" />
    </svg>
  );
}

function youtubeThumb(uri: string): string | null {
  const m = uri.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  return m ? `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg` : null;
}

export default function NowPlayingPanel({ track, curator, onCollapse, onError }: Props) {
  const [bio, setBio] = useState<ipc.ArtistBio | null>(null);
  const [bioLoading, setBioLoading] = useState(false);
  const [loopUrl, setLoopUrl] = useState("");
  const [editingLoop, setEditingLoop] = useState(false);
  const [loopDraft, setLoopDraft] = useState("");
  const [imgFailed, setImgFailed] = useState(false);

  const artist = track?.artist ?? null;
  const trackId = track?.id ?? null;

  // Fetch the artist bio when the artist changes.
  useEffect(() => {
    setBio(null);
    if (!artist) return;
    let cancelled = false;
    setBioLoading(true);
    ipc
      .artistBio(artist)
      .then((b) => !cancelled && setBio(b))
      .catch(() => {})
      .finally(() => !cancelled && setBioLoading(false));
    return () => {
      cancelled = true;
    };
  }, [artist]);

  // Load this track's saved loop-video URL (settings: loopvideo.<id>).
  const loadedFor = useRef<number | null>(null);
  useEffect(() => {
    setImgFailed(false);
    setEditingLoop(false);
    if (trackId == null) {
      setLoopUrl("");
      return;
    }
    ipc
      .getSettings()
      .then((s) => {
        loadedFor.current = trackId;
        setLoopUrl(s[`loopvideo.${trackId}`] ?? "");
      })
      .catch(() => setLoopUrl(""));
  }, [trackId]);

  const saveLoop = async () => {
    if (trackId == null) return;
    const url = loopDraft.trim();
    try {
      await ipc.setSetting(`loopvideo.${trackId}`, url);
      setLoopUrl(url);
      setEditingLoop(false);
    } catch (e) {
      onError(`${e}`);
    }
  };

  // Media priority: 1) loop video, 2) album cover / yt thumb, 3) default logo.
  // artPath may be a remote URL (mpx import) or a local file path (enrich
  // cache); only URLs/data load over the localhost origin.
  const artUrl =
    track?.artPath && /^(https?:|data:)/.test(track.artPath) ? track.artPath : null;
  const cover = artUrl || (track ? youtubeThumb(track.uri) : null);
  const showVideo = loopUrl.length > 0;
  const showImage = !showVideo && !!cover && !imgFailed;

  return (
    <aside className="now-playing-panel">
      <div className="np-panel-header">
        <span className="np-panel-title">Now Playing</span>
        <button className="np-collapse" title="Hide panel" onClick={onCollapse}>
          <ChevronRight size={16} />
        </button>
      </div>

      {!track ? (
        <div className="np-empty">
          <DefaultCover />
          <p className="np-artist-line">Nothing playing</p>
        </div>
      ) : (
        <div className="np-body">
          <div className="np-media">
            {showVideo ? (
              <video
                className="np-media-el"
                src={loopUrl}
                autoPlay
                loop
                muted
                playsInline
                onError={() => onError("Loop video failed to load")}
              />
            ) : showImage ? (
              <img
                className="np-media-el"
                src={cover ?? undefined}
                alt=""
                onError={() => setImgFailed(true)}
              />
            ) : (
              <DefaultCover />
            )}
          </div>

          <div className="np-artist-line">{track.artist ?? "Unknown artist"}</div>
          <div className="np-song-line">{track.title ?? "Untitled"}</div>
          {track.album && <div className="np-album-line">{track.album}</div>}

          {curator && (
            <div className="np-loop-field">
              {editingLoop ? (
                <>
                  <input
                    type="url"
                    placeholder="Loop video URL (mp4/webm, ~8s)"
                    value={loopDraft}
                    autoFocus
                    onChange={(e) => setLoopDraft(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && saveLoop()}
                  />
                  <button className="np-loop-save" onClick={saveLoop}>
                    Save
                  </button>
                </>
              ) : (
                <button
                  className="np-loop-edit"
                  onClick={() => {
                    setLoopDraft(loopUrl);
                    setEditingLoop(true);
                  }}
                >
                  {loopUrl ? "Edit loop video" : "Add loop video"}
                </button>
              )}
            </div>
          )}

          <div className="np-bio">
            {bioLoading && <p className="np-bio-loading">Loading bio…</p>}
            {!bioLoading && bio && (
              <>
                <p className="np-bio-text">{bio.extract}</p>
                {bio.url && (
                  <a className="np-bio-link" href={bio.url} target="_blank" rel="noreferrer">
                    Wikipedia <ExternalLink size={11} />
                  </a>
                )}
              </>
            )}
            {!bioLoading && !bio && artist && (
              <p className="np-bio-loading">No biography found.</p>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
