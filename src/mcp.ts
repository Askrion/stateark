import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ArtifactSchema, JournalEntrySchema, StateSchema } from "./types.js";
import { JOURNAL_NUDGE_AT, LocalStore, VERSION_RE } from "./local-store.js";
import { SupabaseSync, isTextLike } from "./cloud-sync.js";
import { diffSavepoints, renderDiffMarkdown } from "./diff.js";

export const STATEARK_VERSION = "0.5.1";

export type StateArkDeps = {
  local: LocalStore;
  cloud: SupabaseSync | null;
  /** Where the user can attach binaries by hand. Undefined in stdio mode. */
  uploadPageUrl?: string;
};

function instructions() {
  return [
    "StateArk is local-first version control for AI work. The local filesystem is the source of truth.",
    "",
    "SAVEPOINT (user-triggered): reconstruct the CURRENT VALID project state, not a chronological summary.",
    "Prefer the latest accepted decisions; retain rejected approaches only when the reason prevents repetition.",
    "Include every CURRENT artifact needed to resume. Exact text/code: transfer=text with the exact content.",
    "Exact binary bytes: transfer=base64 only when the bytes are truly available.",
    "Otherwise transfer=pending; never reconstruct a binary file from memory.",
    "NEVER abbreviate a file with '... rest unchanged' or similar: StateArk detects those markers and",
    "the savepoint will be flagged as incomplete. If a file is genuinely unchanged since the last",
    "savepoint, simply omit it - StateArk carries it forward automatically and records that it did.",
    "Only list a file in deleted_artifacts when it should really stop existing.",
    "If the result contains integrity_warnings, tell the user plainly and offer to correct the savepoint.",
    "To correct a missing file, call attach_artifact - it repairs the existing savepoint in place",
    "and does NOT create a new version. Only run savepoint again when the state itself changed.",
    "BEFORE calling savepoint, go through the conversation and enumerate every file, code block,",
    "schema, query, config or document it produced or revised. Each one belongs in artifacts[] with",
    "its exact content, unless it is unchanged since the last savepoint. Do this without being asked:",
    "the user should never have to name individual files. A file that is only described in the state",
    "text is NOT preserved - StateArk stores bytes, not descriptions.",
    "",
    "NOTE_EVENT (you decide, silently): while working on a project that ALREADY EXISTS in StateArk,",
    "call note_event immediately after a real turning point - a decision made, an approach rejected,",
    "a finding validated, a requirement fixed, or a code artifact reaching a new working version.",
    "One short line, no detail dumps. Do NOT announce these calls and do NOT ask permission;",
    "they are bookkeeping, not conversation. Do NOT call note_event for brainstorming, questions,",
    "restatements, or minor edits. If the project does not exist yet, note_event returns tracked=false;",
    "accept that silently and do not create a project just to journal. The journal is what lets a later",
    "Savepoint be accurate even when the conversation has grown long and early context has degraded.",
    "",
    "RESUME: load the latest savepoint and treat it as authoritative. Retrieve artifacts only when needed.",
    "Read tools tolerate an approximate project name, but afterwards always use the exact",
    "project name they return. If the user cannot remember what a project was called, call",
    "list_projects and let them recognise it - never guess between several candidates.",
    "DIFF: use diff_savepoints to show the user what actually changed between two versions.",
  ].join(" ");
}

function relativeAge(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "unknown";
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months < 24 ? `${months} month${months === 1 ? "" : "s"} ago` : `${Math.floor(days / 365)} years ago`;
}

/**
 * Forgiving project lookup for read tools. Never guesses when several projects fit -
 * it hands back the candidates so the model can ask which one was meant.
 */
function makeResolveForRead(local: LocalStore) {
  return async function resolveForRead(name: string) {
  const r = await local.findProjectFuzzy(name);
  if (r.match) {
    const note = r.how === "exact" || r.how === "slug"
      ? ""
      : `(Resolved "${name}" to the project "${r.match.name}".) `;
    return { ok: true as const, project: r.match, note };
  }
  const list = r.candidates.length
    ? r.candidates.map((p) => `"${p.name}" (${p.latest_version}, updated ${relativeAge(p.updated_at)})`).join(", ")
    : "";
  const text = r.candidates.length && r.how !== "none"
    ? `"${name}" is ambiguous. Ask the user which one they mean: ${list}.`
    : r.candidates.length
      ? `No StateArk project matches "${name}". Known projects: ${list}.`
      : `No StateArk project matches "${name}", and ${local.projectsRoot()} contains no projects at all. ` +
        "If savepoints were expected, this agent is pointed at a different store than the one that wrote them; " +
        "report that exact path to the user.";
  return { ok: false as const, text };
  };
}

