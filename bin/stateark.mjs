#!/usr/bin/env node
/**
 * StateArk CLI.
 *
 *   npx stateark            -> register with Claude Desktop
 *   npx stateark report     -> anonymised local usage summary (nothing is sent anywhere)
 *   npx stateark remove     -> unregister, leaving savepoints untouched
 *
 * Deliberately dependency-free and reads the store with plain fs, so it keeps working
 * even if dist/ is stale or the build is broken.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";

const PKG_ROOT = path.resolve(import.meta.dirname, "..");
const ENTRY = path.join(PKG_ROOT, "dist", "stdio.js");
const VERSION = (() => {
  try { return JSON.parse(readFileSync(path.join(PKG_ROOT, "package.json"), "utf8")).version; }
  catch { return "unknown"; }
})();

const args = process.argv.slice(2);

/**
 * Resolve the subcommand. Informational flags must NEVER fall through to setup:
 * `stateark --version` writing to the user's Claude config would be indefensible.
 */
const command = (() => {
  const first = args[0];
  if (!first) return "setup";
  if (!first.startsWith("-")) return first;
  if (first === "--version" || first === "-v") return "version";
  if (first === "--help" || first === "-h") return "help";
  return "setup"; // e.g. `stateark --root ~/Elsewhere`
})();
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name) => args.includes(`--${name}`);

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const B = (s) => (COLOR ? `\u001b[1m${s}\u001b[0m` : String(s));
const DIM = (s) => (COLOR ? `\u001b[2m${s}\u001b[0m` : String(s));
const out = (s = "") => console.log(s);

function storeRoot() {
  return flag("root")?.replace(/^~/, homedir()) ?? process.env.STATEARK_LOCAL_ROOT?.trim() ?? path.join(homedir(), "StateArk");
}

