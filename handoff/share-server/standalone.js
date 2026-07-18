/**
 * Standalone share server for local testing — zero dependencies (node:http).
 *
 *   node standalone.js            # listens on http://localhost:3001
 *   PORT=4000 node standalone.js
 *
 * Uses the in-memory store. With RESEND_API_KEY unset it LOGS the would-be
 * email (including the share link) to the console instead of sending, so the
 * whole desktop → server → landing page → .mpx download loop can be tested
 * offline. Point the MusicPax app at it via Settings → Sharing →
 * http://localhost:3001.
 */

"use strict";

const http = require("node:http");
const {
  handleShare,
  handleLanding,
  handleMpxDownload,
  resolveConfig,
} = require("./share");

const PORT = Number(process.env.PORT || 3001);
const MAX_BODY = 1_000_000; // 1 MB, same as the express json limit

const cfg = resolveConfig({
  baseUrl: process.env.SHARE_BASE_URL || `http://localhost:${PORT}`,
  devLogEmail: !process.env.RESEND_API_KEY,
});

function send(res, out) {
  res.writeHead(out.status, out.headers);
  res.end(out.body);
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        resolve({ tooLarge: true });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve({ body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      } catch {
        resolve({ malformed: true });
      }
    });
    req.on("error", () => resolve({ malformed: true }));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const ip = req.socket.remoteAddress || "unknown";
  try {
    if (req.method === "POST" && url.pathname === "/api/share") {
      const parsed = await readJsonBody(req);
      if (parsed.tooLarge) {
        return send(res, {
          status: 413,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ error: { code: "too_large", message: "Playlist too large (limit 1 MB)." } }),
        });
      }
      if (parsed.malformed) {
        return send(res, {
          status: 400,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ error: { code: "bad_request", message: "Malformed JSON body." } }),
        });
      }
      return send(res, await handleShare(parsed.body, ip, cfg));
    }

    let m = url.pathname.match(/^\/api\/share\/([^/]+)\.mpx$/);
    if (req.method === "GET" && m) {
      return send(res, await handleMpxDownload(m[1], ip, cfg));
    }
    m = url.pathname.match(/^\/share\/([^/]+)$/);
    if (req.method === "GET" && m) {
      return send(res, await handleLanding(m[1], ip, cfg));
    }

    send(res, {
      status: 404,
      headers: { "content-type": "text/plain" },
      body: "MusicPax share server (standalone). Endpoints: POST /api/share, GET /share/:id, GET /api/share/:id.mpx",
    });
  } catch (e) {
    send(res, {
      status: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: { code: "internal", message: String(e?.message ?? e) } }),
    });
  }
});

server.listen(PORT, () => {
  console.log(`MusicPax share server (standalone) → http://localhost:${PORT}`);
  console.log(`Email: ${process.env.RESEND_API_KEY ? "Resend (real sends)" : "dev mode — emails are printed here, not sent"}`);
  console.log(`Storage: in-memory (shares vanish on restart)\n`);
});
