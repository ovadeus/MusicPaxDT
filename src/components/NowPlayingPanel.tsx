import { useEffect, useRef, useState } from "react";
import { ChevronRight, ExternalLink, ImagePlus } from "lucide-react";
import * as ipc from "../lib/ipc";
import MpxLogo from "./MpxLogo";
import type { Track } from "../lib/types";

interface Props {
  track: Track | null;
  curator: boolean;
  onCollapse: () => void;
  onError: (message: string) => void;
}

/// Default cover when no loop video or album art is available — the MusicPax mark.
function DefaultCover() {
  return <MpxLogo className="np-default-cover" />;
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
  const [editingBio, setEditingBio] = useState(false);
  const [bioDraft, setBioDraft] = useState("");
  const [coverUrl, setCoverUrl] = useState("");
  const [editingCover, setEditingCover] = useState(false);
  const [coverDraft, setCoverDraft] = useState("");

  const artist = track?.artist ?? null;
  const trackId = track?.id ?? null;

  // Fetch the artist bio when the artist changes.
  useEffect(() => {
    setBio(null);
    setEditingBio(false);
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

  const saveBio = async () => {
    if (!artist) return;
    try {
      await ipc.setArtistBio(artist, bioDraft);
      setEditingBio(false);
      setBio(await ipc.artistBio(artist));
    } catch (e) {
      onError(`${e}`);
    }
  };

  // Load this track's saved loop-video + custom cover URLs (settings:
  // loopvideo.<id> / cover.<id>).
  const loadedFor = useRef<number | null>(null);
  useEffect(() => {
    setImgFailed(false);
    setEditingLoop(false);
    setEditingCover(false);
    if (trackId == null) {
      setLoopUrl("");
      setCoverUrl("");
      return;
    }
    ipc
      .getSettings()
      .then((s) => {
        loadedFor.current = trackId;
        setLoopUrl(s[`loopvideo.${trackId}`] ?? "");
        setCoverUrl(s[`cover.${trackId}`] ?? "");
      })
      .catch(() => {
        setLoopUrl("");
        setCoverUrl("");
      });
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

  const saveCover = async () => {
    if (trackId == null) return;
    const url = coverDraft.trim();
    try {
      await ipc.setSetting(`cover.${trackId}`, url);
      setCoverUrl(url);
      setImgFailed(false);
      setEditingCover(false);
    } catch (e) {
      onError(`${e}`);
    }
  };

  // Media priority: 1) loop video, 2) custom cover, 3) album art / yt thumb,
  // 4) default logo. artPath may be a remote URL (mpx import) or a local file
  // path (enrich cache); only URLs/data load over the localhost origin.
  const artUrl =
    track?.artPath && /^(https?:|data:)/.test(track.artPath) ? track.artPath : null;
  const cover = coverUrl || artUrl || (track ? youtubeThumb(track.uri) : null);
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
            {curator && !showVideo && (
              <button
                className="np-cover-edit"
                title={coverUrl ? "Change cover image" : "Add cover image"}
                onClick={() => {
                  setCoverDraft(coverUrl);
                  setEditingCover((v) => !v);
                }}
              >
                <ImagePlus size={14} />
              </button>
            )}
          </div>

          {curator && editingCover && (
            <div className="np-loop-field">
              <input
                type="url"
                placeholder="Cover image URL (jpg/png/webp)"
                value={coverDraft}
                autoFocus
                onChange={(e) => setCoverDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && saveCover()}
              />
              <button className="np-loop-save" onClick={saveCover}>
                Save
              </button>
            </div>
          )}

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
            {!bioLoading && editingBio ? (
              <div className="np-bio-edit">
                <textarea
                  className="np-bio-textarea"
                  rows={7}
                  placeholder="Write a short artist bio…"
                  value={bioDraft}
                  autoFocus
                  onChange={(e) => setBioDraft(e.target.value)}
                />
                <div className="np-bio-actions">
                  <button className="np-loop-save" onClick={saveBio}>
                    Save
                  </button>
                  <button className="np-bio-cancel" onClick={() => setEditingBio(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              !bioLoading && (
                <>
                  {bio ? (
                    <>
                      <p className="np-bio-text">{bio.extract}</p>
                      {bio.url && (
                        <a
                          className="np-bio-link"
                          href={bio.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Wikipedia <ExternalLink size={11} />
                        </a>
                      )}
                    </>
                  ) : (
                    artist && <p className="np-bio-loading">No biography found.</p>
                  )}
                  {curator && artist && (
                    <button
                      className="np-bio-editbtn"
                      onClick={() => {
                        setBioDraft(bio?.extract ?? "");
                        setEditingBio(true);
                      }}
                    >
                      {bio ? "Edit bio" : "Add bio"}
                    </button>
                  )}
                </>
              )
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
