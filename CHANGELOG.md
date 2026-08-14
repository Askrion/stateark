# Changelog

## v0.5.1 — One-line install

- **`npx stateark`** registers with Claude Desktop in a single command: no download, no
  unzip, no Gatekeeper, works on macOS and Windows. Backs up `claude_desktop_config.json`
  and leaves every other MCP server untouched.
- **`npx stateark report`** prints an anonymised local usage summary: project count,
  savepoints, how many projects reached a second savepoint, artifact types, source
  platforms, integrity-warning counts, active days. **No telemetry** - it is printed for the
  user to read and, if they choose, to copy and send. It contains no project names, no
  filenames and no content.
- **`npx stateark remove`** unregisters cleanly and says explicitly that savepoints are kept.
- Refuses to touch a `claude_desktop_config.json` that is not valid JSON.
- `LICENSE` added: source-available, non-commercial. **Placeholder wording - replace with a
  professionally drafted licence before publishing.**
- README rewritten as the npm landing page.
- Smoke suite grown to 84 checks, including the CLI's edits to the Claude config.

## v0.5.0 — Journal, integrity checks, diff

Answers the "the savepoint is only as good as a degraded context" problem without asking
the user to save more often. See `DESIGN-context.md` for the reasoning.

### Journal (silent, opt-in per project)

- New `note_event` tool. The model records one short line after a real turning point
  (decision, rejection, validated finding, new working artifact version) and consolidates
  the journal at the next Savepoint. It never announces these calls.
- **Tracking gate:** `note_event` refuses projects that do not exist in StateArk yet and
  returns `tracked: false`. A project becomes journal-tracked only after the user has
  deliberately run a Savepoint. Scratch conversations are never recorded. This is enforced
  server-side, not left to model judgement.
- Journal lives at `projects/<slug>/journal.ndjson`, is moved into the version directory on
  consolidation, and is never deleted before the savepoint is durably renamed into place.
- New `journal` tool to inspect pending entries.
- Nudging is based on accumulated entries (`STATEARK_JOURNAL_NUDGE_AT`, default 20), never
  on a timer.

### Integrity checks (deterministic, server-side)

Savepoints are now compared against their predecessor. All findings are reported as
warnings in the tool result and in `state.md` — **the savepoint is always written**, so a
check can never cost the user work.

- `artifact_carried_forward` — a file present in the previous version was neither
  re-submitted nor declared deleted, so it is **copied forward** with its original hash.
  Omitting an unchanged file is now the correct, safe behaviour; this removes the main
  cause of silent truncation rather than only detecting it.
- New `deleted_artifacts` parameter on `savepoint` for intentional removal.
- `truncation_marker` — the stored text contains `// ... rest unchanged`, `[...]`,
  `… gekürzt` and similar (English and German, word-anchored to limit false positives).
- `artifact_shrank` — a file collapsed to under 50% of its previous size.
- `artifact_became_pending` — content that was stored is now only pending.
- `no_change` — the savepoint is identical to its predecessor.
- `journal_not_reflected` — decisions were journalled but the submitted state lists none.
- `artifacts_mentioned_but_missing` — the state prose names a file (`schema_registry.sql`,
  `app.py`, ...) that was never handed over as an artifact. StateArk cannot read the
  conversation, so filenames in the prose are the only available clue that the model
  described a file instead of preserving it. The warning is phrased as a question, since a
  named file may legitimately be planned or live outside the conversation.
- `list_projects` and a failed lookup now always name the store path they searched, so an
  empty result can never be confused with an agent pointed at the wrong root.

**New `attach_artifact` tool.** Repairs an existing savepoint in place: it adds or replaces
one artifact, updates `manifest.json` and `state.md`, re-evaluates the integrity warnings
and drops the ones that are now resolved. **No new version is created** - correcting a
forgotten file is a repair, not a new project state. Defaults to the latest savepoint.
Until now this was only possible through the HTTP upload page, which does not exist in
stdio mode, so a Claude Desktop user had no way to fix a savepoint at all.
- Warnings are persisted in `meta.json` and rendered at the top of `state.md`.

### Finding a project again after weeks away

- `list_projects` was a bare name list. It now returns, most recent first: last update as a
  relative age, savepoint count, the latest savepoint's title, a one-line summary excerpt,
  the source platform, and how many journal entries are pending.
- **Forgiving lookup on read tools.** `resume_project`, `history`, `get_savepoint`,
  `get_artifact` and `diff_savepoints` now match on exact name, slug, normalised name
  ("State Ark" = "StateArk"), unique substring, and finally a bounded edit distance for
  typos. The resolved canonical name is stated back so follow-up calls use it.
- **Ambiguity is never guessed.** Several candidates means the tool lists them and asks.
- **Writes stay strict.** `savepoint` and `note_event` still require an exact name or slug
  hit, so a typo creates a new project instead of silently merging into an existing one.
  The v0.4 guarantee that "My Project" and "my-project!" stay separate is unchanged.
- `resume_project` now also surfaces unconsolidated journal entries and any unresolved
  integrity warnings from the savepoint being resumed.
- Smoke suite covers approximate-name lookup.

### Installation

