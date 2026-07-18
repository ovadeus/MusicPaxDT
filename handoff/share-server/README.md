# MusicPax Share Server — drop-in for musicpax.com (Replit)

Adds "share a playlist by email" to the MusicPax web app. The desktop app
POSTs a playlist here as `.mpx`; this module stores it, emails the friend a
link, and serves a landing page with three ways in:

1. **Get the MusicPax app** (download link)
2. **Open in MusicPax web** (`/?share=<id>` on your site)
3. **Download the `.mpx` file** (imports via the desktop app's Import .mpx)

Files: `share.js` (the module), `standalone.js` (local test server),
`share.test.js` (tests: `node --test share.test.js`), this README.

Zero npm dependencies beyond Express (which your app already has if it's an
Express app). Node 18+ (uses built-in `fetch`).

---

## 1. Paste-in (Express app)

Copy `share.js` into your Replit project (e.g. `server/share.js`) and add:

```js
const { createShareRouter } = require("./share");
app.use(createShareRouter()); // POST /api/share, GET /share/:id, GET /api/share/:id.mpx
```

If your app is ESM (`"type": "module"` in package.json), use:

```js
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createShareRouter } = require("./share.js");
```

**Before pasting, check for route collisions**: grep your app for existing
`/share` or `/api/share` routes. If they exist, mount under a prefix instead:
`app.use("/px", createShareRouter({ baseUrl: "https://musicpax.com/px" }))`.

**Behind Replit's proxy**, add `app.set("trust proxy", 1)` so rate limits see
real client IPs instead of the proxy's.

**Not Express?** The three handlers (`handleShare`, `handleLanding`,
`handleMpxDownload`) are plain async functions returning
`{status, headers, body}` — wire them to any framework; `standalone.js` shows
a complete plain-`node:http` example.

## 2. Environment variables (Replit → Secrets)

| Var | Required | Example | Notes |
|---|---|---|---|
| `RESEND_API_KEY` | for email | `re_…` | Without it, shares still work but no email is sent. |
| `SHARE_BASE_URL` | recommended | `https://musicpax.com` | Public origin used in links. |
| `SHARE_FROM` | after DNS | `MusicPax <share@send.musicpax.com>` | Until your domain is verified, leave unset (uses `onboarding@resend.dev`). |
| `APP_DOWNLOAD_URL` | recommended | `https://musicpax.com/download` | Where "Get the MusicPax app" points. Placeholder `#download` otherwise. |
| `SHARE_TTL_DAYS` | optional | `30` | Link lifetime. |
| `REPLIT_DB_URL` | for persistence | (auto in workspace) | See Storage below. |

## 3. Storage — IMPORTANT on Replit

Replit **Deployments have an ephemeral filesystem AND don't automatically get
`REPLIT_DB_URL`**. Without it this module falls back to in-memory storage and
**every deploy/restart deletes all share links** (it warns at startup).

Fix: in your Replit workspace, copy the value of `REPLIT_DB_URL` (run
`echo $REPLIT_DB_URL` in the shell) into your **Deployment secrets** under the
same name. Shares then persist in Replit's key-value DB (`share:<id>` keys).

If you'd rather use your app's existing database, pass a custom store:

```js
app.use(createShareRouter({
  store: {
    async put(id, record) { /* INSERT INTO shares (id, json) … */ },
    async get(id)        { /* SELECT json FROM shares WHERE id=… */ },
  },
}));
```

## 4. Email — Resend setup

1. Sign up at resend.com (free tier: 100 emails/day) → create an API key →
   set `RESEND_API_KEY`.
2. **Test mode caveat:** until you verify a domain, Resend only delivers
   from `onboarding@resend.dev` **to your own account email**. That's enough
   to test the full flow end-to-end by sharing to yourself.
3. To email real recipients: Resend → Domains → Add `send.musicpax.com` →
   add the DKIM/SPF records it shows to your DNS → once verified, set
   `SHARE_FROM="MusicPax <share@send.musicpax.com>"`.
4. First real-recipient test: check the spam folder — a fresh sending
   subdomain warms up over the first few dozen sends.

## 5. Web-app hook ("Open in MusicPax web")

The landing page's second button links to `SHARE_BASE_URL/?share=<id>`.
Add this to your web app's startup:

```js
const shareId = new URLSearchParams(location.search).get("share");
if (shareId) {
  fetch(`/api/share/${encodeURIComponent(shareId)}.mpx`)
    .then((r) => { if (!r.ok) throw new Error("Share not found or expired"); return r.json(); })
    .then((mpx) => {
      // mpx = { version, name, description?, items: [{ position, media: {
      //   title?, artist?, album?, year?, thumbnail?, sourceUrl, sourceType?,
      //   category?, duration? } }] }
      // → feed into your existing playlist-import path.
      importSharedPlaylist(mpx);
    })
    .catch((e) => showToast(String(e)));
}
```

The `.mpx` endpoint is CORS-open (read-only public data), so this also works
from a different origin during development.

## 6. Desktop app

Nothing to configure — the MusicPax desktop app posts to
`https://musicpax.com/api/share` by default. For testing against a local
server, set Settings → Sharing → Share server to `http://localhost:3001`.

## 7. Smoke tests

```bash
# Local: run the standalone server (no installs needed)
node standalone.js

# Create a share (email is printed to the console in dev mode)
curl -s -X POST localhost:3001/api/share -H 'content-type: application/json' -d '{
  "recipientEmail": "you@example.com",
  "senderName": "Dave",
  "playlistName": "Smoke Test",
  "mpx": { "name": "Smoke Test", "items": [ { "position": 0, "media": {
    "title": "Mr. Blue Sky", "artist": "ELO",
    "sourceUrl": "https://www.youtube.com/watch?v=aQUlA8Hcv4s",
    "sourceType": "youtube", "duration": 303 } } ] }
}'
# → {"id":"…","shareUrl":"http://localhost:3001/share/…","expiresAt":"…","emailSent":true}

open "http://localhost:3001/share/<id>"          # landing page
curl -s "localhost:3001/api/share/<id>.mpx"      # the sanitized playlist JSON
```

Same curls against production (swap the origin) once deployed.

## 8. Security properties (what's already handled)

- **Stored XSS:** the stored playlist is rebuilt from a strict field whitelist
  (raw client JSON is never stored or served); every HTML interpolation is
  escaped. URLs must be http(s) — `javascript:` etc. are dropped.
- **Spam/abuse:** per-IP (10/hr), per-recipient (5/day), and global (200/day —
  protects your Resend quota) rate limits; 1 MB body cap; ≤500 tracks.
  Limits are in-memory (reset on restart) — fine at this scale.
- **Unguessable links:** 128-bit random ids (base64url), `noindex` on the
  landing page, TTL enforced on read (default 30 days).
- **No accounts, no PII stored** beyond the sender's display name inside the
  share record; recipient emails are used for sending + rate limiting only
  (never stored in the share record).

## 9. Deploy checklist

- [ ] `share.js` pasted, router mounted, no route collisions
- [ ] `app.set("trust proxy", 1)` (Express behind Replit's proxy)
- [ ] `REPLIT_DB_URL` copied into Deployment secrets (or custom store wired)
- [ ] `RESEND_API_KEY` + `SHARE_BASE_URL` set
- [ ] Share-to-yourself works end-to-end (email → landing → both buttons)
- [ ] Web app handles `/?share=<id>`
- [ ] After DNS verification: `SHARE_FROM` set, real-recipient test (check spam)