export function createStateArkServer(deps: StateArkDeps) {
  const { local, cloud, uploadPageUrl } = deps;
  const s = new McpServer({ name: "stateark", version: STATEARK_VERSION }, { instructions: instructions() });
  const resolveForRead = makeResolveForRead(local);

  s.registerTool("savepoint", {
    title: "Savepoint",
    description: "Create a local-first canonical savepoint plus artifact bundle.",
    inputSchema: {
      project_name: z.string().min(1).max(200),
      project_description: z.string().max(4000).optional(),
      checkpoint_type: z.enum(["minor", "major"]).default("minor"),
      title: z.string().max(200).optional(),
      source_platform: z.enum(["chatgpt", "claude", "gemini", "other"]).default("other"),
      state: StateSchema,
      artifacts: z.array(ArtifactSchema).max(500).default([])
        .describe(
          "EVERY file, code block, schema or document that is currently valid in this conversation, " +
          "with its exact content. Omit only files that are unchanged since the last savepoint - those " +
          "are carried forward automatically. An empty array is correct ONLY if the conversation " +
          "produced no files at all."),
      deleted_artifacts: z.array(z.string()).max(200).default([])
        .describe("Artifacts that should stop existing. Anything else missing is carried forward, not deleted."),
      sync_to_cloud: z.boolean().default(true),
    },
  }, async (a) => {
    const sp = await local.save({
      project_name: a.project_name,
      project_description: a.project_description,
      checkpoint_type: a.checkpoint_type,
      title: a.title,
      source_platform: a.source_platform,
      state: a.state,
      artifacts: a.artifacts,
      deleted_artifacts: a.deleted_artifacts,
    });

    let sync: Record<string, unknown> = { enabled: !!cloud, status: "disabled" };
    if (a.sync_to_cloud && cloud) {
      try {
        await local.setCloudSync(a.project_name, sp.meta.version, "pending");
        const r = await cloud.push(local, a.project_name, sp.meta.version);
        sync = { enabled: true, status: "synced", ...r };
      } catch (e: unknown) {
        await local.setCloudSync(a.project_name, sp.meta.version, "failed");
        sync = { enabled: true, status: "failed", error: e instanceof Error ? e.message : String(e) };
      }
    }

    const pending = sp.manifest.filter((x) => x.status === "pending").map((x) => x.name);
    const renamed = sp.manifest.filter((x) => x.original_name).map((x) => `${x.original_name} -> ${x.name}`);
    const carried = sp.manifest.filter((x) => x.carried_forward_from).map((x) => x.name);
    return {
      structuredContent: {
        project: sp.meta.project_name,
        project_slug: sp.meta.project_slug,
        version: sp.meta.version,
        local_path: sp.dir,
        artifact_manifest: sp.manifest,
        pending_artifacts: pending,
        renamed_artifacts: renamed,
        carried_forward: carried,
        integrity_warnings: sp.warnings,
        journal_entries_consumed: sp.journal_consumed,
        cloud_sync: sync,
        upload_page: uploadPageUrl,
      },
      content: [{
        type: "text" as const,
        text:
          `Saved ${sp.meta.project_name} ${sp.meta.version} locally${sync.status === "synced" ? " and synced to cloud" : ""}.` +
          (sp.journal_consumed ? ` Consolidated ${sp.journal_consumed} journal entr${sp.journal_consumed === 1 ? "y" : "ies"}.` : "") +
          (sync.status === "failed" ? ` Cloud sync FAILED: ${sync.error} (local copy is intact; retry with sync_savepoint).` : "") +
          (pending.length ? ` Pending artifacts: ${pending.join(", ")}.` : "") +
          (renamed.length ? ` Renamed for filesystem safety: ${renamed.join(", ")}.` : "") +
          (sp.warnings.length
            ? `\n\nINTEGRITY WARNINGS (tell the user, then offer to fix):\n` +
              sp.warnings.map((w) => `- [${w.code}] ${w.message}`).join("\n")
            : ""),
      }],
    };
  });

  s.registerTool("note_event", {
    title: "Note Event",
    description:
      "Record one short journal line for a project that already exists in StateArk. " +
      "Call this silently after a real turning point (decision, rejection, validated finding, " +
      "new working version of an artifact). The journal is consolidated at the next Savepoint.",
    inputSchema: {
      project_name: z.string().min(1),
      type: JournalEntrySchema.shape.type,
      summary: JournalEntrySchema.shape.summary,
      detail: JournalEntrySchema.shape.detail,
      session_id: JournalEntrySchema.shape.session_id,
    },
  }, async ({ project_name, type, summary, detail, session_id }) => {
    const r = await local.appendJournal(project_name, { type, summary, detail, session_id });
    if (!r.tracked) {
      return {
        structuredContent: { tracked: false, project: project_name },
        content: [{
          type: "text" as const,
          text: `"${project_name}" is not tracked by StateArk yet, so nothing was journalled. ` +
                "This is expected for a new conversation. Do not mention this to the user and do not " +
                "create a project just to journal; the first Savepoint starts tracking.",
        }],
      };
    }
    const nudge = r.pending >= JOURNAL_NUDGE_AT
      ? ` ${r.pending} entries have accumulated since ${r.since_version ?? "the start"} - ` +
        "it is reasonable to mention once that a Savepoint would be a good idea."
      : "";
    return {
      structuredContent: { tracked: true, project: r.project_name, pending_entries: r.pending, since_version: r.since_version },
      content: [{ type: "text" as const, text: `Journalled. ${r.pending} pending entr${r.pending === 1 ? "y" : "ies"} since ${r.since_version ?? "the start"}.${nudge}` }],
    };
  });

  s.registerTool("journal", {
    title: "Journal",
    description: "Show the journal entries recorded since the last savepoint.",
    inputSchema: { project_name: z.string().min(1) },
  }, async ({ project_name }) => {
    const entries = await local.readJournal(project_name);
    return {
      structuredContent: { project: project_name, pending_entries: entries },
      content: [{
        type: "text" as const,
        text: entries.length
          ? entries.map((e) => `- [${e.type}] ${e.summary}${e.detail ? `\n      ${e.detail}` : ""}`).join("\n")
          : "No journal entries since the last savepoint.",
      }],
    };
  });

  s.registerTool("diff_savepoints", {
    title: "Diff Savepoints",
    description:
      "Show what actually changed between two savepoints: state fields, artifacts, and anything " +
      "that looks like content was silently dropped. Defaults to the latest version against its predecessor.",
    inputSchema: {
      project_name: z.string().min(1),
      from_version: z.string().regex(VERSION_RE).optional(),
      to_version: z.string().regex(VERSION_RE).optional(),
    },
  }, async ({ project_name, from_version, to_version }) => {
    const r = await resolveForRead(project_name);
    if (!r.ok) return { content: [{ type: "text" as const, text: r.text }] };
    const idx = r.project;

    const ordered = idx.versions.map((x) => x.version);
    const to = to_version ?? idx.latest_version;
    if (!to) return { content: [{ type: "text" as const, text: `"${idx.name}" has no savepoints yet.` }] };
    const toPos = ordered.indexOf(to);
    const from = from_version ?? (toPos > 0 ? ordered[toPos - 1] : null);
    if (!from) {
      return { content: [{ type: "text" as const, text: `${to} is the first savepoint of "${idx.name}", so there is nothing to compare against.` }] };
    }

    const [a, b] = await Promise.all([local.load(idx.name, from), local.load(idx.name, to)]);
    if (!a) return { content: [{ type: "text" as const, text: `Savepoint ${from} not found for "${idx.name}".` }] };
    if (!b) return { content: [{ type: "text" as const, text: `Savepoint ${to} not found for "${idx.name}".` }] };

    const d = diffSavepoints(a, b);
    return { structuredContent: d, content: [{ type: "text" as const, text: r.note + renderDiffMarkdown(d) }] };
  });

  s.registerTool("resume_project", {
    title: "Resume Project",
    description: "Load the latest local canonical state and artifact manifest.",
    inputSchema: { project_name: z.string().min(1) },
  }, async ({ project_name }) => {
    const r = await resolveForRead(project_name);
    if (!r.ok) return { content: [{ type: "text" as const, text: r.text }] };

    const sp = await local.latest(r.project.name);
    if (!sp) return { content: [{ type: "text" as const, text: `"${r.project.name}" has no savepoints yet.` }] };

    const pending = sp.manifest.filter((x) => x.status === "pending").map((x) => x.name);
    const journal = await local.readJournal(r.project.name);
    const warnings = (sp.meta.integrity_warnings ?? []) as { code: string; message: string }[];
    return {
      structuredContent: {
        project: sp.meta.project_name,
        version: sp.meta.version,
        updated_at: sp.meta.created_at,
        state: sp.state,
        artifact_manifest: sp.manifest,
        pending_artifacts: pending,
        integrity_warnings: warnings,
        pending_journal_entries: journal,
        cloud_sync: sp.meta.cloud_sync,
      },
      content: [{
        type: "text" as const,
        text:
          `${r.note}Use the exact project name "${sp.meta.project_name}" in any follow-up StateArk call.\n\n` +
          sp.markdown +
          (pending.length ? `\n\nWARNING: pending artifacts (not stored): ${pending.join(", ")}` : "") +
          (warnings.length
            ? `\n\nThis savepoint was saved with unresolved integrity warnings:\n` +
              warnings.map((w) => `- [${w.code}] ${w.message}`).join("\n")
            : "") +
          (journal.length
            ? `\n\nJournal entries recorded after this savepoint (not yet consolidated):\n` +
              journal.map((e) => `- [${e.type}] ${e.summary}`).join("\n")
            : ""),
      }],
    };
  });

  s.registerTool("get_savepoint", {
    title: "Get Savepoint",
    description: "Load a specific local savepoint.",
    inputSchema: { project_name: z.string().min(1), version: z.string().regex(VERSION_RE) },
  }, async ({ project_name, version }) => {
    const r = await resolveForRead(project_name);
    if (!r.ok) return { content: [{ type: "text" as const, text: r.text }] };
    const sp = await local.load(r.project.name, version);
    if (!sp) {
      const have = r.project.versions.map((v) => v.version).join(", ");
      return { content: [{ type: "text" as const, text: `Savepoint ${version} not found for "${r.project.name}". Available: ${have}.` }] };
    }
    return {
      structuredContent: { project: sp.meta.project_name, version, state: sp.state, artifact_manifest: sp.manifest },
      content: [{ type: "text" as const, text: r.note + sp.markdown }],
    };
  });

  s.registerTool("get_artifact", {
    title: "Get Artifact",
    description: "Retrieve exact artifact text, or the verified local path for binaries.",
    inputSchema: {
      project_name: z.string().min(1),
      version: z.string().regex(VERSION_RE),
      artifact_name: z.string().min(1),
    },
  }, async ({ project_name, version, artifact_name }) => {
    const r = await resolveForRead(project_name);
    if (!r.ok) return { content: [{ type: "text" as const, text: r.text }] };
    const a = await local.getArtifact(r.project.name, version, artifact_name);
    if (!a) return { content: [{ type: "text" as const, text: `Artifact "${artifact_name}" not found in ${r.project.name} ${version}.` }] };
    if (a.pending) {
      return {
        structuredContent: { status: "pending", artifact: a.entry },
        content: [{ type: "text" as const, text: `${a.entry.name} is marked pending and was not preserved. Do not invent its contents.` }],
      };
    }
    const textLike = isTextLike(a.entry.kind, a.entry.name);
    return {
      structuredContent: { artifact: a.entry, local_path: a.full, encoding: textLike ? "utf8" : "binary" },
      content: [{
        type: "text" as const,
        text: textLike
          ? a.bytes.toString("utf8")
          : `Binary artifact stored locally at ${a.full}. SHA-256: ${a.entry.sha256}`,
      }],
    };
  });

  s.registerTool("attach_artifact", {
    title: "Attach Artifact",
    description:
      "Add or replace one artifact on an EXISTING savepoint, without creating a new version. " +
      "Use this to fix a savepoint that was written without a file it should contain - for example " +
      "after an artifacts_mentioned_but_missing warning. Send the exact content; never reconstruct " +
      "a file from memory. Defaults to the latest savepoint.",
    inputSchema: {
      project_name: z.string().min(1),
      version: z.string().regex(VERSION_RE).optional()
        .describe("Defaults to the latest savepoint of the project."),
      name: z.string().min(1).max(255),
      kind: ArtifactSchema.innerType().shape.kind,
      mime_type: z.string().max(255).optional(),
      transfer: z.enum(["text", "base64"]),
      text_content: z.string().optional(),
      base64_content: z.string().optional(),
      note: z.string().max(2000).optional(),
    },
  }, async (a) => {
    if (a.transfer === "text" && a.text_content === undefined) {
      return { isError: true, content: [{ type: "text" as const, text: "text_content is required when transfer=text." }] };
    }
    if (a.transfer === "base64" && !a.base64_content) {
      return { isError: true, content: [{ type: "text" as const, text: "base64_content is required when transfer=base64." }] };
    }
    const bytes = a.transfer === "text"
      ? Buffer.from(a.text_content ?? "", "utf8")
      : Buffer.from(a.base64_content ?? "", "base64");

    try {
      const r = await local.attachFile(
        a.project_name, a.version ?? null, a.name, bytes, a.mime_type,
        a.note ?? "Attached after the savepoint was written",
      );
      const left = r.remaining_warnings.filter((w) => w.code === "artifacts_mentioned_but_missing");
      return {
        structuredContent: {
          project: a.project_name, version: r.version, artifact: r.entry,
          local_path: r.dir, remaining_warnings: r.remaining_warnings,
        },
        content: [{
          type: "text" as const,
          text:
            `Attached ${r.entry.name} (${r.entry.size_bytes} bytes, sha256:${r.entry.sha256?.slice(0, 12)}...) ` +
            `to ${a.project_name} ${r.version}. No new version was created; the manifest and state.md were updated.` +
            (left.length ? `\n\nStill outstanding: ${left[0].message}` : " No artifact warnings remain."),
        }],
      };
    } catch (e: unknown) {
      return { isError: true, content: [{ type: "text" as const, text: `Could not attach: ${e instanceof Error ? e.message : String(e)}` }] };
    }
  });

  s.registerTool("history", {
    title: "History",
    description: "List local savepoint history.",
    inputSchema: { project_name: z.string().min(1) },
  }, async ({ project_name }) => {
    const r = await resolveForRead(project_name);
    if (!r.ok) return { content: [{ type: "text" as const, text: r.text }] };
    const h = r.project.versions;
    const lines = h.map((x) => `- ${x.version} · ${relativeAge(x.created_at)}${x.title ? ` · "${x.title}"` : ""}`);
    return {
      structuredContent: { project: r.project.name, savepoints: h },
      content: [{
        type: "text" as const,
        text: `${r.note}${r.project.name}: ${h.length} savepoint${h.length === 1 ? "" : "s"}.\n${lines.join("\n")}`,
      }],
    };
  });

  s.registerTool("list_projects", {
    title: "List Projects",
    description:
      "List local StateArk projects, most recently updated first, with enough context to " +
      "recognise one again: last update, title, a one-line summary and pending journal entries. " +
      "Use this whenever the user cannot remember what a project was called.",
    inputSchema: {},
  }, async () => {
    const projects = await local.summarizeProjects();
    if (!projects.length) {
      // Always name the store. An empty answer is otherwise indistinguishable from
      // "this process is pointed at a different STATEARK_LOCAL_ROOT than the one you saved into".
      return {
        structuredContent: { projects: [], stateark_root: local.root },
        content: [{
          type: "text" as const,
          text: `No StateArk projects found in ${local.projectsRoot()} .\n` +
                "If you expected savepoints here, this agent is pointed at a different store than the one " +
                "that wrote them. Tell the user this exact path so they can compare it with STATEARK_LOCAL_ROOT.",
        }],
      };
    }
    const lines = projects.map((p) => {
      const bits = [
        p.latest_version ?? "no savepoint",
        `${p.savepoint_count} savepoint${p.savepoint_count === 1 ? "" : "s"}`,
        `updated ${relativeAge(p.updated_at)}`,
        p.source_platform ? `via ${p.source_platform}` : null,
        p.pending_journal ? `${p.pending_journal} journal entries pending` : null,
      ].filter(Boolean).join(" · ");
      return `- **${p.name}** — ${bits}` +
        (p.title ? `\n  "${p.title}"` : "") +
        (p.headline ? `\n  ${p.headline}` : "");
    });
    return {
      structuredContent: { projects, stateark_root: local.root },
      content: [{
        type: "text" as const,
        text: `${projects.length} project${projects.length === 1 ? "" : "s"} in ${local.projectsRoot()}, most recent first:\n\n${lines.join("\n")}`,
      }],
    };
  });

  s.registerTool("sync_savepoint", {
    title: "Sync Savepoint",
    description: "Push one already-local savepoint to the optional Supabase cloud mirror.",
    inputSchema: { project_name: z.string().min(1), version: z.string().regex(VERSION_RE) },
  }, async ({ project_name, version }) => {
    if (!cloud) return { content: [{ type: "text" as const, text: "Cloud sync is not configured (local-only mode)." }] };
    try {
      await local.setCloudSync(project_name, version, "pending");
      const r = await cloud.push(local, project_name, version);
      return { structuredContent: r, content: [{ type: "text" as const, text: `Synced ${project_name} ${version} to Supabase.` }] };
    } catch (e: unknown) {
      await local.setCloudSync(project_name, version, "failed");
      const msg = e instanceof Error ? e.message : String(e);
      return { isError: true, content: [{ type: "text" as const, text: `Cloud sync failed (local copy is intact): ${msg}` }] };
    }
  });

  return s;
}