- **New stdio entrypoint (`src/stdio.ts`).** Claude Desktop's `claude_desktop_config.json`
  can only launch stdio servers, and its Custom Connector UI cannot reach `localhost` at all
  (connectors are dialled from Anthropic's cloud). stdio removes the need for a tunnel or an
  `mcp-remote` bridge. All diagnostics go to stderr so stdout stays pure JSON-RPC.
- The MCP server definition moved to `src/mcp.ts` (`createStateArkServer`) so the HTTP and
  stdio entrypoints share exactly one implementation.
- `npm run build` (tsc) and `npm run install-claude-desktop`, which merges one entry into
  `claude_desktop_config.json` after backing the file up, leaving other servers untouched.
- `INSTALL.md` with a client-reachability table, both setup paths and troubleshooting.
- Smoke suite grown to 77 checks, including a real stdio handshake.

### Diff

- New `diff_savepoints` tool. With no version arguments it compares the latest savepoint
  against its predecessor.
- LCS line diff for the long text fields, set diff for the list fields, SHA-256 comparison
  for artifacts (added / removed / modified / unchanged / carried forward).
- An `attention` block surfaces removals, suspicious shrinkage and stored-to-pending
  regressions.

### Other

- Server instructions rewritten: explicit ban on truncation markers, explicit instruction
  to omit unchanged files rather than reproduce them, explicit journaling policy.
- Server instructions cover the approximate-name policy.

## v0.4.0 — Hardening (audit fixes on top of v0.3)

### Data integrity (these could silently corrupt savepoints in v0.3)

- **Duplicate artifact names.** Two artifacts named `a.py` in one savepoint wrote to the
  same file but produced two manifest entries with different SHA-256 values. One of those
  hashes was always wrong, and the Supabase insert violated `unique(savepoint_id, name)`
  so cloud sync failed permanently. Names are now de-duplicated (`a.py`, `a-2.py`).
- **Project slug collision.** `My Project` and `my-project!` both slugified to
  `my-project`, so two unrelated projects were merged into one version chain and
  `project.json.name` was overwritten. Lookup is now by exact name first; a colliding
  new project gets `my-project-2`.
- **A single bad artifact destroyed the whole savepoint.** An artifact named `..` resolved
  to the savepoint directory itself, `writeFile` threw `EISDIR`, and the entire session's
  work was rolled back. Filenames are now sanitised (no separators, no dot-names, no
  Windows reserved names) and each artifact is written in its own try/catch — a failure
  marks that one artifact `pending` with the reason instead of losing everything.
- **`project.json` was written non-atomically and outside the temp-dir/rename dance.**
  A crash mid-write corrupted the index, `readProjectByName` swallowed the parse error and
  returned `null`, versioning restarted at `v0.1`, and the `rename` then failed forever
  because `v0.1/` already existed. Now: atomic write, plus a self-healing rebuild of
  `project.json` from the `meta.json` files on disk.
- **Version numbers could be reused.** `nextVersion` trusted `project.json` alone. It now
  takes the maximum of the index *and* the directories actually present.
- **Concurrent savepoints raced** for the same version number. Saves are now serialised
  per project.
- **Path containment** is verified on every artifact read and write.
- Failed first saves no longer leave an empty orphan project directory behind.

### Security (the local agent was reachable from any web page)

- **Bound to `0.0.0.0`** — the whole LAN could reach the agent. Now `127.0.0.1` by default
  (`STATEARK_BIND`).
- **`Access-Control-Allow-Origin: *` on the MCP endpoint.** Any website you visited could
  read and write every savepoint. Origin is now validated (loopback plus an explicit
  allowlist) and echoed rather than wildcarded.
- **No `Host` validation** — classic DNS-rebinding exposure. Now enforced.
- **Default access key `local-dev`.** A random 24-byte key is generated on first run and
  stored in `<root>/.access-key` (mode 0600). The server refuses to start on a
  non-loopback bind with a weak key. Key comparison is constant-time.
- **Upload page had no CSRF protection**, so any web page could POST files into your
  savepoints. Single-use tokens now required.
- **HTML injection** — error messages were interpolated raw into the upload page. Escaped.
- **Unbounded upload body** buffered into memory. Now capped
  (`STATEARK_MAX_UPLOAD_BYTES`, default 100 MB), and the fragile
  `duplex: "half"` + raw-`req.headers` `Request` construction was replaced.
- Artifact size cap (`STATEARK_MAX_ARTIFACT_BYTES`, default 64 MB).

### Correctness / DX

- `npm run typecheck` was failing (`a.bytes` possibly undefined). Fixed.
- `.env.example` shipped **non-empty** Supabase placeholders, so copying it turned cloud
  sync on and every savepoint reported `failed`. It also hard-coded
  `STATEARK_LOCAL_ROOT=/Users/YOU/StateArk`, contradicting the documented `~/StateArk`
  default. Everything optional is now commented out.
- `sync_savepoint` threw a raw exception instead of returning a tool error.
- `get_artifact` returned a stray non-protocol `textLike` field.
- `resume_project` now lists the known project names when a lookup misses.
- Cloud sync: `upsert` instead of delete-then-insert (a mid-way failure no longer empties
  the cloud copy), chunked writes, and a stale-row cleanup pass.
- `manifest.json` records `original_name` when an artifact had to be renamed, and
  `meta.json` records `format_version`.
- Added `test/smoke.mjs` (`npm test`): 30 checks covering every bug above.

## v0.3.0 — Local-first

- Local filesystem is the source of truth; Supabase is optional sync/mirror.
- Open project format: `state.md`, `state.json`, `manifest.json`, `meta.json`, `artifacts/`.
- Atomic local savepoint creation via temporary directory + rename.
- Optional per-savepoint Supabase sync with explicit `pending/synced/failed` status.
- `sync_savepoint` tool for retrying cloud sync.
- Manual artifact upload writes to the local savepoint first.
- SHA-256 is part of every stored artifact manifest.
