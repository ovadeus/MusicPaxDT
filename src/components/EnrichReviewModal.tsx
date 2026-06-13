import { useMemo, useState } from "react";
import { X } from "lucide-react";
import * as ipc from "../lib/ipc";
import type { ApprovedEdit, EnrichProposal } from "../lib/types";

interface Props {
  proposals: EnrichProposal[];
  onClose: () => void;
  onApplied: (count: number) => void;
  onError: (message: string) => void;
}

type Field = "title" | "artist" | "album" | "year" | "genre";
const FIELDS: Field[] = ["title", "artist", "album", "genre", "year"];

function current(p: EnrichProposal, f: Field): string {
  const t = p.track;
  const v = f === "year" ? t.year : t[f];
  return v == null || v === "" ? "—" : String(v);
}
function proposed(p: EnrichProposal, f: Field): string | null {
  const s = p.suggestion;
  const v = f === "year" ? s.year : s[f];
  return v == null || v === "" ? null : String(v);
}
/// A field is a real change worth showing only if proposed exists and differs.
function isChange(p: EnrichProposal, f: Field): boolean {
  const prop = proposed(p, f);
  return prop != null && prop !== current(p, f);
}

/// Review proposed metadata before anything is written. Each changed field has
/// its own checkbox, pre-checked only for confident matches (≥0.9) so the AI's
/// lower-confidence guesses never apply unless you tick them.
export default function EnrichReviewModal({
  proposals,
  onClose,
  onApplied,
  onError,
}: Props) {
  // checked[trackId] = set of approved fields (+ "art")
  const [checked, setChecked] = useState<Record<number, Set<string>>>(() => {
    const init: Record<number, Set<string>> = {};
    for (const p of proposals) {
      const set = new Set<string>();
      const confident = p.suggestion.confidence >= 0.9;
      for (const f of FIELDS) {
        if (isChange(p, f) && confident) set.add(f);
      }
      if (p.suggestion.artUrl && confident) set.add("art");
      init[p.track.id] = set;
    }
    return init;
  });
  const [busy, setBusy] = useState(false);

  const toggle = (trackId: number, field: string) => {
    setChecked((cur) => {
      const set = new Set(cur[trackId] ?? []);
      if (set.has(field)) set.delete(field);
      else set.add(field);
      return { ...cur, [trackId]: set };
    });
  };

  const approvedCount = useMemo(
    () => Object.values(checked).reduce((n, s) => n + s.size, 0),
    [checked],
  );

  const setAll = (on: boolean) => {
    setChecked(() => {
      const next: Record<number, Set<string>> = {};
      for (const p of proposals) {
        const set = new Set<string>();
        if (on) {
          for (const f of FIELDS) if (isChange(p, f)) set.add(f);
          if (p.suggestion.artUrl) set.add("art");
        }
        next[p.track.id] = set;
      }
      return next;
    });
  };

  const apply = async () => {
    const edits: ApprovedEdit[] = [];
    for (const p of proposals) {
      const set = checked[p.track.id];
      if (!set || set.size === 0) continue;
      edits.push({
        trackId: p.track.id,
        title: set.has("title") ? p.suggestion.title : null,
        artist: set.has("artist") ? p.suggestion.artist : null,
        album: set.has("album") ? p.suggestion.album : null,
        year: set.has("year") ? p.suggestion.year : null,
        genre: set.has("genre") ? p.suggestion.genre : null,
        artUrl: set.has("art") ? p.suggestion.artUrl : null,
        // carry the MBID whenever any field from this match is accepted
        musicbrainzId: p.suggestion.musicbrainzId,
      });
    }
    if (edits.length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      const n = await ipc.applyEnrichment(edits);
      onApplied(n);
      onClose();
    } catch (e) {
      onError(`${e}`);
    } finally {
      setBusy(false);
    }
  };

  const sourceLabel = (src: string) =>
    src === "musicbrainz"
      ? "MusicBrainz"
      : src === "acoustid"
        ? "Fingerprint"
        : src === "llm+musicbrainz"
          ? "AI → MusicBrainz"
          : src === "llm"
            ? "AI guess"
            : src;

  return (
    <div className="settings-overlay" onClick={busy ? undefined : onClose}>
      <div
        className="settings-panel review-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-header">
          <h2>Review enrichment — {proposals.length} match(es)</h2>
          <button className="settings-close" onClick={onClose} disabled={busy} title="Close">
            <X size={15} />
          </button>
        </div>

        <div className="review-toolbar">
          <span className="settings-hint" style={{ margin: 0 }}>
            Tick only the fields that look correct. Nothing is written until you
            click Apply. Confident matches are pre-checked.
          </span>
          <div className="review-bulk">
            <button onClick={() => setAll(true)}>Check all</button>
            <button onClick={() => setAll(false)}>Clear</button>
          </div>
        </div>

        <div className="review-list">
          {proposals.map((p) => {
            const set = checked[p.track.id] ?? new Set<string>();
            const conf = Math.round(p.suggestion.confidence * 100);
            return (
              <div className="review-card" key={p.track.id}>
                <div className="review-card-head">
                  <span className="review-from" title={p.track.title ?? ""}>
                    {p.track.title ?? "Untitled"}
                  </span>
                  <span className={`review-source conf-${conf >= 90 ? "high" : conf >= 70 ? "mid" : "low"}`}>
                    {sourceLabel(p.suggestion.source)} · {conf}%
                  </span>
                </div>

                <div className="review-fields">
                  {FIELDS.filter((f) => isChange(p, f)).map((f) => (
                    <label className="review-field" key={f}>
                      <input
                        type="checkbox"
                        checked={set.has(f)}
                        onChange={() => toggle(p.track.id, f)}
                      />
                      <span className="review-field-name">{f}</span>
                      <span className="review-old">{current(p, f)}</span>
                      <span className="review-arrow">→</span>
                      <span className="review-new">{proposed(p, f)}</span>
                    </label>
                  ))}
                  {p.suggestion.artUrl && (
                    <label className="review-field">
                      <input
                        type="checkbox"
                        checked={set.has("art")}
                        onChange={() => toggle(p.track.id, "art")}
                      />
                      <span className="review-field-name">cover</span>
                      <img className="review-art" src={p.suggestion.artUrl} alt="" />
                    </label>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="addurl-actions">
          <button className="import-button" onClick={apply} disabled={busy}>
            {busy ? "Applying…" : `Apply ${approvedCount} change(s)`}
          </button>
        </div>
      </div>
    </div>
  );
}
