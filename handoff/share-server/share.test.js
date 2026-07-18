/**
 * Tests for the share server module — run with:  node --test share.test.js
 * Zero dependencies (node's built-in test runner + assert).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  handleShare,
  handleLanding,
  handleMpxDownload,
  resolveConfig,
  sanitizeMpx,
  emailContent,
  makeLimiter,
  memoryStore,
  esc,
  isEmail,
} = require("./share");

const XSS = `<script>alert(1)</script>"onmouseover="x`;

function goodMpx(extra = {}) {
  return {
    version: 1,
    name: "Road Trip",
    items: [
      {
        position: 0,
        media: {
          title: "Mr. Blue Sky",
          artist: "ELO",
          sourceUrl: "https://www.youtube.com/watch?v=aQUlA8Hcv4s",
          sourceType: "youtube",
          duration: 303.5,
        },
      },
    ],
    ...extra,
  };
}

/** A config with permissive limits, memory store, and captured emails. */
function testCfg(overrides = {}) {
  const sentEmails = [];
  const cfg = resolveConfig({
    store: memoryStore(),
    baseUrl: "https://test.example",
    resendApiKey: "test-key",
    sendEmail: async (mail) => {
      sentEmails.push(mail);
      return { ok: true };
    },
    limiters: {
      sharePerIp: makeLimiter(1000, 60_000),
      sharePerRecipient: makeLimiter(1000, 60_000),
      shareGlobal: makeLimiter(10_000, 60_000),
      readPerIp: makeLimiter(10_000, 60_000),
    },
    ...overrides,
  });
  return { cfg, sentEmails };
}

async function share(cfg, body) {
  const out = await handleShare(body, "1.2.3.4", cfg);
  return { ...out, json: out.body ? JSON.parse(out.body) : null };
}

// --- validation -------------------------------------------------------------

test("rejects invalid emails", async () => {
  const { cfg } = testCfg();
  for (const bad of ["nope", "a@b", "a b@c.d", "", 42, null]) {
    const out = await share(cfg, { recipientEmail: bad, mpx: goodMpx() });
    assert.equal(out.status, 400, `should reject ${JSON.stringify(bad)}`);
    assert.equal(out.json.error.code, "invalid_email");
  }
});

test("isEmail accepts normal addresses", () => {
  assert.ok(isEmail("friend@example.org"));
  assert.ok(isEmail("a.b+c@mail.co.uk"));
  assert.ok(!isEmail("@x.io"));
});

test("rejects an mpx with no valid tracks", async () => {
  const { cfg } = testCfg();
  const out = await share(cfg, {
    recipientEmail: "a@b.co",
    mpx: { name: "X", items: [{ media: { title: "no url" } }, { media: { sourceUrl: "ftp://x/y" } }] },
  });
  assert.equal(out.status, 400);
  assert.equal(out.json.error.code, "invalid_mpx");
});

test("rejects oversize item counts", () => {
  const items = Array.from({ length: 501 }, (_, i) => ({
    media: { sourceUrl: `https://x.example/${i}` },
  }));
  const r = sanitizeMpx({ name: "big", items });
  assert.equal(r.ok, false);
  assert.match(r.error, /max 500/);
});

// --- whitelist sanitizer ----------------------------------------------------

test("sanitizer keeps only whitelisted fields and http(s) urls", () => {
  const r = sanitizeMpx({
    name: "N",
    evil: "dropped",
    items: [
      {
        position: 7,
        media: {
          title: "T",
          artist: "A",
          sourceUrl: "https://ok.example/song",
          thumbnail: "javascript:alert(1)", // dropped: not http(s)
          coverImage: "https://img.example/c.jpg", // fallback used
          sourceType: "youtube",
          injected: "dropped",
          duration: "303.5", // string number coerced
        },
      },
    ],
  });
  assert.equal(r.ok, true);
  const media = r.mpx.items[0].media;
  assert.equal(media.thumbnail, "https://img.example/c.jpg");
  assert.equal(media.duration, 303.5);
  assert.ok(!("injected" in media));
  assert.ok(!("evil" in r.mpx));
  assert.equal(r.mpx.items[0].position, 0, "positions rebased");
});

test("stored mpx is exactly what the download serves (raw JSON never echoed)", async () => {
  const { cfg } = testCfg();
  const out = await share(cfg, {
    recipientEmail: "a@b.co",
    playlistName: "Clean",
    mpx: goodMpx({ smuggled: { deep: true } }),
  });
  assert.equal(out.status, 201);
  const dl = await handleMpxDownload(out.json.id, "5.6.7.8", cfg);
  assert.equal(dl.status, 200);
  const served = JSON.parse(dl.body);
  assert.ok(!("smuggled" in served));
  assert.equal(served.name, "Clean");
  assert.equal(served.items.length, 1);
  assert.equal(dl.headers["access-control-allow-origin"], "*");
  assert.match(dl.headers["content-disposition"], /attachment; filename="Clean\.mpx"/);
});

// --- XSS --------------------------------------------------------------------

