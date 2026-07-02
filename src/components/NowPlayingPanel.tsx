import { useEffect, useRef, useState } from "react";
import { ChevronRight, ExternalLink, Pencil, Plus } from "lucide-react";
import * as ipc from "../lib/ipc";
import Markdown from "./Markdown";
import MarkdownCheatSheet from "./MarkdownCheatSheet";
import MpxLogo from "./MpxLogo";
import type { Track } from "../lib/types";

const MEDIA_VIDEO_EXTS = ["mp4", "m4v", "webm", "mov", "mkv", "ogv"];

/// A media-override URL is treated as video by extension, else as an image.
function isVideoMedia(url: string): boolean {
  const path = url.split(/[?#]/)[0].toLowerCase();
  return MEDIA_VIDEO_EXTS.some((e) => path.endsWith(`.${e}`));
}

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

export default function NowPlayingPanel({
  track,
  curator,
  onCollapse,
  onError,
}: Props) {
  const [bio, setBio] = useState<ipc.ArtistBio | null>(null);
  const [bioLoading, setBioLoading] = useState(false);
  const [loopUrl, setLoopUrl] = useState("");
  const [editingLoop, setEditingLoop] = useState(false);
  const [loopDraft, setLoopDraft] = useState("");
  const [imgFailed, setImgFailed] = useState(false);
  const [editingBio, setEditingBio] = useState(false);
  const [bioDraft, setBioDraft] = useState("");
  const [tab, setTab] = useState<"about" | "notes">("about");
  const [notes, setNotes] = useState("");
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesDraft, setNotesDraft] = useState("");
  const [cheatOpen, setCheatOpen] = useState(false);

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

  // Load this track's saved media override (settings: loopvideo.<id> — an image
  // OR a video URL that overrides the cover).
  const loadedFor = useRef<number | null>(null);
  useEffect(() => {
    setImgFailed(false);
    setEditingLoop(false);
    setEditingNotes(false);
    if (trackId == null) {
      setLoopUrl("");
      setNotes("");
      return;
    }
    ipc
      .getSettings()
      .then((s) => {
        loadedFor.current = trackId;
        setLoopUrl(s[`loopvideo.${trackId}`] ?? "");
        setNotes(s[`linernotes.${trackId}`] ?? "");
      })
      .catch(() => {
        setLoopUrl("");
        setNotes("");
      });
  }, [trackId]);

  const startEditNotes = () => {
    setNotesDraft(notes);
    setEditingNotes(true);
  };

  const saveNotes = async () => {
    if (trackId == null) return;
    try {
      await ipc.setSetting(`linernotes.${trackId}`, notesDraft);
      setNotes(notesDraft);
      setEditingNotes(false);
    } catch (e) {
      onError(`${e}`);
    }
  };

  const deleteNotes = async () => {
    if (trackId == null) return;
    try {
      await ipc.setSetting(`linernotes.${trackId}`, "");
      setNotes("");
      setNotesDraft("");
      setEditingNotes(false);
    } catch (e) {
      onError(`${e}`);
    }
  };

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

  // Opens the Markdown cheat sheet — shown beside the liner-notes controls.
  const mdHelp = (
    <button
      className="np-md-help"
      title="Markdown cheat sheet"
      onClick={() => setCheatOpen(true)}
    >
      MD
    </button>
  );

  // Media priority: 1) the curator media override (image OR video), 2) album
  // art / yt thumb, 3) default logo. artPath may be a remote URL (mpx import)
  // or a local file path (enrich cache); only URLs/data load over localhost.
  const artUrl =
    track?.artPath && /^(https?:|data:)/.test(track.artPath) ? track.artPath : null;
  const albumArt = artUrl || (track ? youtubeThumb(track.uri) : null);
  const override = loopUrl.trim();
  const showVideo = override !== "" && isVideoMedia(override);
  const imageSrc = override !== "" ? (showVideo ? null : override) : albumArt;
  const showImage = !showVideo && !!imageSrc && !imgFailed;

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
          <div className="np-tabs">
            <button
              className={`np-tab${tab === "about" ? " active" : ""}`}
              onClick={() => setTab("about")}
            >
              About
            </button>
            <button
              className={`np-tab${tab === "notes" ? " active" : ""}`}
              onClick={() => setTab("notes")}
            >
              My Liner Notes
            </button>
          </div>
          <div className="np-media" key={track.id}>
            {showVideo ? (
              <video
                className="np-media-el"
                src={override}
                autoPlay
                loop
                muted
                playsInline
                onError={() => onError("Media failed to load")}
              />
            ) : showImage ? (
              <img
                className="np-media-el"
                src={imageSrc ?? undefined}
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

          <div className="np-tab-content" key={`${tab}-${track.id}`}>
          {tab === "about" && curator && (
            <div className="np-loop-field">
              {editingLoop ? (
                <>
                  <input
                    type="url"
                    placeholder="image or video loop URL (jpg/png/webp | mp4/webm, ~8s)"
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
                  {loopUrl ? "Change media" : "Add media"}
                </button>
              )}
            </div>
          )}

          {tab === "about" && (
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
          )}

          {tab === "notes" && (
            <div className="np-notes">
              {curator && editingNotes ? (
                <div className="np-bio-edit">
                  <textarea
                    className="np-bio-textarea"
                    rows={14}
                    placeholder="Liner notes — Markdown supported (## heading, **bold**, - list, [link](url))…"
                    value={notesDraft}
                    autoFocus
                    onChange={(e) => setNotesDraft(e.target.value)}
                  />
                  <div className="np-notes-actions">
                    <button className="np-loop-save" onClick={saveNotes}>
                      Save
                    </button>
                    <button className="np-bio-cancel" onClick={() => setEditingNotes(false)}>
                      Cancel
                    </button>
                    {mdHelp}
                    {notes.trim() && (
                      <button className="np-notes-delete" onClick={deleteNotes}>
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              ) : notes.trim() ? (
                <>
                  {curator && (
                    <div className="np-notes-bar">
                      {mdHelp}
                      <button className="np-notes-btn" onClick={startEditNotes}>
                        <Pencil size={13} /> Edit notes
                      </button>
                    </div>
                  )}
                  <Markdown className="np-notes-md" text={notes} />
                </>
              ) : (
                <div className="np-notes-empty">
                  <p className="np-bio-loading">No liner notes yet.</p>
                  {curator && (
                    <div className="np-notes-bar np-notes-bar-left">
                      {mdHelp}
                      <button className="np-notes-btn" onClick={startEditNotes}>
                        <Plus size={14} /> Add liner notes
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          </div>
        </div>
      )}
      {cheatOpen && <MarkdownCheatSheet onClose={() => setCheatOpen(false)} />}
    </aside>
  );
}
