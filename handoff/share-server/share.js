/**
 * MusicPax playlist-share server module — drop-in for the musicpax.com app.
 *
 *   const { createShareRouter } = require("./share");
 *   app.use(createShareRouter());        // that's the whole integration
 *
 * Endpoints (all mounted by the router):
 *   POST /api/share            body {recipientEmail, senderName?, playlistName, mpx}
 *                              → stores sanitized .mpx, emails the link, 201 {id, shareUrl, expiresAt}
 *   GET  /share/:id            → landing page (get the app / open web app / download .mpx)
 *   GET  /api/share/:id.mpx    → the sanitized playlist JSON (CORS-open, attachment)
 *
 * Design notes:
 * - Zero npm dependencies. Express is require()d lazily ONLY inside
 *   createShareRouter, so this file also runs under plain node:http
 *   (see standalone.js) and its logic is unit-testable without installs.
 * - The stored playlist is REBUILT from a strict whitelist — the raw client
 *   JSON is never stored or served, so nothing a client sends can smuggle
 *   markup or extra fields into the landing page, the email, or the .mpx.
 * - Every HTML interpolation goes through esc(). No user-controlled markup.
 * - Rate limits are in-memory sliding windows (reset on restart — fine at
 *   this scale): per-IP, per-recipient, and a global daily cap that protects
 *   the email-provider quota.
 *
 * Environment (all optional; can also be passed as createShareRouter opts):
 *   RESEND_API_KEY    Resend key. Unset → shares still work, email is skipped
 *                     and the response says so (or logged in dev mode).
 *   SHARE_BASE_URL    Public origin for links, e.g. https://musicpax.com
 *   SHARE_FROM        From header, e.g. "MusicPax <share@send.musicpax.com>"
 *   APP_DOWNLOAD_URL  Where "Get the MusicPax app" points.
 *   SHARE_TTL_DAYS    Link lifetime (default 30).
 *   REPLIT_DB_URL     If present, shares persist in Replit's key-value DB.
 */

"use strict";

const crypto = require("node:crypto");

// --------------------------------------------------------------------------
// Small utilities
// --------------------------------------------------------------------------

/** HTML-escape — applied to EVERY value interpolated into HTML. */
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Trim, strip control characters, cap length. Returns undefined when empty. */
function cleanText(v, max) {
  if (typeof v !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, max).trim();
  return t.length ? t : undefined;
}

/** Only http(s) URLs may travel; anything else is dropped. */
function cleanUrl(v) {
  const t = cleanText(v, 2048);
  if (!t) return undefined;
  try {
    const u = new URL(t);
    if (u.protocol === "http:" || u.protocol === "https:") return t;
  } catch {
    /* not a URL */
  }
  return undefined;
}

function cleanNumber(v) {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function isEmail(v) {
  return (
    typeof v === "string" &&
    v.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim())
  );
}

function newId() {
  return crypto.randomBytes(16).toString("base64url"); // 22 chars, unguessable
}

// --------------------------------------------------------------------------
// Whitelist sanitizer — the ONLY path from client JSON to stored data
// --------------------------------------------------------------------------

const MAX_ITEMS = 500;

/**
 * Rebuild an .mpx object keeping only known fields with capped/typed values.
 * Returns { ok:true, mpx, trackCount } or { ok:false, error }.
 */
function sanitizeMpx(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "mpx must be an object" };
  }
  const items = raw.items;
  if (!Array.isArray(items)) return { ok: false, error: "mpx.items must be an array" };
  if (items.length > MAX_ITEMS) {
    return { ok: false, error: `too many tracks (max ${MAX_ITEMS})` };
  }

  const outItems = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const m = item.media;
    if (typeof m !== "object" || m === null) continue;
    const sourceUrl = cleanUrl(m.sourceUrl);
    if (!sourceUrl) continue; // a track without a playable URL is meaningless
    const media = {
      title: cleanText(m.title, 512),
      artist: cleanText(m.artist, 512),
      album: cleanText(m.album, 512),
      year: cleanNumber(m.year),
      thumbnail: cleanUrl(m.thumbnail) ?? cleanUrl(m.coverImage),
      sourceUrl,
      sourceType: cleanText(m.sourceType, 32),
      category: cleanText(m.category, 128),
      duration: cleanNumber(m.duration),
    };
    // Drop undefined keys so the stored JSON is tight.
    for (const k of Object.keys(media)) if (media[k] === undefined) delete media[k];
    outItems.push({ position: outItems.length, media });
  }
  if (outItems.length === 0) {
    return { ok: false, error: "no shareable tracks (every item lacked a valid URL)" };
  }

  const mpx = {
    version: 1,
    name: cleanText(raw.name, 200) ?? "Shared playlist",
    items: outItems,
  };
  const description = cleanText(raw.description, 500);
  if (description) mpx.description = description;
  return { ok: true, mpx, trackCount: outItems.length };
}