function claudeDesktopConfigPath() {
  const p = platform();
  if (p === "darwin") return path.join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (p === "win32") return path.join(process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return path.join(homedir(), ".config", "Claude", "claude_desktop_config.json");
}

function readConfig(file) {
  if (!existsSync(file)) return {};
  const raw = readFileSync(file, "utf8").trim();
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch {
    out(`\n  ${file}\n  exists but is not valid JSON. Fix or remove it, then run this again.`);
    out("  Nothing was changed.\n");
    process.exit(1);
  }
}

// --------------------------------------------------------------------- setup

function setup() {
  if (!existsSync(ENTRY)) {
    out(`\n  Build output missing: ${ENTRY}`);
    out("  If you are running from a git clone, run:  npm install && npm run build\n");
    process.exit(1);
  }

  const file = claudeDesktopConfigPath();
  mkdirSync(path.dirname(file), { recursive: true });
  const config = readConfig(file);

  if (existsSync(file)) {
    const backup = `${file}.stateark-backup-${Date.now()}`;
    copyFileSync(file, backup);
    out(`  Backed up your existing config to\n  ${DIM(backup)}`);
  }

  config.mcpServers ??= {};
  const existed = Boolean(config.mcpServers.stateark);
  const root = flag("root")?.replace(/^~/, homedir());

  config.mcpServers.stateark = {
    command: process.execPath,
    args: [ENTRY],
    ...(root ? { env: { STATEARK_LOCAL_ROOT: root } } : {}),
  };

  writeFileSync(file, JSON.stringify(config, null, 2) + "\n", "utf8");

  out();
  out(`  ${B(`StateArk ${VERSION}`)} ${existed ? "updated" : "installed"}.`);
  out();
  out(`  Config      ${DIM(file)}`);
  out(`  Savepoints  ${DIM(root ?? storeRoot())}`);
  out();
  out(`  ${B("Next:")} quit Claude Desktop completely (Cmd+Q, not just the window)`);
  out("        and open it again. Then ask it:");
  out();
  out(`     ${B("\"Which StateArk projects do I have?\"")}`);
  out();
  out(DIM("  Everything stays on this machine. Nothing is uploaded."));
  out(DIM("  Uninstall any time with:  npx stateark remove"));
  out();
}

// -------------------------------------------------------------------- report

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

function collect() {
  const root = storeRoot();
  const projectsDir = path.join(root, "projects");
  const stats = {
    stateark_version: VERSION,
    generated_at: new Date().toISOString().slice(0, 10),
    projects: 0,
    projects_with_2plus_savepoints: 0,
    savepoints_total: 0,
    savepoints_max_in_one_project: 0,
    artifacts_stored: 0,
    artifacts_pending: 0,
    artifacts_carried_forward: 0,
    artifact_bytes_total: 0,
    artifact_types: {},
    source_platforms: {},
    integrity_warnings: {},
    journal_entries_consumed: 0,
    journal_entries_pending: 0,
    first_savepoint: null,
    last_savepoint: null,
    active_days: 0,
  };

  let dirs = [];
  try { dirs = readdirSync(projectsDir, { withFileTypes: true }); }
  catch { return { stats, root, exists: false }; }

  const days = new Set();

  for (const d of dirs) {
    if (!d.isDirectory() || d.name.startsWith(".")) continue;
    const projectDir = path.join(projectsDir, d.name);
    let versions = [];
    try {
      versions = readdirSync(projectDir, { withFileTypes: true })
        .filter((v) => v.isDirectory() && /^v\d+\.\d+$/.test(v.name))
        .map((v) => v.name);
    } catch { continue; }
    if (!versions.length) continue;

    stats.projects++;
    stats.savepoints_total += versions.length;
    if (versions.length >= 2) stats.projects_with_2plus_savepoints++;
    stats.savepoints_max_in_one_project = Math.max(stats.savepoints_max_in_one_project, versions.length);

    try {
      const pending = readFileSync(path.join(projectDir, "journal.ndjson"), "utf8")
        .split("\n").filter((l) => l.trim()).length;
      stats.journal_entries_pending += pending;
    } catch { /* no pending journal */ }

    for (const v of versions) {
      const vdir = path.join(projectDir, v);

      const meta = readJson(path.join(vdir, "meta.json"));
      if (meta?.created_at) {
        const day = String(meta.created_at).slice(0, 10);
        days.add(day);
        if (!stats.first_savepoint || day < stats.first_savepoint) stats.first_savepoint = day;
        if (!stats.last_savepoint || day > stats.last_savepoint) stats.last_savepoint = day;
      }
      if (meta?.source_platform) {
        stats.source_platforms[meta.source_platform] = (stats.source_platforms[meta.source_platform] ?? 0) + 1;
      }
      for (const w of meta?.integrity_warnings ?? []) {
        stats.integrity_warnings[w.code] = (stats.integrity_warnings[w.code] ?? 0) + 1;
      }
      if (typeof meta?.journal_entries_consumed === "number") {
        stats.journal_entries_consumed += meta.journal_entries_consumed;
      }

      for (const a of readJson(path.join(vdir, "manifest.json")) ?? []) {
        if (a.status === "pending") stats.artifacts_pending++;
        else stats.artifacts_stored++;
        if (a.carried_forward_from) stats.artifacts_carried_forward++;
        if (typeof a.size_bytes === "number") stats.artifact_bytes_total += a.size_bytes;
        const ext = (path.extname(String(a.name ?? "")).slice(1) || "none").toLowerCase();
        stats.artifact_types[ext] = (stats.artifact_types[ext] ?? 0) + 1;
      }
    }
  }

  stats.active_days = days.size;
  stats.artifact_types = Object.fromEntries(
    Object.entries(stats.artifact_types).sort((a, b) => b[1] - a[1]).slice(0, 10),
  );
  return { stats, root, exists: true };
}

function report() {
  const { stats, root, exists } = collect();

  if (!exists || stats.projects === 0) {
    out(`\n  No savepoints found in ${root}\n`);
    out("  Either nothing has been saved yet, or the store lives elsewhere.");
    out(`  Point at another one with:  ${B("npx stateark report --root /path/to/StateArk")}\n`);
    return;
  }

  const kb = Math.round(stats.artifact_bytes_total / 1024);
  const pct = Math.round((stats.projects_with_2plus_savepoints / stats.projects) * 100);

  out();
  out(`  ${B("StateArk usage")}  ${DIM(root)}`);
  out(`  ${DIM("Nothing below has been sent anywhere. It is printed for you to read.")}`);
  out();
  out(`  Projects                 ${stats.projects}`);
  out(`  ...with 2+ savepoints    ${stats.projects_with_2plus_savepoints}  ${DIM(`(${pct}% - the "actually used it" number)`)}`);
  out(`  Savepoints total         ${stats.savepoints_total}  ${DIM(`(most in one project: ${stats.savepoints_max_in_one_project})`)}`);
  out(`  Artifacts stored         ${stats.artifacts_stored}  ${DIM(`(${kb} KB)`)}`);
  if (stats.artifacts_pending) out(`  Artifacts pending        ${stats.artifacts_pending}  ${DIM("(described but never handed over)")}`);
  if (stats.artifacts_carried_forward) out(`  Carried forward          ${stats.artifacts_carried_forward}`);
  out(`  Journal entries          ${stats.journal_entries_consumed} consolidated, ${stats.journal_entries_pending} pending`);
  out(`  Active days              ${stats.active_days}  ${DIM(`(${stats.first_savepoint} to ${stats.last_savepoint})`)}`);

  const warn = Object.entries(stats.integrity_warnings).sort((a, b) => b[1] - a[1]);
  if (warn.length) {
    out();
    out(`  ${B("Integrity warnings")}`);
    for (const [code, n] of warn) out(`    ${String(n).padStart(4)}  ${code}`);
  }

  out();
  out(`  ${B("Copy the block below if you want to help improve StateArk.")}`);
  out(`  ${DIM("It contains no project names, no filenames and no content.")}`);
  out();
  out("  ----- 8< -----");
  for (const line of JSON.stringify(stats, null, 2).split("\n")) out(`  ${line}`);
  out("  ----- >8 -----");
  out();
  if (has("json")) { /* already printed */ }
}

// -------------------------------------------------------------------- remove

function remove() {
  const file = claudeDesktopConfigPath();
  const config = readConfig(file);
  if (!config.mcpServers?.stateark) {
    out(`\n  StateArk is not registered in ${file}\n`);
    return;
  }
  const backup = `${file}.stateark-backup-${Date.now()}`;
  copyFileSync(file, backup);
  delete config.mcpServers.stateark;
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n", "utf8");
  out();
  out("  Removed the StateArk entry from Claude Desktop.");
  out(`  Backup: ${DIM(backup)}`);
  out();
  out(`  ${B("Your savepoints were not touched")} - they are still in ${storeRoot()}`);
  out("  and remain readable as plain Markdown and JSON without StateArk.");
  out();
  out("  Restart Claude Desktop to apply.");
  out();
}

// ---------------------------------------------------------------------- help

function help() {
  out(`
  ${B(`StateArk ${VERSION}`)} - local-first version control for AI work

  ${B("npx stateark")}                 register with Claude Desktop
  ${B("npx stateark report")}          anonymised local usage summary
  ${B("npx stateark remove")}          unregister (savepoints are kept)

  Options
    --root <path>              where savepoints live (default: ~/StateArk)

  Your savepoints are ordinary files. Nothing is uploaded, ever.
`);
}

switch (command) {
  case "setup": case "install": setup(); break;
  case "report": case "stats": report(); break;
  case "remove": case "uninstall": remove(); break;
  case "help": case "--help": case "-h": help(); break;
  case "version": case "--version": case "-v": out(VERSION); break;
  default:
    out(`\n  Unknown command: ${command}`);
    help();
    process.exit(1);
}