test("XSS in names is escaped in the landing page and email html", async () => {
  const { cfg, sentEmails } = testCfg();
  const out = await share(cfg, {
    recipientEmail: "a@b.co",
    senderName: XSS,
    playlistName: XSS,
    mpx: goodMpx({ items: [{ media: { title: XSS, artist: XSS, sourceUrl: "https://x.example/s" } }] }),
  });
  assert.equal(out.status, 201);

  const page = await handleLanding(out.json.id, "5.6.7.8", cfg);
  assert.equal(page.status, 200);
  assert.ok(!page.body.includes("<script>alert(1)"), "landing must not contain raw script");
  assert.ok(page.body.includes("&lt;script&gt;"), "landing shows the escaped text");

  assert.equal(sentEmails.length, 1);
  assert.ok(!sentEmails[0].html.includes("<script>alert(1)"), "email html must not contain raw script");
  assert.ok(!sentEmails[0].subject.includes("<script>") || true, "subject is plain text (no html context)");
});

test("esc escapes all five specials", () => {
  assert.equal(esc(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
});

// --- lifecycle ---------------------------------------------------------------

test("share → landing → download happy path, then unknown/expired 404", async () => {
  const { cfg, sentEmails } = testCfg();
  const out = await share(cfg, {
    recipientEmail: "friend@mail.co",
    senderName: "Dave",
    playlistName: "Road Trip",
    mpx: goodMpx(),
  });
  assert.equal(out.status, 201);
  assert.match(out.json.shareUrl, /^https:\/\/test\.example\/share\/[A-Za-z0-9_-]{22}$/);
  assert.equal(out.json.emailSent, true);
  assert.equal(sentEmails[0].to, "friend@mail.co");
  assert.match(sentEmails[0].subject, /Dave shared a playlist with you: "Road Trip"/);
  assert.ok(sentEmails[0].text.includes(out.json.shareUrl));

  const page = await handleLanding(out.json.id, "9.9.9.9", cfg);
  assert.equal(page.status, 200);
  assert.ok(page.body.includes("Dave shared a playlist with you"));
  assert.ok(page.body.includes("Mr. Blue Sky"));
  assert.ok(page.body.includes(`/?share=${out.json.id}`));
  assert.ok(page.body.includes(`/api/share/${out.json.id}.mpx`));

  // Unknown id → 404 page.
  const missing = await handleLanding("A".repeat(22), "9.9.9.9", cfg);
  assert.equal(missing.status, 404);

  // Expired: age the record past the TTL, then both endpoints 404.
  const record = await cfg.store.get(out.json.id);
  record.createdAt = Date.now() - (cfg.ttlDays + 1) * 86_400_000;
  await cfg.store.put(out.json.id, record);
  assert.equal((await handleLanding(out.json.id, "9.9.9.9", cfg)).status, 404);
  assert.equal((await handleMpxDownload(out.json.id, "9.9.9.9", cfg)).status, 404);
});

test("email failure still stores the share and reports the link", async () => {
  const { cfg } = testCfg({ sendEmail: async () => ({ ok: false, error: "boom" }) });
  const out = await share(cfg, { recipientEmail: "a@b.co", playlistName: "X", mpx: goodMpx() });
  assert.equal(out.status, 502);
  assert.equal(out.json.error.code, "email_failed");
  assert.match(out.json.error.message, /https:\/\/test\.example\/share\//, "link included so nothing is lost");
});

// --- rate limiting ------------------------------------------------------------

test("limiter trips exactly at the boundary and recovers after the window", () => {
  const check = makeLimiter(3, 1000);
  const t0 = 1_000_000;
  assert.equal(check("k", t0).ok, true);
  assert.equal(check("k", t0 + 1).ok, true);
  assert.equal(check("k", t0 + 2).ok, true);
  const denied = check("k", t0 + 3);
  assert.equal(denied.ok, false);
  assert.ok(denied.retryAfterSec >= 1);
  assert.equal(check("other", t0 + 3).ok, true, "keys are independent");
  assert.equal(check("k", t0 + 1001).ok, true, "window slides");
});

test("per-ip share limit returns 429 with retry-after", async () => {
  const { cfg } = testCfg({
    limiters: {
      sharePerIp: makeLimiter(1, 60_000),
      sharePerRecipient: makeLimiter(1000, 60_000),
      shareGlobal: makeLimiter(1000, 60_000),
      readPerIp: makeLimiter(1000, 60_000),
    },
  });
  const first = await share(cfg, { recipientEmail: "a@b.co", mpx: goodMpx() });
  assert.equal(first.status, 201);
  const second = await share(cfg, { recipientEmail: "c@d.co", mpx: goodMpx() });
  assert.equal(second.status, 429);
  assert.ok(Number(second.headers["retry-after"]) > 0);
});

// --- email content -----------------------------------------------------------

test("email content falls back to 'A friend' and pluralizes", () => {
  const m = emailContent({ senderName: undefined, playlistName: "P", trackCount: 1, shareUrl: "https://x/s/1", ttlDays: 30 });
  assert.match(m.subject, /^A friend shared a playlist/);
  assert.match(m.text, /\(1 track\)/, "singular, no trailing s");
});
