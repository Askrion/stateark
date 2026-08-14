#!/usr/bin/env node
/**
 * Registers StateArk with Claude Desktop by merging one entry into
 * claude_desktop_config.json. Backs the file up first and never touches
 * entries it did not create.
 *
 *   npm run build && npm run install-claude-desktop
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const ENTRY = path.join(ROOT, "dist", "stdio.js");

function configPath() {
  const p = platform();
  if (p === "darwin") return path.join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (p === "win32") return path.join(process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return path.join(homedir(), ".config", "Claude", "claude_desktop_config.json");
}

function fail(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

if (!existsSync(ENTRY)) {
  fail(`Build output missing: ${ENTRY}\n  Run this first:  npm run build`);
}

const file = configPath();
mkdirSync(path.dirname(file), { recursive: true });

let config = {};
if (existsSync(file)) {
  const raw = readFileSync(file, "utf8").trim();
  if (raw) {
    try {
      config = JSON.parse(raw);
    } catch {
      fail(`${file} exists but is not valid JSON.\n  Fix or remove it, then run this again. Nothing was changed.`);
    }
  }
  const backup = `${file}.stateark-backup-${Date.now()}`;
  copyFileSync(file, backup);
  console.log(`  Backed up existing config to:\n    ${backup}`);
}

config.mcpServers ??= {};
const existed = Boolean(config.mcpServers.stateark);

config.mcpServers.stateark = {
  command: process.execPath,
  args: [ENTRY],
  ...(process.env.STATEARK_LOCAL_ROOT?.trim()
    ? { env: { STATEARK_LOCAL_ROOT: process.env.STATEARK_LOCAL_ROOT.trim() } }
    : {}),
};

writeFileSync(file, JSON.stringify(config, null, 2) + "\n", "utf8");

console.log(`
  ${existed ? "Updated" : "Added"} the "stateark" entry in:
    ${file}

  Node:       ${process.execPath}
  Entrypoint: ${ENTRY}
  Savepoints: ${process.env.STATEARK_LOCAL_ROOT?.trim() || path.join(homedir(), "StateArk")}

  Next: quit Claude Desktop completely (Cmd+Q, not just the window) and reopen it.
  Then ask it: "Which StateArk projects do I have?"
`);