// --------------------------------------------------------------------------
// Rate limiting — in-memory sliding windows
// --------------------------------------------------------------------------

/** makeLimiter(max, windowMs) → check(key, now?) → {ok} | {ok:false, retryAfterSec} */
function makeLimiter(max, windowMs) {
  const hits = new Map(); // key → [timestamps]
  return function check(key, now = Date.now()) {
    let list = hits.get(key);
    if (!list) hits.set(key, (list = []));
    while (list.length && now - list[0] >= windowMs) list.shift();
    if (list.length >= max) {
      return { ok: false, retryAfterSec: Math.ceil((list[0] + windowMs - now) / 1000) };
    }
    list.push(now);
    // Opportunistic GC so long-running processes don't accumulate dead keys.
    if (hits.size > 10_000) {
      for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
    }
    return { ok: true };
  };
}

// --------------------------------------------------------------------------
// Stores — { put(id, record), get(id) } (async)
// --------------------------------------------------------------------------

function memoryStore() {
  const m = new Map();
  return {
    kind: "memory",
    async put(id, record) {
      m.set(id, record);
    },
    async get(id) {
      return m.get(id) ?? null;
    },
  };
}

/** Replit key-value DB over its REST URL — survives the ephemeral filesystem. */
function replitDbStore(dbUrl) {
  const key = (id) => `share:${id}`;
  return {
    kind: "replit-db",
    async put(id, record) {
      const body = `${encodeURIComponent(key(id))}=${encodeURIComponent(JSON.stringify(record))}`;
      const r = await fetch(dbUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!r.ok) throw new Error(`replit db write failed: HTTP ${r.status}`);
    },
    async get(id) {
      const r = await fetch(`${dbUrl}/${encodeURIComponent(key(id))}`);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`replit db read failed: HTTP ${r.status}`);
      const text = await r.text();
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    },
  };
}

// --------------------------------------------------------------------------
// Email (Resend) — one fetch, no SDK
// --------------------------------------------------------------------------

