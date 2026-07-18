import { useEffect, useMemo, useState } from "react";
import { Check, Copy, Mail, X } from "lucide-react";
import * as ipc from "../lib/ipc";
import type { Track } from "../lib/types";

interface Props {
  playlistId: number;
  playlistName: string;
  onClose: () => void;
  onError: (message: string) => void;
  onDone: (message: string) => void;
}

/// "Share this playlist with a friend": email entry → the MusicPax share
/// server stores the playlist as .mpx and emails the friend a link to a
/// landing page (get the app / open in MusicPax web / download the file).
/// Only streamable references travel — local files never leave this machine.
export default function SharePlaylistModal({
  playlistId,
  playlistName,
  onClose,
  onError,
  onDone,
}: Props) {
  const [email, setEmail] = useState("");
  const [senderName, setSenderName] = useState("");
  const [busy, setBusy] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState("");
  const [copied, setCopied] = useState(false);

  // Fetched here (not passed in) so the modal works for any playlist —
  // shared from the toolbar or from a sidebar row that isn't open.
  const [tracks, setTracks] = useState<Track[] | null>(null);
  useEffect(() => {
    let live = true;
    ipc
      .playlistTracks(playlistId)
      .then((ts) => {
        if (live) setTracks(ts);
      })
      .catch(() => {
        if (live) setTracks([]);
      });
    return () => {
      live = false;
    };
  }, [playlistId]);

  const localCount = useMemo(
    () => (tracks ?? []).filter((t) => t.capability === "OWNED").length,
    [tracks],
  );
  const shareableCount = (tracks?.length ?? 0) - localCount;
  const emailOk = /^\S+@\S+\.\S+$/.test(email.trim());

  const submit = async () => {
    if (!emailOk || busy) return;
    setBusy(true);
    try {
      const report = await ipc.sharePlaylist(
        playlistId,
        email.trim(),
        senderName.trim() || undefined,
      );
      setSentTo(email.trim());
      setShareUrl(report.shareUrl);
      onDone(
        `Shared “${playlistName}” (${report.trackCount} track${report.trackCount === 1 ? "" : "s"}) with ${email.trim()}`,
      );
    } catch (e) {
      onError(`${e}`);
    } finally {
      setBusy(false);
    }
  };

  const copyLink = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the link is still visible to select */
    }
  };

  return (
    <div className="settings-overlay" onClick={busy ? undefined : onClose}>
      <div className="settings-panel share-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Share this playlist with a friend</h2>
          <button className="settings-close" onClick={onClose} disabled={busy} title="Close">
            <X size={15} />
          </button>
        </div>

        {shareUrl ? (
          <>
            <p className="share-sent">
              <Mail size={14} /> Sent to <strong>{sentTo}</strong>
            </p>
            <div className="share-link-row">
              <input className="share-link" readOnly value={shareUrl} onFocus={(e) => e.currentTarget.select()} />
              <button className="share-copy" onClick={copyLink} title="Copy link">
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
            <div className="addurl-actions">
              <button className="import-button" onClick={onClose}>
                Done
              </button>
            </div>
            <p className="settings-hint">
              The link opens a page where they can get the MusicPax app, open the
              playlist in MusicPax web, or download the .mpx file.
            </p>
          </>
        ) : (
          <>
            <p className="settings-hint share-lede">
              “{playlistName}”
              {tracks !== null &&
                ` — ${shareableCount} shareable track${shareableCount === 1 ? "" : "s"}`}
              . Your friend gets an email with a link to play it in MusicPax.
            </p>
            <input
              type="email"
              className="share-input"
              placeholder="friend@example.com"
              value={email}
              autoFocus
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              disabled={busy}
            />
            <input
              type="text"
              className="share-input"
              placeholder="Your name (optional — shown in the email)"
              value={senderName}
              onChange={(e) => setSenderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              disabled={busy}
            />
            <div className="addurl-actions">
              <button className="import-button" onClick={submit} disabled={busy || !emailOk}>
                {busy ? "Sending…" : "Send"}
              </button>
            </div>
            {localCount > 0 && (
              <p className="settings-hint">
                {localCount} local file{localCount === 1 ? " stays" : "s stay"} on your
                disk and won’t be included — only streamable tracks travel.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
