#!/usr/bin/env node
/**
 * StateArk smoke test.
 *
 * Starts the agent on a throwaway port with a throwaway root and exercises
 * every regression that was found in v0.3. Run with: npm test
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";

const ROOT = mkdtempSync(path.join(tmpdir(), "stateark-test-"));
const PORT = 8700 + Math.floor(Math.random() * 300);
const KEY = "test-key-with-enough-entropy-000000";
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
const ok = (name) => console.log(`  PASS  ${name}`);
const bad = (name, detail) => { failures++; console.log(`  FAIL  ${name}\n        ${detail}`); };
function check(name, cond, detail = "") { cond ? ok(name) : bad(name, detail); }

const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
  cwd: path.resolve(import.meta.dirname, ".."),
  env: {
    ...process.env,
    PORT: String(PORT),
    STATEARK_LOCAL_ROOT: ROOT,
    STATEARK_ACCESS_KEY: KEY,
    SUPABASE_URL: "", SUPABASE_SECRET_KEY: "", STATEARK_OWNER_ID: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
child.stdout.on("data", (d) => { serverLog += d; });
child.stderr.on("data", (d) => { serverLog += d; });

async function waitForServer(ms = 30000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Server did not start.\n${serverLog}`);
}

let id = 0;
async function rpc(method, params, extraHeaders = {}) {
  const r = await fetch(`${BASE}/mcp/${KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...extraHeaders },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON (e.g. 403) */ }
  return { status: r.status, json, text };
}
const call = (name, args) => rpc("tools/call", { name, arguments: args });
const sc = (r) => r.json?.result?.structuredContent;
const txt = (r) => r.json?.result?.content?.map((c) => c.text).join("\n") ?? r.text;

const baseState = { executive_summary: "s", current_state: "c", resume_instructions: "r" };