function emailContent({ senderName, playlistName, trackCount, shareUrl, ttlDays }) {
  const who = senderName || "A friend";
  const subject = `${who} shared a playlist with you: "${playlistName}"`;
  const text = [
    `${who} shared the playlist "${playlistName}" (${trackCount} track${trackCount === 1 ? "" : "s"}) with you on MusicPax.`,
    ``,
    `Listen here: ${shareUrl}`,
    ``,
    `You're receiving this because someone entered your address in the MusicPax app.`,
    `No account was created for you. If this wasn't meant for you, just ignore it.`,
    `The link expires in ${ttlDays} days.`,
  ].join("\n");
  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#101014;color:#e8e8ec;padding:32px">
  <div style="max-width:480px;margin:0 auto;background:#17171c;border:1px solid #2a2a32;border-radius:12px;padding:28px">
    <p style="font-size:13px;letter-spacing:2px;color:#8a8a94;margin:0 0 16px">MUSICPAX</p>
    <h1 style="font-size:18px;margin:0 0 6px">${esc(who)} shared a playlist with you</h1>
    <p style="font-size:15px;color:#c9c9d1;margin:0 0 20px">&ldquo;${esc(playlistName)}&rdquo; &mdash; ${trackCount} track${trackCount === 1 ? "" : "s"}</p>
    <p style="margin:0 0 24px"><a href="${esc(shareUrl)}" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;padding:10px 22px;border-radius:8px;font-size:14px">Listen on MusicPax</a></p>
    <p style="font-size:12px;color:#8a8a94;margin:0 0 6px">Or copy this link: ${esc(shareUrl)}</p>
    <p style="font-size:11px;color:#6a6a74;margin:16px 0 0">You're receiving this because someone entered your address in the MusicPax app. No account was created. If this wasn't meant for you, just ignore it. The link expires in ${ttlDays} days.</p>
  </div></body></html>`;
  return { subject, text, html };
}

async function sendViaResend({ apiKey, from, to, subject, text, html }) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ from, to: [to], subject, text, html }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    return { ok: false, error: `Resend HTTP ${r.status}: ${body.slice(0, 200)}` };
  }
  return { ok: true };
}

// --------------------------------------------------------------------------
// HTML pages
// --------------------------------------------------------------------------

const PAGE_STYLE = `body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#101014;color:#e8e8ec;margin:0;padding:40px 16px}
.card{max-width:520px;margin:0 auto;background:#17171c;border:1px solid #2a2a32;border-radius:14px;padding:32px}
.brand{font-size:13px;letter-spacing:3px;color:#8a8a94;margin:0 0 18px}
h1{font-size:20px;margin:0 0 4px}.sub{color:#c9c9d1;font-size:15px;margin:0 0 22px}
.tracks{list-style:none;padding:0;margin:0 0 24px;border-top:1px solid #2a2a32}
.tracks li{padding:8px 2px;border-bottom:1px solid #22222a;font-size:13px;color:#c9c9d1}
.tracks .more{color:#8a8a94;font-style:italic}
.cta{display:block;text-align:center;text-decoration:none;border-radius:9px;padding:12px 18px;font-size:15px;margin-bottom:10px}
.cta.primary{background:#3b82f6;color:#fff}.cta.secondary{background:#22222a;color:#e8e8ec;border:1px solid #34343e}
.dl{display:block;text-align:center;font-size:13px;color:#8a8a94;margin-top:14px}
.note{font-size:11px;color:#6a6a74;margin-top:20px;text-align:center}`;

function landingPage({ record, id, baseUrl, downloadUrl, ttlDays }) {
  const who = record.senderName || "A friend";
  const tracks = (record.mpx.items || []).slice(0, 10);
  const rest = (record.mpx.items || []).length - tracks.length;
  const rows = tracks
    .map((it) => {
      const t = it.media?.title || "Untitled";
      const a = it.media?.artist;
      return `<li>${esc(t)}${a ? ` <span style="color:#8a8a94">&mdash; ${esc(a)}</span>` : ""}</li>`;
    })
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(record.playlistName)} — shared on MusicPax</title>
<style>${PAGE_STYLE}</style></head><body><div class="card">
<p class="brand">MUSICPAX</p>
<h1>${esc(who)} shared a playlist with you</h1>
<p class="sub">&ldquo;${esc(record.playlistName)}&rdquo; &mdash; ${record.trackCount} track${record.trackCount === 1 ? "" : "s"}</p>
<ul class="tracks">${rows}${rest > 0 ? `<li class="more">&hellip;and ${rest} more</li>` : ""}</ul>
<a class="cta primary" href="${esc(downloadUrl)}">Get the MusicPax app</a>
<a class="cta secondary" href="${esc(`${baseUrl}/?share=${id}`)}">Open in MusicPax web</a>
<a class="dl" href="${esc(`/api/share/${id}.mpx`)}" download>Download the playlist file (.mpx) &mdash; import it in the MusicPax app</a>
<p class="note">This link expires ${ttlDays} days after it was shared.</p>
</div></body></html>`;
}

function notFoundPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Share not found — MusicPax</title>
<style>${PAGE_STYLE}</style></head><body><div class="card">
<p class="brand">MUSICPAX</p><h1>This share link isn't available</h1>
<p class="sub">It may have expired (links last a limited time) or the address is wrong.</p>
</div></body></html>`;
}

// --------------------------------------------------------------------------
// Transport-agnostic handlers → { status, headers, body }
// --------------------------------------------------------------------------

function resolveConfig(opts = {}) {
  const env = process.env;
  const baseUrl = (opts.baseUrl ?? env.SHARE_BASE_URL ?? "https://musicpax.com").replace(/\/+$/, "");
  return {
    baseUrl,
    fromAddress: opts.fromAddress ?? env.SHARE_FROM ?? "MusicPax <onboarding@resend.dev>",
    resendApiKey: opts.resendApiKey ?? env.RESEND_API_KEY ?? "",
    downloadUrl: opts.downloadUrl ?? env.APP_DOWNLOAD_URL ?? `${baseUrl}/#download`,
    ttlDays: Number(opts.ttlDays ?? env.SHARE_TTL_DAYS ?? 30) || 30,
    devLogEmail: opts.devLogEmail ?? false,
    store:
      opts.store ??
      (env.REPLIT_DB_URL ? replitDbStore(env.REPLIT_DB_URL) : memoryStore()),
    limiters: opts.limiters ?? {
      sharePerIp: makeLimiter(10, 60 * 60 * 1000),
      sharePerRecipient: makeLimiter(5, 24 * 60 * 60 * 1000),
      shareGlobal: makeLimiter(200, 24 * 60 * 60 * 1000),
      readPerIp: makeLimiter(120, 60 * 60 * 1000),
    },
    sendEmail: opts.sendEmail ?? sendViaResend,
  };
}

function jsonError(status, code, message, extraHeaders = {}) {
  return {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify({ error: { code, message } }),
  };
}

/** POST /api/share */
async function handleShare(body, ip, cfg) {
  const limited =
    !cfg.limiters.shareGlobal("global").ok
      ? { retryAfterSec: 3600 }
      : (() => {
          const perIp = cfg.limiters.sharePerIp(ip || "unknown");
          if (!perIp.ok) return perIp;
          return null;
        })();
  if (limited) {
    return jsonError(429, "rate_limited", "Too many shares right now — try again later.", {
      "retry-after": String(limited.retryAfterSec ?? 3600),
    });
  }

  if (typeof body !== "object" || body === null) {
    return jsonError(400, "bad_request", "Body must be JSON.");
  }
  const recipient = typeof body.recipientEmail === "string" ? body.recipientEmail.trim() : "";
  if (!isEmail(recipient)) {
    return jsonError(400, "invalid_email", "recipientEmail is not a valid email address.");
  }
  const perRecipient = cfg.limiters.sharePerRecipient(recipient.toLowerCase());
  if (!perRecipient.ok) {
    return jsonError(429, "rate_limited", "That address has received several shares today — try again tomorrow.", {
      "retry-after": String(perRecipient.retryAfterSec),
    });
  }

  const senderName = cleanText(body.senderName, 80);
  const playlistName =
    cleanText(body.playlistName, 200) ?? cleanText(body.mpx?.name, 200) ?? "Shared playlist";
  const sanitized = sanitizeMpx(body.mpx);
  if (!sanitized.ok) return jsonError(400, "invalid_mpx", `Invalid playlist: ${sanitized.error}`);
  // Keep the landing page and the file consistent with the display name.
  sanitized.mpx.name = playlistName;

  const id = newId();
  const record = {
    mpx: sanitized.mpx,
    playlistName,
    senderName: senderName ?? null,
    trackCount: sanitized.trackCount,
    createdAt: Date.now(),
  };
  try {
    await cfg.store.put(id, record);
  } catch (e) {
    return jsonError(502, "storage_failed", `Could not store the share: ${e.message ?? e}`);
  }

  const shareUrl = `${cfg.baseUrl}/share/${id}`;
  const mail = emailContent({
    senderName,
    playlistName,
    trackCount: sanitized.trackCount,
    shareUrl,
    ttlDays: cfg.ttlDays,
  });

  let emailSent = false;
  if (cfg.resendApiKey) {
    const sent = await cfg.sendEmail({
      apiKey: cfg.resendApiKey,
      from: cfg.fromAddress,
      to: recipient,
      ...mail,
    });
    if (!sent.ok) {
      // The share exists and the link works — tell the client the email part failed.
      return jsonError(502, "email_failed", `Stored the share, but sending the email failed (${sent.error}). Link: ${shareUrl}`);
    }
    emailSent = true;
  } else if (cfg.devLogEmail) {
    console.log(`\n--- share email (dev mode, not sent) ---\nTo: ${recipient}\nSubject: ${mail.subject}\n${mail.text}\n----------------------------------------\n`);
    emailSent = true; // dev parity: the flow continues as if sent
  }

  const expiresAt = new Date(record.createdAt + cfg.ttlDays * 86_400_000).toISOString();
  return {
    status: 201,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, shareUrl, expiresAt, emailSent }),
  };
}

async function loadRecord(id, cfg) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(id))) return null;
  let record;
  try {
    record = await cfg.store.get(id);
  } catch {
    return null;
  }
  if (!record || typeof record !== "object") return null;
  const age = Date.now() - (record.createdAt ?? 0);
  if (age > cfg.ttlDays * 86_400_000) return null; // expired (TTL enforced on read)
  return record;
}

/** GET /share/:id */
async function handleLanding(id, ip, cfg) {
  if (!cfg.limiters.readPerIp(ip || "unknown").ok) {
    return { status: 429, headers: { "content-type": "text/html; charset=utf-8", "retry-after": "60" }, body: notFoundPage() };
  }
  const record = await loadRecord(id, cfg);
  if (!record) {
    return { status: 404, headers: { "content-type": "text/html; charset=utf-8" }, body: notFoundPage() };
  }
  return {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    body: landingPage({ record, id, baseUrl: cfg.baseUrl, downloadUrl: cfg.downloadUrl, ttlDays: cfg.ttlDays }),
  };
}

/** GET /api/share/:id.mpx */
async function handleMpxDownload(id, ip, cfg) {
  if (!cfg.limiters.readPerIp(ip || "unknown").ok) {
    return jsonError(429, "rate_limited", "Too many requests.", { "retry-after": "60" });
  }
  const record = await loadRecord(id, cfg);
  if (!record) return jsonError(404, "not_found", "Share not found or expired.");
  const filename = (record.playlistName || "playlist").replace(/[^\w \-().]/g, "_").slice(0, 80);
  return {
    status: 200,
    headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="${filename}.mpx"`,
      "access-control-allow-origin": "*", // read-only public data; lets the web app fetch it
      "cache-control": "no-store",
    },
    body: JSON.stringify(record.mpx, null, 2),
  };
}

// --------------------------------------------------------------------------
// Express adapter — the two-line paste-in
// --------------------------------------------------------------------------

function createShareRouter(opts = {}) {
  // Lazy so this module works (and tests run) without express installed.
  let express;
  try {
    // eslint-disable-next-line global-require
    express = require("express");
  } catch {
    throw new Error(
      "createShareRouter needs express. In a non-express app, wire handleShare/handleLanding/handleMpxDownload to your framework instead (see standalone.js for a plain node:http example).",
    );
  }
  const cfg = resolveConfig(opts);
  if (!cfg.resendApiKey) {
    console.warn("[share] RESEND_API_KEY not set — shares will be created but no email will be sent.");
  }
  if (cfg.store.kind === "memory") {
    console.warn("[share] Using in-memory share storage — shares are lost on restart. Set REPLIT_DB_URL (or pass a store) for persistence.");
  }

  const send = (res, out) => res.status(out.status).set(out.headers).send(out.body);
  const ipOf = (req) => req.ip || req.socket?.remoteAddress || "unknown";
  const router = express.Router();

  router.post("/api/share", express.json({ limit: "1mb" }), async (req, res) => {
    try {
      send(res, await handleShare(req.body, ipOf(req), cfg));
    } catch (e) {
      send(res, jsonError(500, "internal", `Unexpected error: ${e.message ?? e}`));
    }
  });
  // Body-parser errors (oversize/malformed JSON) → clean 413/400 instead of a stack page.
  router.use("/api/share", (err, _req, res, _next) => {
    const status = err?.status === 413 ? 413 : 400;
    send(res, jsonError(status, status === 413 ? "too_large" : "bad_request", status === 413 ? "Playlist too large (limit 1 MB)." : "Malformed JSON body."));
  });

  router.get("/share/:id", async (req, res) => {
    send(res, await handleLanding(req.params.id, ipOf(req), cfg));
  });
  // Regex route (not "/api/share/:id.mpx"): Express 5's path parser no longer
  // supports a param followed by a literal in the same segment; a regex path
  // works on both Express 4 and 5. Ids are base64url, so [A-Za-z0-9_-] covers them.
  router.get(/^\/api\/share\/([A-Za-z0-9_-]+)\.mpx$/, async (req, res) => {
    send(res, await handleMpxDownload(req.params[0], ipOf(req), cfg));
  });
  return router;
}

module.exports = {
  createShareRouter,
  // Transport-agnostic pieces (used by standalone.js and the tests):
  handleShare,
  handleLanding,
  handleMpxDownload,
  resolveConfig,
  sanitizeMpx,
  emailContent,
  landingPage,
  notFoundPage,
  makeLimiter,
  memoryStore,
  replitDbStore,
  esc,
  isEmail,
};
