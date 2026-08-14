# StateArk

**Never explain your project to an AI twice.**

Your chat is a workspace, not an archive. StateArk turns a working session into a
versioned, portable project state that any new chat can pick up.

```bash
npx stateark
```

Then quit Claude Desktop completely (Cmd+Q) and reopen it. That is the whole install.

*(Not published to npm yet? Install from the folder: `npm install && npm run build &&
npm run setup` — see `INSTALL.md`.)*

```
You:  ...three hours of work...
You:  Savepoint
      -> my-project v0.3 written to ~/StateArk

      (next day, new chat, empty context)

You:  Resume my-project
      -> decisions, constraints, rejected approaches, open questions,
         and the actual files - all current, none of the detours
```

**Local by default.** Savepoints are ordinary folders of Markdown, JSON and your real
files. Nothing is uploaded. If StateArk disappears tomorrow, you still have everything.

```text
~/StateArk/projects/my-project/v0.3/
  state.md        <- the canonical state, readable in any editor
  state.json
  manifest.json   <- every artifact with its SHA-256
  artifacts/
    app.py
    schema.sql
```

## Commands

| In the chat | What happens |
| --- | --- |
| `Savepoint` | consolidate the session into a new version |
| `Resume <project>` | load the latest state into a fresh chat |
| `History <project>` | list the versions |
| `Diff <project>` | what actually changed between two savepoints |

| In the terminal | |
| --- | --- |
| `npx stateark` | register with Claude Desktop |
| `npx stateark report` | anonymised local usage summary, printed for you only |
| `npx stateark remove` | unregister; savepoints are kept |

## What makes it more than a summary

- **Carry-forward.** Files you do not re-submit are copied into the new version with
  their original hash, so a forgetful model cannot silently lose your schema.
- **Integrity checks.** StateArk cannot see your chat - so it checks what it *can*:
  truncation markers (`// ... rest unchanged`), files that collapsed in size, files the
  state describes but never handed over, savepoints identical to their predecessor.
  It warns, it never blocks: the savepoint is always written.
- **Journal.** Between savepoints the model quietly records turning points, so a
  Savepoint at the end of a long session does not depend on a degraded context.
  Only for projects you already saved once - scratch conversations are never touched.

## Requirements

Node 20+. Claude Desktop, or Claude Code (`claude mcp add --transport http ...`).

Custom-connector UIs (Claude web, Cowork, ChatGPT web) dial your server from the
vendor's cloud and cannot reach `localhost`. See `INSTALL.md`.

## Licence

