import { useEffect, useRef, useState } from "react";
import { Check, ExternalLink, Loader2, X } from "lucide-react";
import * as ipc from "../lib/ipc";

interface Props {
  onClose: () => void;
  /// Fired once the key verifies and is saved, so Settings can refresh status.
  onSaved: () => void;
}

/// Deep link straight onto the YouTube Data API's "Enable" page. It handles
/// project selection (and creation) itself, which is the part of Google Cloud
/// people get lost in — so step 1 is one button, not a tour of the console.
const ENABLE_URL = "https://console.cloud.google.com/apis/library/youtube.googleapis.com";
const CREDENTIALS_URL = "https://console.cloud.google.com/apis/credentials";

/// Google API keys are `AIza` + 35 more characters. Checking the shape locally
/// turns a stray copy (a URL, half a key, a client ID) into instant feedback
/// instead of a network round trip and a confusing rejection.
function looksLikeKey(key: string): boolean {
  return /^AIza[A-Za-z0-9_-]{35}$/.test(key);
}

/// Guided YouTube Data API key setup. The key is free and needs no credit
/// card; almost all of the difficulty is navigating Google Cloud, so each step
/// is a single button onto the exact page, and the key verifies itself the
/// moment it is pasted.
export default function YouTubeKeySetup({ onClose, onSaved }: Props) {
  const [key, setKey] = useState("");
  const [state, setState] = useState<"idle" | "checking" | "ok" | "error">("idle");
  const [message, setMessage] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Verify (and on success save) as soon as a complete-looking key is present.
  // Debounced so typing a key by hand doesn't fire a call per keystroke.
  useEffect(() => {
    const trimmed = key.trim();
    if (!trimmed) {
      setState("idle");
      setMessage("");
      return;
    }
    if (!looksLikeKey(trimmed)) {
      setState("error");
      setMessage("That doesn't look like a Google API key — it starts with “AIza”.");
      return;
    }
    setState("checking");
    setMessage("Checking…");
    let cancelled = false;
    const t = window.setTimeout(async () => {
      try {
        const note = await ipc.verifyYoutubeApiKey(trimmed);
        if (cancelled) return;
        await ipc.setYoutubeApiKey(trimmed);
        if (cancelled) return;
        setState("ok");
        setMessage(note);
        onSaved();
      } catch (e) {
        if (cancelled) return;
        setState("error");
        setMessage(`${e}`);
      }
    }, 500);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [key, onSaved]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const done = state === "ok";

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="ytkey-panel" onClick={(e) => e.stopPropagation()}>
        <div className="ytkey-head">
          <div>
            <h2>Connect YouTube</h2>
            <p className="ytkey-sub">Free · no credit card · about two minutes</p>
          </div>
          <button className="settings-close" onClick={onClose} title="Close">
            <X size={18} />
          </button>
        </div>

        <p className="ytkey-why">
          Your own key makes track matching more accurate and is the way YouTube
          asks apps to search. It stays in your system keychain.
        </p>

        <ol className="ytkey-steps">
          <li className={done ? "done" : ""}>
            <span className="ytkey-num">{done ? <Check size={14} /> : 1}</span>
            <div className="ytkey-body">
              <strong>Turn on the YouTube Data API</strong>
              <p>Sign in, pick any project (or let Google make one), press Enable.</p>
              <a className="ytkey-link" href={ENABLE_URL} target="_blank" rel="noreferrer">
                Open Google Cloud <ExternalLink size={13} />
              </a>
            </div>
          </li>

          <li className={done ? "done" : ""}>
            <span className="ytkey-num">{done ? <Check size={14} /> : 2}</span>
            <div className="ytkey-body">
              <strong>Create your key</strong>
              <p>
                Press <em>Create credentials</em> → <em>API key</em>, then copy it.
              </p>
              <a className="ytkey-link" href={CREDENTIALS_URL} target="_blank" rel="noreferrer">
                Open Credentials <ExternalLink size={13} />
              </a>
            </div>
          </li>

          <li className={done ? "done" : ""}>
            <span className="ytkey-num">{done ? <Check size={14} /> : 3}</span>
            <div className="ytkey-body">
              <strong>Paste it here</strong>
              <p>It checks and saves itself — there's nothing else to press.</p>
              <input
                ref={inputRef}
                className={`ytkey-input ${state}`}
                type="text"
                spellCheck={false}
                autoFocus
                placeholder="AIza…"
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
              {message && (
                <p className={`ytkey-status ${state}`}>
                  {state === "checking" && <Loader2 size={13} className="ytkey-spin" />}
                  {state === "ok" && <Check size={13} />}
                  {message}
                </p>
              )}
            </div>
          </li>
        </ol>

        <div className="ytkey-foot">
          <button className="ytkey-skip" onClick={onClose}>
            {done ? "Close" : "Skip for now"}
          </button>
          {done && (
            <button className="ytkey-done" onClick={onClose}>
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
