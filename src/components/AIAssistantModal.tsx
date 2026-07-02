import { useMemo, useState } from "react";
import { Sparkles, X } from "lucide-react";
import * as ipc from "../lib/ipc";
import type { ApprovedEdit } from "../lib/types";

interface Props {
  providerLabel: string;
  onClose: () => void;
  onApplied: (count: number) => void;
  onError: (message: string) => void;
}

const EXAMPLES = [
  'Remove "- Topic" from every artist name',
  "Set the genre to Rock for all tracks by Bob Seger",
  "For tracks by Boston on the album American Heartbeat, set the year to 1990",
];

const keyOf = (c: ipc.AssistantChange) => `${c.trackId}:${c.field}`;

/// Natural-language bulk metadata edits. The LLM only *proposes* changes; the
/// user reviews each one and nothing is written until Apply (reusing the
/// enrichment apply path). Available only when an AI provider is configured.
export default function AIAssistantModal({ providerLabel, onClose, onApplied, onError }: Props) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [changes, setChanges] = useState<ipc.AssistantChange[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());

  const run = async () => {
    const p = prompt.trim();
    if (!p) return;
    setBusy(true);
    setChanges(null);
    try {
      const result = await ipc.aiAssistantPropose(p);
      setChanges(result);
      setChecked(new Set(result.map(keyOf)));
    } catch (e) {
      onError(`${e}`);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (k: string) =>
    setChecked((cur) => {
      const next = new Set(cur);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const trackCount = useMemo(
    () => new Set((changes ?? []).filter((c) => checked.has(keyOf(c))).map((c) => c.trackId)).size,
    [changes, checked],
  );
  const approvedCount = checked.size;

  const apply = async () => {
    if (!changes) return;
    const byTrack = new Map<number, ipc.AssistantChange[]>();
    for (const c of changes) {
      if (!checked.has(keyOf(c))) continue;
      const arr = byTrack.get(c.trackId) ?? [];
      arr.push(c);
      byTrack.set(c.trackId, arr);
    }
    if (byTrack.size === 0) {
      onClose();
      return;
    }
    const edits: ApprovedEdit[] = [];
    for (const [trackId, cs] of byTrack) {
      const e: ApprovedEdit = {
        trackId,
        title: null,
        artist: null,
        album: null,
        year: null,
        genre: null,
        artUrl: null,
        musicbrainzId: null,
      };
      for (const c of cs) {
        // null → "" clears the field (empty is stored as NULL on the backend).
        if (c.field === "title") e.title = c.to ?? "";
        else if (c.field === "artist") e.artist = c.to ?? "";
        else if (c.field === "album") e.album = c.to ?? "";
        else if (c.field === "genre") e.genre = c.to ?? "";
        else if (c.field === "year") e.year = c.to ? Number(c.to) || null : null;
      }
      edits.push(e);
    }
    setApplying(true);
    try {
      const n = await ipc.applyEnrichment(edits);
      onApplied(n);
      onClose();
    } catch (e) {
      onError(`${e}`);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="settings-overlay" onClick={applying ? undefined : onClose}>
      <div className="settings-panel ai-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>
            <Sparkles size={16} style={{ verticalAlign: "-2px", marginRight: 6 }} />
            AI Assistant
          </h2>
          <button className="settings-close" onClick={onClose} disabled={applying} title="Close">
            <X size={15} />
          </button>
        </div>

        <p className="settings-hint" style={{ marginTop: 0 }}>
          Describe a bulk change to your library in plain English. The AI proposes
          edits — nothing is written until you review and Apply. Using {providerLabel}.
        </p>

        <textarea
          className="ai-prompt"
          rows={3}
          placeholder='e.g. Remove "- Topic" from every artist name'
          value={prompt}
          autoFocus
          disabled={busy || applying}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run();
          }}
        />

        <div className="ai-examples">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              className="ai-example"
              disabled={busy || applying}
              onClick={() => setPrompt(ex)}
            >
              {ex}
            </button>
          ))}
        </div>

        <div className="addurl-actions" style={{ marginTop: 4 }}>
          <button className="import-button" onClick={run} disabled={!prompt.trim() || busy || applying}>
            {busy ? "Thinking…" : "Propose changes"}
          </button>
        </div>

        {changes != null && (
          <div className="ai-result">
            {changes.length === 0 ? (
              <p className="settings-hint">No changes needed for that instruction.</p>
            ) : (
              <>
                <div className="review-toolbar">
                  <span className="settings-hint" style={{ margin: 0 }}>
                    {changes.length} change{changes.length === 1 ? "" : "s"} across{" "}
                    {new Set(changes.map((c) => c.trackId)).size} track(s). Tick the ones to apply.
                  </span>
                  <div className="review-bulk">
                    <button onClick={() => setChecked(new Set(changes.map(keyOf)))}>Check all</button>
                    <button onClick={() => setChecked(new Set())}>Clear</button>
                  </div>
                </div>
                <div className="ai-change-list">
                  {changes.map((c) => {
                    const k = keyOf(c);
                    return (
                      <label className="ai-change" key={k}>
                        <input type="checkbox" checked={checked.has(k)} onChange={() => toggle(k)} />
                        <span className="ai-change-track" title={c.trackLabel}>
                          {c.trackLabel}
                        </span>
                        <span className="ai-change-field">{c.field}</span>
                        <span className="ai-change-from">{c.from || "—"}</span>
                        <span className="ai-change-arrow">→</span>
                        <span className="ai-change-to">{c.to || "—"}</span>
                      </label>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}

        {changes != null && changes.length > 0 && (
          <div className="addurl-actions">
            <button className="import-button" onClick={apply} disabled={applying || approvedCount === 0}>
              {applying ? "Applying…" : `Apply ${approvedCount} change(s) to ${trackCount} track(s)`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