[Elastic License 2.0](https://www.elastic.co/licensing/elastic-license). Use it for
anything including commercially, read and modify the source, share the package. You may
not offer it to third parties as a hosted or managed service. Your savepoints are yours
and are not covered by this licence.

---

## Architecture

```text
ChatGPT / Claude / Gemini-capable MCP client
                 |
                 v
          StateArk Local Agent      <- 127.0.0.1 only, by default
                 |
                 v
        ~/StateArk/projects         <- SOURCE OF TRUTH
                 |
                 | optional
                 v
             Supabase               <- mirror / backup / transport
```

A Savepoint is an ordinary directory, not a proprietary database:

```text
StateArk/projects/my-project/
  journal.ndjson      # entries recorded since the last savepoint
  project.json        # index (self-healing: rebuilt from disk if corrupt)
  v0.3/
    state.md          # human- and LLM-readable canonical state + integrity warnings
    state.json        # the same state, structured
    meta.json         # version, lineage, platform, sync status, warnings
    manifest.json     # artifacts with SHA-256, stored/pending, carried_forward_from
    journal.ndjson    # the entries this savepoint consolidated
    artifacts/
      app.py
      schema.sql
      prototype.zip
```

If StateArk disappears, those files remain usable.

## Install

Requires Node 20+.

```bash
npm install
npm run typecheck
npm test          # 30 checks against a throwaway store — run this first
npm start
```

No `.env` is needed for local-only mode. Copy `.env.example` to `.env` only if you want
to change the port, the store location, or enable the Supabase mirror.

On first run StateArk generates a random access key and stores it in
`~/StateArk/.access-key` (mode 0600). The startup banner prints your endpoints:

```
MCP:         http://localhost:8787/mcp/<key>
Upload page: http://localhost:8787/upload/<key>
Health:      http://localhost:8787/health
```

## Security model

The agent is an unauthenticated-by-default local HTTP server, so v0.4 assumes any web page
you visit is hostile:

| Control | Default |
| --- | --- |
| Bind address | `127.0.0.1` (`STATEARK_BIND` to change) |
| Access key | random per install, in `<root>/.access-key`, constant-time compared |
| `Origin` header | loopback only, plus `STATEARK_ALLOWED_ORIGINS` |
| `Host` header | loopback only, plus `STATEARK_ALLOWED_HOSTS` (DNS-rebinding guard) |
| CORS | echoes the validated origin, never `*` |
| Upload form | single-use CSRF token, capped body size |
| Non-loopback bind | refuses to start unless the access key is ≥ 24 chars |

Before exposing the agent over HTTPS: set a long `STATEARK_ACCESS_KEY`, set
`STATEARK_ALLOWED_HOSTS` to your tunnel hostname, and put a real reverse proxy in front.

## Platform reality

Local-first and hosted LLMs are different networking environments. Claude Desktop/Code and
other local MCP clients can talk to the local agent directly. A hosted ChatGPT/Gemini
client generally cannot reach `localhost` on your computer. For those you need either
(a) a secure HTTPS route to your running local agent, or (b) a StateArk cloud gateway that
reads the synced copy. Do not confuse a cloud container's filesystem with the user's device.

Recommended order for your own testing:

1. run StateArk locally;
2. test Savepoint/Resume from a local MCP client;
3. enable Supabase sync;
4. only then expose the agent securely or build the cloud gateway.

## Local-only Free mode

Leave `SUPABASE_URL`, `SUPABASE_SECRET_KEY` and `STATEARK_OWNER_ID` unset. Cloud sync stays
off and files never leave the machine. Default store: `~/StateArk`
(override with `STATEARK_LOCAL_ROOT`).

## Local + Supabase sync

Run the migrations in the Supabase SQL editor, in order:

1. `supabase/migrations/001_stateark.sql`
2. `supabase/migrations/002_artifacts.sql`
3. `supabase/migrations/003_hardening.sql`

Then set `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (server-side **Secret** key, never a
publishable key), `STATEARK_OWNER_ID`, and `STATEARK_STORAGE_BUCKET`.

Cloud is a mirror, not the master:

- the local savepoint is committed first and a cloud failure cannot invalidate it;
- cloud deletion does not delete local data;
- sync status lives in `meta.json` (`disabled` / `pending` / `synced` / `failed`);
- retry a failed push with the `sync_savepoint` tool.

Text/code artifacts up to 2 MB are mirrored inline in Postgres; everything else goes to the
private Storage bucket. **The mirror is not end-to-end encrypted.** Add client-side
encryption before selling a "private encrypted sync" tier.

## Savepoint behaviour

When you say `Savepoint`, the host LLM should:

- reconstruct the latest valid state rather than summarise chronology;
- retain governing decisions, requirements and constraints;
- keep rejected approaches only when the reason matters;
- send exact text/code as `transfer=text`;
- send binary bytes as `transfer=base64` only when truly available;
- otherwise mark the artifact `transfer=pending` instead of fabricating it;
- **omit** files that have not changed — they are carried forward automatically;
- **never** abbreviate a file with `... rest unchanged`.

Local creation is atomic: StateArk writes a temporary bundle and renames it only when
complete. Artifact names are sanitised; if a name had to be changed, `manifest.json`
records the original under `original_name`.

## Integrity checks

Every savepoint is compared against its predecessor. Findings are returned in the tool
result and rendered at the top of `state.md`. **The savepoint is always written** — a
check never costs you work, it only tells the model to come clean.

| Code | Meaning |
| --- | --- |
| `artifact_carried_forward` | file was not re-submitted and not declared deleted, so it was copied from the previous version |
| `artifact_became_pending` | content that was stored is now only pending |
| `artifact_shrank` | file collapsed to under 50% of its previous size |
| `truncation_marker` | stored text contains `... rest unchanged`, `[...]`, `… gekürzt` and similar |
| `no_change` | this savepoint is identical to the previous one |
| `journal_not_reflected` | decisions were journalled but the submitted state lists none |

## Journal

`note_event` records one short line per turning point, silently, and only for projects
that already exist in StateArk. Untracked projects return `tracked: false` and nothing is
written — that is the filter that keeps scratch conversations out.

At the next Savepoint the journal is consolidated into the new version and cleared. It is
never cleared before the savepoint is durably on disk.

Inspect pending entries with the `journal` tool. Nudging is based on entry count
(`STATEARK_JOURNAL_NUDGE_AT`, default 20), never on a timer.

## Diff

`diff_savepoints` with no version arguments compares the latest savepoint against its
predecessor: LCS line diff on the text fields, set diff on the lists, SHA-256 comparison on
the artifacts, plus an `attention` block for anything that looks like silent loss.

## Artifacts

Every stored artifact has a SHA-256. Pending files are explicit in `manifest.json` and in
the `resume_project` output, so the LLM cannot quietly pretend a file exists.

If a binary cannot travel through MCP, open the local upload page printed at startup and
attach it to the existing project/version. This resolves the pending manifest entry.

## Resume

`Resume My Project` returns `state.md` plus the artifact manifest. The LLM calls
`get_artifact` for exact text only when needed. For binaries it gets the verified local
path and hash rather than invented content.

## MCP clients

- **Claude Desktop / Claude Code / local MCP clients** — point them at the local
  Streamable HTTP endpoint.
- **ChatGPT web/mobile** — a hosted client cannot reach your `localhost`. Expose the agent
  through an authenticated HTTPS route (and set `STATEARK_ALLOWED_HOSTS`), or build the
  cloud gateway. Do not solve this by moving the source of truth into an ephemeral cloud
  filesystem.
- **Gemini** — same principle.

## Commercial split enabled by this architecture

**Free / Local:** unlimited Savepoint, Resume, History, artifacts, open format, no account.

**Pro / Sync (future):** cloud backup, multi-device continuity, remote Resume, and the
web/mobile gateway that makes cross-platform continuity actually work.

Note that "sync a folder" alone is weak as a paid tier — the format is open files, so a user
can point Dropbox or git at `~/StateArk` and get it for free. The defensible paid surface is
the **remote gateway** (reaching your state from a hosted LLM), not storage.

StateArk's promise: **Local by default. Continue anywhere when you choose to sync.**
