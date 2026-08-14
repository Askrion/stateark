import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0000:0000:0000:0000:0000:0000:0000:0001"]);

/** Comparison that does not leak the key length or contents through timing. */
export function secretEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) {
    // still burn a comparison so the branch is not measurably faster
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/**
 * Resolve the access key.
 * 1. STATEARK_ACCESS_KEY if set.
 * 2. otherwise a persistent random key in <root>/.access-key, created on first run.
 * Never silently falls back to a guessable default.
 */
export function loadAccessKey(root: string): { key: string; source: "env" | "file" | "generated" } {
  const fromEnv = process.env.STATEARK_ACCESS_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: "env" };

  const file = path.join(root, ".access-key");
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing.length >= 16) return { key: existing, source: "file" };
  } catch { /* create below */ }

  const key = randomBytes(24).toString("base64url");
  mkdirSync(root, { recursive: true });
  writeFileSync(file, key + "\n", { mode: 0o600 });
  return { key, source: "generated" };
}

export function isLoopbackHostname(h: string): boolean {
  return LOOPBACK.has(h.toLowerCase());
}

function splitHost(hostHeader: string): string {
  const h = hostHeader.trim();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1).toLowerCase(); // [::1]:8787
  return h.replace(/:\d+$/, "").toLowerCase();
}

/**
 * DNS-rebinding protection. A browser can be pointed at http://evil.example
 * which resolves to 127.0.0.1; the Host header still says evil.example.
 */
export function hostAllowed(hostHeader: string | undefined, extraHosts: string[]): boolean {
  if (!hostHeader) return false;
  const host = splitHost(hostHeader);
  return isLoopbackHostname(host) || extraHosts.includes(host);
}

/**
 * Origin check. Native MCP clients send no Origin header, which is fine.
 * A browser always sends one, so any web page is rejected unless explicitly allowed.
 */
export function originAllowed(origin: string | undefined, extraOrigins: string[]): boolean {
  if (!origin || origin === "null") return true;
  if (extraOrigins.includes(origin.toLowerCase())) return true;
  try {
    return isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Single-use CSRF tokens for the local upload page. */
export class CsrfStore {
  private tokens = new Map<string, number>();
  constructor(private ttlMs = 30 * 60 * 1000) {}

  issue(): string {
    this.prune();
    const t = randomBytes(18).toString("base64url");
    this.tokens.set(t, Date.now() + this.ttlMs);
    return t;
  }

  consume(t: string | null | undefined): boolean {
    this.prune();
    if (!t) return false;
    const exp = this.tokens.get(t);
    if (exp === undefined) return false;
    this.tokens.delete(t);
    return exp > Date.now();
  }

  private prune() {
    const now = Date.now();
    for (const [t, exp] of this.tokens) if (exp <= now) this.tokens.delete(t);
    if (this.tokens.size > 500) {
      const excess = this.tokens.size - 500;
      let i = 0;
      for (const t of this.tokens.keys()) { if (i++ >= excess) break; this.tokens.delete(t); }
    }
  }
}
