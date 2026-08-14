/**
 * StateArk over stdio.
 *
 * This is the entrypoint for Claude Desktop's claude_desktop_config.json, which can only
 * launch stdio servers. No HTTP, no port, no access key, no CORS - the client starts this
 * process directly and talks to it over the pipe.
 *
 * CRITICAL: stdout carries the JSON-RPC protocol. Nothing else may ever be written there,
 * so every diagnostic in this file goes to stderr.
 */
import "dotenv/config";
import { homedir } from "node:os";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LocalStore } from "./local-store.js";
import { SupabaseSync } from "./cloud-sync.js";
import { createStateArkServer, STATEARK_VERSION } from "./mcp.js";

const ROOT = process.env.STATEARK_LOCAL_ROOT?.trim() || path.join(homedir(), "StateArk");

const local = new LocalStore(ROOT);
await local.init();

const cloud = (process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SECRET_KEY?.trim() && process.env.STATEARK_OWNER_ID?.trim())
  ? new SupabaseSync(
      process.env.SUPABASE_URL!.trim(),
      process.env.SUPABASE_SECRET_KEY!.trim(),
      process.env.STATEARK_OWNER_ID!.trim(),
      process.env.STATEARK_STORAGE_BUCKET?.trim() || "stateark-artifacts",
    )
  : null;

// In stdio mode there is no upload page: point the model at the HTTP agent instead.
const uploadPageUrl = process.env.STATEARK_PUBLIC_BASE_URL?.replace(/\/$/, "")
  ? `${process.env.STATEARK_PUBLIC_BASE_URL!.replace(/\/$/, "")}/upload/`
  : undefined;

process.on("unhandledRejection", (e) => console.error("[stateark] unhandled rejection:", e));
process.on("uncaughtException", (e) => console.error("[stateark] uncaught exception:", e));

const server = createStateArkServer({ local, cloud, uploadPageUrl });
const transport = new StdioServerTransport();
await server.connect(transport);

console.error(
  `StateArk v${STATEARK_VERSION} (stdio)\n` +
  `Root:       ${ROOT}\n` +
  `Cloud sync: ${cloud ? "enabled" : "disabled (local only)"}`,
);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => { void server.close().finally(() => process.exit(0)); });
}
