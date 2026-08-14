import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { LocalStore } from "./local-store.js";
import { SupabaseSync } from "./cloud-sync.js";
import { createStateArkServer, STATEARK_VERSION } from "./mcp.js";
import {
  CsrfStore, escapeHtml, hostAllowed, isLoopbackHostname, loadAccessKey, originAllowed, secretEquals,
} from "./security.js";

// --------------------------------------------------------------------- config

const PORT = Number(process.env.PORT ?? 8787);
const BIND = process.env.STATEARK_BIND ?? "127.0.0.1"; // loopback only unless explicitly changed
const ROOT = process.env.STATEARK_LOCAL_ROOT?.trim() || path.join(homedir(), "StateArk");
const PUBLIC_BASE_URL = process.env.STATEARK_PUBLIC_BASE_URL?.replace(/\/$/, "") || undefined;
const MAX_UPLOAD_BYTES = Number(process.env.STATEARK_MAX_UPLOAD_BYTES ?? 100 * 1024 * 1024);

const ALLOWED_HOSTS = (process.env.STATEARK_ALLOWED_HOSTS ?? "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const ALLOWED_ORIGINS = (process.env.STATEARK_ALLOWED_ORIGINS ?? "")
  .split(",").map((s) => s.trim().toLowerCase().replace(/\/$/, "")).filter(Boolean);

const local = new LocalStore(ROOT);
await local.init();

const { key: ACCESS_KEY, source: KEY_SOURCE } = loadAccessKey(ROOT);

// Refuse to run a weak key on a non-loopback interface.
if (!isLoopbackHostname(BIND) && (ACCESS_KEY.length < 24 || ACCESS_KEY === "local-dev")) {
  console.error(
    `StateArk refuses to start: STATEARK_BIND=${BIND} is not loopback but the access key is weak.\n` +
    "Set a long random STATEARK_ACCESS_KEY (>= 24 chars) before exposing the agent.",
  );
  process.exit(1);
}
if (!isLoopbackHostname(BIND) && !ALLOWED_HOSTS.length) {
  console.warn(
    `WARNING: bound to ${BIND} without STATEARK_ALLOWED_HOSTS. ` +
    "Requests with a non-loopback Host header will be rejected.",
  );
}

const cloudEnabled = Boolean(
  process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SECRET_KEY?.trim() && process.env.STATEARK_OWNER_ID?.trim(),
);
const cloud = cloudEnabled
  ? new SupabaseSync(
      process.env.SUPABASE_URL!.trim(),
      process.env.SUPABASE_SECRET_KEY!.trim(),
      process.env.STATEARK_OWNER_ID!.trim(),
      process.env.STATEARK_STORAGE_BUCKET?.trim() || "stateark-artifacts",
    )
  : null;

const csrf = new CsrfStore();

process.on("unhandledRejection", (e) => console.error("[stateark] unhandled rejection:", e));
process.on("uncaughtException", (e) => console.error("[stateark] uncaught exception:", e));


const uploadPageUrl = PUBLIC_BASE_URL
  ? `${PUBLIC_BASE_URL}/upload/${ACCESS_KEY}`
  : `http://localhost:${PORT}/upload/${ACCESS_KEY}`;

const makeMcp = () => createStateArkServer({ local, cloud, uploadPageUrl });

// --------------------------------------------------------------------- upload

function uploadPage(token: string, msg = "", ok = true) {
  const banner = msg
    ? `<p class="${ok ? "ok" : "err"}">${escapeHtml(msg)}</p>`
    : "";
  return `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>StateArk upload</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#111}
input{width:100%;padding:10px;margin:6px 0 14px;box-sizing:border-box;border:1px solid #ccc;border-radius:6px}
button{padding:10px 16px;border:0;border-radius:6px;background:#111;color:#fff;cursor:pointer}
.ok{background:#e7f6ec;padding:10px;border-radius:6px}
.err{background:#fdecea;padding:10px;border-radius:6px}
small{color:#666}
</style>
<h1>StateArk Artifact Upload</h1>
${banner}
<form method="post" enctype="multipart/form-data">
<input type="hidden" name="csrf" value="${escapeHtml(token)}">
<label>Project</label><input name="project" required>
<label>Version</label><input name="version" placeholder="v0.3" pattern="v\\d+\\.\\d+" required>
<label>File</label><input type="file" name="file" required>
<label>Note</label><input name="note">
<button type="submit">Attach locally</button>
</form>
<p><small>This page writes into your local StateArk folder only.</small></p>
</html>`;
}

function readBodyLimited(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error(`Upload exceeds ${limit} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// --------------------------------------------------------------------- server

const mcpPath = `/mcp/${ACCESS_KEY}`;
const uploadPath = `/upload/${ACCESS_KEY}`;

/** Path comparison that does not leak the key through timing. */
function pathMatches(actual: string, expectedPrefix: string, key: string): boolean {
  const parts = actual.split("/");
  if (parts.length !== 3 || `/${parts[1]}` !== expectedPrefix) return false;
  let given: string;
  try { given = decodeURIComponent(parts[2]); } catch { return false; }
  return secretEquals(given, key);
}

function securityHeaders(res: ServerResponse) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
}

const httpServer = createServer(async (req, res) => {
  try {
    if (!req.url || !req.method) return void res.writeHead(400).end();
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    securityHeaders(res);

    // DNS-rebinding + drive-by protection for every non-trivial route.
    const guarded = url.pathname !== "/health";
    if (guarded) {
      if (!hostAllowed(req.headers.host, ALLOWED_HOSTS)) {
        return void res.writeHead(403, { "content-type": "text/plain" }).end("Forbidden: Host not allowed");
      }
      if (!originAllowed(req.headers.origin, ALLOWED_ORIGINS)) {
        return void res.writeHead(403, { "content-type": "text/plain" }).end("Forbidden: Origin not allowed");
      }
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        ok: true, version: "0.5.1", mode: "local-first", root: ROOT, cloud_sync: !!cloud, bind: BIND,
      }));
    }

    // ---- upload page
    if (pathMatches(url.pathname, "/upload", ACCESS_KEY)) {
      if (req.method === "GET") {
        return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(uploadPage(csrf.issue()));
      }
      if (req.method === "POST") {
        try {
          const ct = req.headers["content-type"];
          if (!ct || !/^multipart\/form-data/i.test(ct)) throw new Error("Expected multipart/form-data");
          const body = await readBodyLimited(req, MAX_UPLOAD_BYTES);
          const form = await new Request("http://localhost/upload", {
            method: "POST",
            headers: { "content-type": ct },
            body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
          }).formData();

          if (!csrf.consume(String(form.get("csrf") ?? ""))) {
            throw new Error("Invalid or expired form token. Reload this page and try again.");
          }
          const file = form.get("file");
          if (!(file instanceof File)) throw new Error("File missing");
          const { entry } = await local.attachFile(
            String(form.get("project") ?? ""),
            String(form.get("version") ?? ""),
            file.name,
            Buffer.from(await file.arrayBuffer()),
            file.type,
            String(form.get("note") ?? ""),
          );
          return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
            .end(uploadPage(csrf.issue(), `Stored ${entry.name} locally (${entry.size_bytes} bytes).`, true));
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return void res.writeHead(400, { "content-type": "text/html; charset=utf-8" })
            .end(uploadPage(csrf.issue(), msg, false));
        }
      }
      return void res.writeHead(405).end("Method not allowed");
    }

    // ---- MCP endpoint
    if (pathMatches(url.pathname, "/mcp", ACCESS_KEY)) {
      const origin = req.headers.origin;
      if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin); // already validated above
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
      }
      if (req.method === "OPTIONS") {
        return void res.writeHead(204, {
          "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "content-type, mcp-session-id, mcp-protocol-version",
          "Access-Control-Max-Age": "600",
        }).end();
      }
      if (["POST", "GET", "DELETE"].includes(req.method)) {
        const s = makeMcp();
        const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on("close", () => { void t.close(); void s.close(); });
        await s.connect(t);
        return void await t.handleRequest(req, res);
      }
      return void res.writeHead(405).end("Method not allowed");
    }

    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
  } catch (e: unknown) {
    console.error("[stateark] request failed:", e);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end("Internal error");
  }
});

httpServer.listen(PORT, BIND, () => {
  const shown = isLoopbackHostname(BIND) ? "localhost" : BIND;
  console.log(
    `StateArk v0.5.1 local-first on http://${shown}:${PORT}\n` +
    `Root:        ${ROOT}\n` +
    `MCP:         http://${shown}:${PORT}${mcpPath}\n` +
    `Upload page: http://${shown}:${PORT}${uploadPath}\n` +
    `Access key:  ${KEY_SOURCE === "env" ? "from STATEARK_ACCESS_KEY" : `stored in ${path.join(ROOT, ".access-key")}`}\n` +
    `Cloud sync:  ${cloud ? "enabled" : "disabled (local only)"}`,
  );
});