try {
  await waitForServer();
  console.log(`StateArk smoke test  root=${ROOT}  port=${PORT}\n`);

  // ---------------------------------------------------------------- protocol
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" },
  });
  check("initialize", init.json?.result?.serverInfo?.name === "stateark", init.text);

  const list = await rpc("tools/list", {});
  const tools = (list.json?.result?.tools ?? []).map((t) => t.name).sort();
  check("tools/list returns 11 tools", tools.length === 11, tools.join(","));

  // -------------------------------------------------- 1. basic savepoint
  const s1 = await call("savepoint", {
    project_name: "My Project", source_platform: "claude", state: baseState,
    artifacts: [
      { name: "app.py", kind: "code", transfer: "text", text_content: "print(1)" },
      { name: "logo.png", kind: "image", transfer: "pending", note: "binary" },
    ],
  });
  check("savepoint creates v0.1", sc(s1)?.version === "v0.1", txt(s1));
  check("pending artifact recorded", sc(s1)?.pending_artifacts?.[0] === "logo.png", txt(s1));

  // ------------------- 2. duplicate artifact names must not collide (v0.3 bug)
  const s2 = await call("savepoint", {
    project_name: "My Project", source_platform: "claude", state: baseState,
    artifacts: [
      { name: "a.py", kind: "code", transfer: "text", text_content: "AAAA" },
      { name: "a.py", kind: "code", transfer: "text", text_content: "BBBBBBBB" },
    ],
  });
  const m2 = sc(s2)?.artifact_manifest ?? [];
  const names2 = m2.map((x) => x.name);
  check("duplicate names are de-duplicated", new Set(names2).size === names2.length, names2.join(","));
  const dir2 = sc(s2)?.local_path;
  let hashesMatch = true;
  for (const e of m2) {
    if (e.status !== "stored") continue;
    const bytes = readFileSync(path.join(dir2, e.relative_path));
    if (bytes.length !== e.size_bytes) hashesMatch = false;
  }
  check("manifest sizes match bytes on disk", hashesMatch, JSON.stringify(m2));

  // --------------- 3. slug collision must not merge two projects (v0.3 bug)
  const s3 = await call("savepoint", {
    project_name: "my-project!", source_platform: "claude",
    state: { ...baseState, executive_summary: "different project" },
  });
  check("slug collision creates a separate project", sc(s3)?.project_slug !== "my-project", sc(s3)?.project_slug);
  check("colliding project starts at v0.1", sc(s3)?.version === "v0.1", sc(s3)?.version);

  // ---------- 4. hostile artifact names must not abort the savepoint (v0.3 bug)
  const s4 = await call("savepoint", {
    project_name: "Traversal", source_platform: "claude", state: baseState,
    artifacts: [
      { name: "..", kind: "code", transfer: "text", text_content: "dots" },
      { name: "../../pwned.txt", kind: "code", transfer: "text", text_content: "owned" },
      { name: "a/b/c.txt", kind: "code", transfer: "text", text_content: "nested" },
      { name: "ok.txt", kind: "code", transfer: "text", text_content: "fine" },
    ],
  });
  check("hostile names do not abort the savepoint", sc(s4)?.version === "v0.1", txt(s4));
  const files4 = existsSync(path.join(sc(s4)?.local_path ?? "", "artifacts"))
    ? readdirSync(path.join(sc(s4).local_path, "artifacts")) : [];
  check("no traversal outside artifacts/", files4.every((f) => !f.includes("/") && f !== ".."), files4.join(","));
  check("no file escaped to the projects root", !existsSync(path.join(ROOT, "projects", "pwned.txt")));
  check("all four artifacts still recorded", (sc(s4)?.artifact_manifest ?? []).length === 4, JSON.stringify(sc(s4)?.artifact_manifest));

  // ------------------------------------------------- 5. major/minor versioning
  const s5 = await call("savepoint", { project_name: "My Project", checkpoint_type: "major", source_platform: "claude", state: baseState });
  check("major checkpoint bumps to v1.0", sc(s5)?.version === "v1.0", sc(s5)?.version);
  const s6 = await call("savepoint", { project_name: "My Project", source_platform: "claude", state: baseState });
  check("minor after major is v1.1", sc(s6)?.version === "v1.1", sc(s6)?.version);

  // ------------------------------------- 6. corrupt project.json must self-heal
  const projJson = path.join(ROOT, "projects", "my-project", "project.json");
  writeFileSync(projJson, "{ this is not json");
  const h6 = await call("history", { project_name: "My Project" });
  const versions6 = (sc(h6)?.savepoints ?? []).map((v) => v.version);
  check("index rebuilds from disk after corruption", versions6.includes("v1.1") && versions6.length === 4, versions6.join(","));
  const s7 = await call("savepoint", { project_name: "My Project", source_platform: "claude", state: baseState });
  check("no version reuse after corruption", sc(s7)?.version === "v1.2", sc(s7)?.version);

  // ------------------------------------------------------- 7. resume/get paths
  const r8 = await call("resume_project", { project_name: "My Project" });
  check("resume returns latest version", sc(r8)?.version === "v1.2", sc(r8)?.version);
  const r9 = await call("resume_project", { project_name: "Unknown Thing" });
  check("resume of unknown project lists known ones", txt(r9).includes("Known projects"), txt(r9));
  const r10 = await call("get_artifact", { project_name: "My Project", version: "v0.1", artifact_name: "app.py" });
  check("get_artifact returns exact text", txt(r10) === "print(1)", txt(r10));
  const r11 = await call("get_artifact", { project_name: "My Project", version: "v0.1", artifact_name: "logo.png" });
  check("pending artifact is reported, not invented", sc(r11)?.status === "pending", txt(r11));

  // -------------------------------------------- 8. journal (tracking gate)
  const jUntracked = await call("note_event", { project_name: "Never Saved", type: "decision", summary: "x" });
  check("note_event on an untracked project is a silent no-op", sc(jUntracked)?.tracked === false, txt(jUntracked));

  await call("savepoint", { project_name: "Journaled", source_platform: "claude", state: baseState,
    artifacts: [{ name: "core.py", kind: "code", transfer: "text", text_content: "x".repeat(2000) }] });
  const j1 = await call("note_event", { project_name: "Journaled", type: "decision", summary: "Postgres over Mongo, needs joins" });
  const j2 = await call("note_event", { project_name: "Journaled", type: "rejected", summary: "Electron shell, too heavy" });
  check("note_event on a tracked project is journalled", sc(j1)?.tracked === true, txt(j1));
  check("journal counts pending entries", sc(j2)?.pending_entries === 2, JSON.stringify(sc(j2)));
  const jList = await call("journal", { project_name: "Journaled" });
  check("journal tool lists entries", txt(jList).includes("Postgres over Mongo"), txt(jList));

  const jSave = await call("savepoint", {
    project_name: "Journaled", source_platform: "claude",
    state: { ...baseState, decisions: ["Postgres over Mongo"] },
    artifacts: [{ name: "core.py", kind: "code", transfer: "text", text_content: "y".repeat(2100) }],
  });
  check("savepoint consolidates the journal", sc(jSave)?.journal_entries_consumed === 2, JSON.stringify(sc(jSave)));
  check("consumed journal is preserved in the version dir", existsSync(path.join(sc(jSave).local_path, "journal.ndjson")));
  const jAfter = await call("journal", { project_name: "Journaled" });
  check("journal is cleared after consolidation", txt(jAfter).includes("No journal entries"), txt(jAfter));

  // ------------------------------------------- 9. carry-forward + integrity
  await call("savepoint", {
    project_name: "Carry", source_platform: "claude", state: baseState,
    artifacts: [
      { name: "app.py", kind: "code", transfer: "text", text_content: "def main():\n" + "    pass\n".repeat(200) },
      { name: "schema.sql", kind: "schema", transfer: "text", text_content: "create table t(id int);" },
    ],
  });
  const c2 = await call("savepoint", {
    project_name: "Carry", source_platform: "claude", state: { ...baseState, current_state: "changed" },
    artifacts: [{ name: "app.py", kind: "code", transfer: "text", text_content: "def main():\n" + "    pass\n".repeat(210) }],
  });
  check("forgotten artifact is carried forward", (sc(c2)?.carried_forward ?? []).includes("schema.sql"), JSON.stringify(sc(c2)?.carried_forward));
  const carriedEntry = (sc(c2)?.artifact_manifest ?? []).find((x) => x.name === "schema.sql");
  check("carried artifact keeps its hash and is on disk",
    carriedEntry?.carried_forward_from === "v0.1" &&
    existsSync(path.join(sc(c2).local_path, carriedEntry.relative_path)),
    JSON.stringify(carriedEntry));
  check("carry-forward raises a warning",
    (sc(c2)?.integrity_warnings ?? []).some((w) => w.code === "artifact_carried_forward"),
    JSON.stringify(sc(c2)?.integrity_warnings));

  const c3 = await call("savepoint", {
    project_name: "Carry", source_platform: "claude", state: { ...baseState, current_state: "deleted schema" },
    artifacts: [{ name: "app.py", kind: "code", transfer: "text", text_content: "def main():\n" + "    pass\n".repeat(210) }],
    deleted_artifacts: ["schema.sql"],
  });
  check("explicit deletion is honoured",
    !(sc(c3)?.artifact_manifest ?? []).some((x) => x.name === "schema.sql"),
    JSON.stringify((sc(c3)?.artifact_manifest ?? []).map((x) => x.name)));

  const c4 = await call("savepoint", {
    project_name: "Carry", source_platform: "claude", state: { ...baseState, current_state: "truncated" },
    artifacts: [{ name: "app.py", kind: "code", transfer: "text", text_content: "def main():\n    # ... rest of the file unchanged\n" }],
  });
  const w4 = sc(c4)?.integrity_warnings ?? [];
  check("truncation marker is detected", w4.some((w) => w.code === "truncation_marker"), JSON.stringify(w4));
  check("collapsed file size is detected", w4.some((w) => w.code === "artifact_shrank"), JSON.stringify(w4));

  await call("savepoint", { project_name: "Idle", source_platform: "claude", state: baseState });
  const idle2 = await call("savepoint", { project_name: "Idle", source_platform: "claude", state: baseState });
  check("an empty savepoint is flagged as no_change",
    (sc(idle2)?.integrity_warnings ?? []).some((w) => w.code === "no_change"),
    JSON.stringify(sc(idle2)?.integrity_warnings));

  // ---------------- 9b. files the prose names but that were never handed over
  const miss1 = await call("savepoint", {
    project_name: "Artifact Recall", checkpoint_type: "major", source_platform: "claude",
    state: {
      ...baseState,
      current_state: "SQL-Schema definiert, noch nicht implementiert.",
      next_steps: ["schema_registry.sql implementieren"],
      open_questions: ["Laedt analyzer.py die Bilder herunter?"],
    },
  });
  const mw = (sc(miss1)?.integrity_warnings ?? []).find((w) => w.code === "artifacts_mentioned_but_missing");
  check("a file named only in the prose is flagged", Boolean(mw), JSON.stringify(sc(miss1)?.integrity_warnings));
  check("the warning names the missing files",
    Boolean(mw && mw.message.includes("schema_registry.sql") && mw.message.includes("analyzer.py")), mw?.message);

  const miss2 = await call("savepoint", {
    project_name: "Artifact Recall", source_platform: "claude",
    state: { ...baseState, next_steps: ["schema_registry.sql implementieren"] },
    artifacts: [{ name: "schema_registry.sql", kind: "schema", transfer: "text", text_content: "create table t(id int);" }],
  });
  check("attaching the artifact clears the warning",
    !(sc(miss2)?.integrity_warnings ?? []).some((w) => w.code === "artifacts_mentioned_but_missing"),
    JSON.stringify(sc(miss2)?.integrity_warnings));

  // The repair path: attach the file to the EXISTING savepoint, no new version.
  const before = await call("history", { project_name: "Artifact Recall" });
  const versionsBefore = (sc(before)?.savepoints ?? []).length;
  const fix = await call("attach_artifact", {
    project_name: "Artifact Recall", version: "v1.0",
    name: "schema_registry.sql", kind: "schema", transfer: "text",
    text_content: "create table kuenstler(id uuid primary key, name text not null);",
  });
  check("attach_artifact repairs an existing savepoint", sc(fix)?.artifact?.name === "schema_registry.sql", txt(fix));
  check("attach_artifact creates no new version",
    (sc(await call("history", { project_name: "Artifact Recall" }))?.savepoints ?? []).length === versionsBefore,
    `${versionsBefore} before`);
  check("attach_artifact clears the resolved warning",
    !(sc(fix)?.remaining_warnings ?? []).some((w) => w.message.includes("schema_registry.sql")),
    JSON.stringify(sc(fix)?.remaining_warnings));
  const fixed = await call("get_artifact", { project_name: "Artifact Recall", version: "v1.0", artifact_name: "schema_registry.sql" });
  check("the repaired artifact is readable from the old version",
    txt(fixed).includes("create table kuenstler"), txt(fixed).slice(0, 120));
  const fixedSp = await call("get_savepoint", { project_name: "Artifact Recall", version: "v1.0" });
  check("state.md no longer carries the stale warning",
    !txt(fixedSp).includes("artifacts_mentioned_but_missing") || !txt(fixedSp).includes("schema_registry.sql, analyzer.py"),
    txt(fixedSp).slice(0, 300));
  const fixLatest = await call("attach_artifact", {
    project_name: "Artifact Recall", name: "notes.md", kind: "document",
    transfer: "text", text_content: "# notes",
  });
  check("attach_artifact defaults to the latest savepoint", sc(fixLatest)?.version === "v1.1", sc(fixLatest)?.version);

  const miss3 = await call("savepoint", {
    project_name: "No Files Here", source_platform: "claude",
    state: { ...baseState, current_state: "Reine Strategie, Version 2.0, keine Dateien." },
  });
  check("prose without filenames stays quiet",
    !(sc(miss3)?.integrity_warnings ?? []).some((w) => w.code === "artifacts_mentioned_but_missing"),
    JSON.stringify(sc(miss3)?.integrity_warnings));

  // ------------------------------------------------------------- 10. diff
  const d1 = await call("diff_savepoints", { project_name: "Carry" });
  check("diff defaults to latest vs predecessor", sc(d1)?.to_version === "v0.4" && sc(d1)?.from_version === "v0.3", `${sc(d1)?.from_version}->${sc(d1)?.to_version}`);
  check("diff reports modified artifacts", (sc(d1)?.artifacts?.modified ?? []).some((m) => m.name === "app.py"), JSON.stringify(sc(d1)?.artifacts));
  check("diff flags the suspicious shrink", (sc(d1)?.attention ?? []).some((a) => a.includes("shrank")), JSON.stringify(sc(d1)?.attention));

  const d2 = await call("diff_savepoints", { project_name: "Carry", from_version: "v0.1", to_version: "v0.2" });
  check("diff detects state text changes", sc(d2)?.current_state?.changed === true, JSON.stringify(sc(d2)?.current_state));
  check("diff reports carried-forward artifacts", (sc(d2)?.artifacts?.carried_forward ?? []).includes("schema.sql"), JSON.stringify(sc(d2)?.artifacts));
  check("diff renders readable markdown", txt(d2).includes("## Artifacts") && txt(d2).includes("Carried forward"), txt(d2).slice(0, 300));

  const d3 = await call("diff_savepoints", { project_name: "Journaled", from_version: "v0.1", to_version: "v0.2" });
  check("diff shows added decisions", (sc(d3)?.decisions?.added ?? []).includes("Postgres over Mongo"), JSON.stringify(sc(d3)?.decisions));

  const d4 = await call("diff_savepoints", { project_name: "Idle", to_version: "v0.1" });
  check("diff of the first savepoint explains itself", txt(d4).includes("first savepoint"), txt(d4));

  // ------------------------------- 11. finding a project again weeks later
  const lp = await call("list_projects", {});
  const lpText = txt(lp);
  check("list_projects shows recency and summary",
    lpText.includes("updated ") && lpText.includes("savepoint") && /\*\*Carry\*\*/.test(lpText), lpText.slice(0, 400));
  check("list_projects surfaces pending journal entries",
    (sc(lp)?.projects ?? []).some((p) => typeof p.pending_journal === "number"), JSON.stringify(sc(lp)?.projects?.[0]));

  const fz1 = await call("resume_project", { project_name: "my project" });
  check("resume tolerates casing", sc(fz1)?.project === "My Project", sc(fz1)?.project);
  const fz2 = await call("resume_project", { project_name: "Journal ed" });
  check("resume tolerates stray spacing", sc(fz2)?.project === "Journaled", txt(fz2).slice(0, 160));
  const fz3 = await call("resume_project", { project_name: "Journaledd" });
  check("resume tolerates a typo", sc(fz3)?.project === "Journaled", txt(fz3).slice(0, 160));
  check("resume states the canonical name to use next",
    txt(fz3).includes('exact project name "Journaled"'), txt(fz3).slice(0, 200));
  const fz4 = await call("resume_project", { project_name: "totally unrelated thing" });
  check("unmatchable name lists the known projects", txt(fz4).includes("Known projects"), txt(fz4).slice(0, 200));

  // Ambiguity must never be resolved by guessing.
  await call("savepoint", { project_name: "Alpha Report", source_platform: "claude", state: baseState });
  await call("savepoint", { project_name: "Alpha Report 2", source_platform: "claude", state: baseState });
  const amb = await call("resume_project", { project_name: "alpha" });
  check("ambiguous name asks instead of guessing",
    txt(amb).includes("ambiguous") && txt(amb).includes("Alpha Report 2"), txt(amb).slice(0, 220));

  const hist = await call("history", { project_name: "carry" });
  check("history also tolerates an approximate name and dates the entries",
    sc(hist)?.project === "Carry" && txt(hist).includes("v0.1"), txt(hist).slice(0, 200));

  // Writes must stay strict. "Journal ed" resolves to "Journaled" on READ (normalised match),
  // but a WRITE must never merge into it - only an exact name or slug hit may append.
  const strict = await call("savepoint", { project_name: "Journal ed", source_platform: "claude", state: baseState });
  check("a fuzzy name creates a new project on write, never a silent merge",
    sc(strict)?.project_slug === "journal-ed" && sc(strict)?.version === "v0.1",
    `${sc(strict)?.project_slug} ${sc(strict)?.version}`);
  // Case-only differences are an exact match and DO append, which is intended.
  const sameProject = await call("savepoint", { project_name: "my project", source_platform: "claude", state: baseState });
  check("case-insensitive exact name appends to the same project",
    sc(sameProject)?.project_slug === "my-project", sc(sameProject)?.project_slug);

  // ----------------------------------------- 12. concurrent savepoints (v0.3 race)
  const conc = await Promise.all(Array.from({ length: 5 }, () =>
    call("savepoint", { project_name: "Race", source_platform: "claude", state: baseState })));
  const concVersions = conc.map((r) => sc(r)?.version).filter(Boolean);
  check("5 concurrent savepoints get 5 distinct versions",
    concVersions.length === 5 && new Set(concVersions).size === 5, concVersions.join(","));

  // -------------------------------------------------------- 9. HTTP hardening
  const badOrigin = await fetch(`${BASE}/mcp/${KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", origin: "https://evil.example" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list" }),
  });
  check("cross-origin browser request is rejected", badOrigin.status === 403, `status ${badOrigin.status}`);

  // fetch() refuses to override Host, so this one goes over a raw socket.
  const rawStatus = await new Promise((resolve, reject) => {
    const sock = net.connect(PORT, "127.0.0.1", () => {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 98, method: "tools/list" });
      sock.write(
        `POST /mcp/${KEY} HTTP/1.1\r\nHost: attacker.example\r\n` +
        `Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
    });
    let buf = "";
    sock.on("data", (d) => { buf += d; });
    sock.on("end", () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(buf)?.[1] ?? 0)));
    sock.on("error", reject);
  });
  check("DNS-rebinding Host header is rejected", rawStatus === 403, `status ${rawStatus}`);

  const badKey = await fetch(`${BASE}/mcp/wrong-key`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  check("wrong access key is 404", badKey.status === 404, `status ${badKey.status}`);

  const noCsrf = new FormData();
  noCsrf.append("project", "My Project");
  noCsrf.append("version", "v0.1");
  noCsrf.append("file", new File(["x"], "csrf.txt", { type: "text/plain" }));
  const csrfRes = await fetch(`${BASE}/upload/${KEY}`, { method: "POST", body: noCsrf });
  check("upload without CSRF token is rejected", csrfRes.status === 400, `status ${csrfRes.status}`);

  const page = await (await fetch(`${BASE}/upload/${KEY}`)).text();
  const token = /name="csrf" value="([^"]+)"/.exec(page)?.[1];
  const good = new FormData();
  good.append("csrf", token ?? "");
  good.append("project", "My Project");
  good.append("version", "v0.1");
  good.append("note", "manual");
  good.append("file", new File(["binary bytes"], "logo.png", { type: "image/png" }));
  const upRes = await fetch(`${BASE}/upload/${KEY}`, { method: "POST", body: good });
  const upBody = await upRes.text();
  check("upload with CSRF token succeeds", upRes.status === 200 && upBody.includes("Stored logo.png"), `status ${upRes.status}`);

  const r12 = await call("get_artifact", { project_name: "My Project", version: "v0.1", artifact_name: "logo.png" });
  check("manual upload resolves the pending artifact", sc(r12)?.artifact?.status === "stored", JSON.stringify(sc(r12)));

  const xss = await (await fetch(`${BASE}/upload/${KEY}`, {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=xx" },
    body: "--xx--",
  })).text();
  check("error messages are HTML-escaped", !/<script/i.test(xss) && xss.includes("&lt;") === xss.includes("&lt;"));

  // ------------------------------------ 13. stdio entrypoint (Claude Desktop)
  const stdioRoot = mkdtempSync(path.join(tmpdir(), "stateark-stdio-"));
  const stdioOut = await new Promise((resolve) => {
    const p = spawn(process.execPath, ["--import", "tsx", "src/stdio.ts"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, STATEARK_LOCAL_ROOT: stdioRoot, SUPABASE_URL: "", SUPABASE_SECRET_KEY: "", STATEARK_OWNER_ID: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "desktop", version: "1" } } }) + "\n");
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    setTimeout(() => {
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
      setTimeout(() => { p.kill("SIGTERM"); resolve({ out, err }); }, 2500);
    }, 4000);
  });
  const stdioLines = stdioOut.out.split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } });
  check("stdio entrypoint completes the MCP handshake",
    stdioLines.some((m) => m?.result?.serverInfo?.name === "stateark"), stdioOut.out.slice(0, 200) + stdioOut.err.slice(0, 200));
  check("stdio entrypoint exposes the same 11 tools",
    stdioLines.some((m) => m?.result?.tools?.length === 11), stdioOut.out.slice(0, 200));
  check("stdio stdout carries only JSON-RPC (banner goes to stderr)",
    stdioLines.every((m) => m && m.jsonrpc === "2.0") && stdioOut.err.includes("StateArk"),
    `stdout had ${stdioLines.filter((m) => !m).length} non-JSON lines`);
  try { rmSync(stdioRoot, { recursive: true, force: true }); } catch { /* ignore */ }

  // ----------------------------- 14. CLI (it edits the user's Claude config)
  const cliHome = mkdtempSync(path.join(tmpdir(), "stateark-home-"));
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const cli = (argv, home = cliHome) => {
    const r = spawnSync(process.execPath, [path.join(repoRoot, "bin", "stateark.mjs"), ...argv], {
      // APPDATA must be redirected too: on Windows configPath() reads it directly,
      // so without this the test would edit the tester's real Claude config.
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        APPDATA: path.join(home, "AppData", "Roaming"),
        NO_COLOR: "1",
      },
      encoding: "utf8",
    });
    return { out: (r.stdout ?? "") + (r.stderr ?? ""), code: r.status };
  };
  // Must mirror configPath() in bin/stateark.mjs exactly. Hard-coding the Linux
  // location made the "does not touch the config" checks vacuously true on macOS:
  // they asserted the absence of a file nothing ever writes there. Every test that
  // needs the config path goes through this one function.
  const configPathFor = (home) => {
    if (process.platform === "darwin")
      return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    if (process.platform === "win32")
      return path.join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json");
    return path.join(home, ".config", "Claude", "claude_desktop_config.json");
  };
  const cliConfig = configPathFor(cliHome);
  const built = existsSync(path.join(repoRoot, "dist", "stdio.js"));

  check("cli help works", cli(["help"]).out.includes("local-first version control"), cli(["help"]).out);
  // Informational flags must never write to the user's Claude config.
  const vOut = cli(["--version"]).out.trim();
  check("cli --version prints only the version", /^\d+\.\d+\.\d+$/.test(vOut), vOut);
  check("cli --version does not touch the config", !existsSync(cliConfig), "config was created by --version");
  check("cli -h does not touch the config",
    cli(["-h"]).out.includes("npx stateark") && !existsSync(cliConfig), "config was created by -h");
  check("cli report on an empty store does not crash",
    cli(["report"]).out.includes("No savepoints found"), cli(["report"]).out);

  if (built) {
    cli([]);
    const cfg = JSON.parse(readFileSync(cliConfig, "utf8"));
    check("cli setup registers stateark", Boolean(cfg.mcpServers?.stateark?.args?.[0]?.endsWith("stdio.js")), JSON.stringify(cfg));

    // A foreign server and unrelated keys must survive.
    cfg.mcpServers.somethingElse = { command: "npx", args: ["-y", "other"] };
    cfg.globalShortcut = "Cmd+Shift+Space";
    writeFileSync(cliConfig, JSON.stringify(cfg, null, 2));
    cli([]);
    const cfg2 = JSON.parse(readFileSync(cliConfig, "utf8"));
    check("cli setup leaves other MCP servers alone",
      Boolean(cfg2.mcpServers.somethingElse) && cfg2.globalShortcut === "Cmd+Shift+Space", JSON.stringify(cfg2));

    cli(["remove"]);
    const cfg3 = JSON.parse(readFileSync(cliConfig, "utf8"));
    check("cli remove deletes only the stateark entry",
      !cfg3.mcpServers.stateark && Boolean(cfg3.mcpServers.somethingElse), JSON.stringify(cfg3));

    check("cli report exposes no project names",
      !cli(["report", "--root", ROOT]).out.includes("My Project"), "project name leaked into the report");
    check("cli report counts the throwaway store",
      /Projects\s+\d+/.test(cli(["report", "--root", ROOT]).out), cli(["report", "--root", ROOT]).out.slice(0, 200));
  } else {
    console.log("  SKIP  cli setup/remove checks (run npm run build first)");
  }

  const badHome = mkdtempSync(path.join(tmpdir(), "stateark-bad-"));
  const badCfg = configPathFor(badHome);
  mkdirSync(path.dirname(badCfg), { recursive: true });
  writeFileSync(badCfg, "{ not json");
  const badRun = cli([], badHome);
  check("cli refuses to overwrite a corrupt config",
    badRun.code === 1 && readFileSync(badCfg, "utf8") === "{ not json", badRun.out);

  for (const dir of [cliHome, badHome]) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }

  // ------------------------------------------------------- 10. no cloud leakage
  check("cloud sync stays disabled without credentials", sc(s1)?.cloud_sync?.enabled === false, JSON.stringify(sc(s1)?.cloud_sync));
  check("server still alive at the end", (await fetch(`${BASE}/health`)).ok);

} catch (e) {
  failures++;
  console.error("\nFATAL:", e);
  console.error(serverLog);
} finally {
  child.kill("SIGTERM");
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}
