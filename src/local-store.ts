import { createHash, randomUUID } from "node:crypto";
import { appendFile, copyFile, mkdir, readFile, readdir, rename, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import type {
  ArtifactInput, ArtifactManifestEntry, JournalEntry, JournalEntryInput,
  ProjectIndex, ProjectState, ProjectVersionEntry, SavepointMeta,
} from "./types.js";
import {
  assessShrink, findTruncationMarker, looksTextual, mentionedFilenames, type IntegrityWarning,
} from "./integrity.js";

export const JOURNAL_FILE = "journal.ndjson";
/** How many un-consolidated journal entries before note_event starts nudging. */
export const JOURNAL_NUDGE_AT = Number(process.env.STATEARK_JOURNAL_NUDGE_AT ?? 20);

export const VERSION_RE = /^v(\d+)\.(\d+)$/;
export const FORMAT_VERSION = 1;

/** Hard ceiling for a single artifact written into a savepoint. */
export const MAX_ARTIFACT_BYTES = Number(process.env.STATEARK_MAX_ARTIFACT_BYTES ?? 64 * 1024 * 1024);

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]", "g");
const COMBINING_MARKS = new RegExp("[\\u0300-\\u036f]", "g");

export function slugify(v: string): string {
  return (
    String(v ?? "")
      .toLowerCase()
      .trim()
      .normalize("NFKD")
      .replace(COMBINING_MARKS, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "project"
  );
}

/**
 * Reduce an arbitrary LLM-supplied artifact name to one safe path segment.
 * Guarantees: no path separators, no "." or "..", no control characters,
 * no leading dots, no Windows-illegal characters or reserved device names.
 */
export function safeFilename(raw: string): string {
  let v = String(raw ?? "");
  v = v.replace(/\\/g, "/");
  v = v.split("/").pop() ?? "";
  v = v.normalize("NFC").trim();
  v = v.replace(CONTROL_CHARS, "");
  v = v.replace(/[<>:"|?*]/g, "_");
  v = v.replace(/\s+/g, " ").trim();
  v = v.replace(/^\.+/, "");
  v = v.replace(/[. ]+$/, "");
  if (WINDOWS_RESERVED.test(v)) v = `_${v}`;
  if (v.length > 180) {
    const ext = path.extname(v).slice(0, 20);
    v = v.slice(0, 180 - ext.length) + ext;
  }
  return v || "artifact.bin";
}

/** Make `name` unique within `used`, preserving the extension. */
export function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) { used.add(name); return name; }
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 2; i < 1000; i++) {
    const c = `${base}-${i}${ext}`;
    if (!used.has(c)) { used.add(c); return c; }
  }
  const c = `${base}-${randomUUID().slice(0, 8)}${ext}`;
  used.add(c);
  return c;
}

export function sha256(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

/** "State Ark", "stateark" and "State-Ark" all collapse to the same key. */
export function normalizeName(v: string): string {
  return String(v ?? "").toLowerCase().normalize("NFKD").replace(COMBINING_MARKS, "").replace(/[^a-z0-9]/g, "");
}

/** Levenshtein, bailing out once the distance cannot beat `max`. */
export function editDistance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

function cmpVersion(a: string, b: string): number {
  const ma = VERSION_RE.exec(a), mb = VERSION_RE.exec(b);
  if (!ma || !mb) return a.localeCompare(b);
  return Number(ma[1]) - Number(mb[1]) || Number(ma[2]) - Number(mb[2]);
}

/** Crash-safe JSON write: temp file plus atomic rename. */
async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.tmp-${randomUUID()}`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, file);
}

/** Same, for newline-delimited JSON. */
async function writeJsonLinesAtomic(file: string, rows: unknown[]): Promise<void> {
  const tmp = `${file}.tmp-${randomUUID()}`;
  await writeFile(tmp, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  await rename(tmp, file);
}

/** Resolve `rel` inside `base`, refusing anything that escapes it. */
export function resolveInside(base: string, rel: string): string | null {
  const root = path.resolve(base);
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

/**
 * Filenames the prose talks about that were never handed over as bytes.
 * Shared by savepoint creation and by attach_artifact, so a fixed savepoint
 * actually drops the warning instead of keeping a stale one.
 */
export function missingArtifactWarning(
  state: ProjectState,
  manifest: ArtifactManifestEntry[],
  deleted: string[] = [],
): IntegrityWarning | null {
  const prose = [
    state.executive_summary, state.current_state, state.resume_instructions,
    ...(state.decisions ?? []), ...(state.requirements ?? []), ...(state.constraints ?? []),
    ...(state.next_steps ?? []), ...(state.open_questions ?? []), ...(state.validated_findings ?? []),
  ].join("\n");

  const have = new Set<string>();
  for (const m of manifest) {
    have.add(m.name.toLowerCase());
    if (m.original_name) have.add(m.original_name.toLowerCase());
  }
  for (const d of deleted) have.add(safeFilename(d).toLowerCase());

  const missing = mentionedFilenames(prose)
    .filter((n) => !have.has(n.toLowerCase()) && !have.has(safeFilename(n).toLowerCase()));
  if (!missing.length) return null;

  const shown = missing.slice(0, 8).join(", ");
  return {
    code: "artifacts_mentioned_but_missing",
    message:
      `The state text refers to ${shown}${missing.length > 8 ? ` and ${missing.length - 8} more` : ""}, ` +
      "but no matching artifact was submitted. If any of these exist as real content in this " +
      "conversation, attach them with attach_artifact - a described file is not a preserved file. " +
      "If they are only planned or belong to files outside this conversation, this warning can be ignored.",
  };
}

export type Savepoint = {
  meta: SavepointMeta;
  state: ProjectState;
  manifest: ArtifactManifestEntry[];
  markdown: string;
  dir: string;
};

type SaveArgs = {
  project_name: string;
  project_description?: string;
  checkpoint_type: "minor" | "major";
  title?: string;
  source_platform: string;
  state: ProjectState;
  artifacts: ArtifactInput[];
  /** Artifacts intentionally dropped. Anything else missing is carried forward, not lost. */
  deleted_artifacts?: string[];
};

export class LocalStore {
  /** Per-project serialisation so two concurrent savepoints cannot claim the same version. */
  private locks = new Map<string, Promise<unknown>>();

  constructor(public root: string) {}

  projectsRoot() { return path.join(this.root, "projects"); }
  projectDir(slug: string) { return path.join(this.projectsRoot(), slug); }
  versionDir(slug: string, version: string) { return path.join(this.projectDir(slug), version); }

  async init() { await mkdir(this.projectsRoot(), { recursive: true }); }

  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(key, next.then(() => undefined, () => undefined));
    return next;
  }

  // ---------------------------------------------------------------- indexes

  /** Read project.json; if it is missing or corrupt, rebuild it from the version directories. */
  async readProjectBySlug(slug: string): Promise<ProjectIndex | null> {
    try {
      const p = JSON.parse(await readFile(path.join(this.projectDir(slug), "project.json"), "utf8"));
      if (p && typeof p.name === "string" && Array.isArray(p.versions)) {
        return { ...p, slug } as ProjectIndex;
      }
    } catch { /* fall through to rebuild */ }
    return this.rebuildIndex(slug);
  }

  /** Self-healing: reconstruct project.json purely from what is on disk. */
  async rebuildIndex(slug: string): Promise<ProjectIndex | null> {
    let entries;
    try { entries = await readdir(this.projectDir(slug), { withFileTypes: true }); }
    catch { return null; }

    const versions: ProjectVersionEntry[] = [];
    let name: string | null = null;
    for (const e of entries) {
      if (!e.isDirectory() || !VERSION_RE.test(e.name)) continue;
      let meta: Partial<SavepointMeta> = {};
      try { meta = JSON.parse(await readFile(path.join(this.versionDir(slug, e.name), "meta.json"), "utf8")); }
      catch { /* still record the directory so the version number is never reused */ }
      versions.push({
        version: e.name,
        created_at: meta.created_at ?? new Date(0).toISOString(),
        title: meta.title ?? null,
        checkpoint_type: meta.checkpoint_type ?? "minor",
      });
      if (!name && meta.project_name) name = meta.project_name;
    }
    if (!versions.length) return null;
    versions.sort((a, b) => cmpVersion(a.version, b.version));

    const idx: ProjectIndex = {
      name: name ?? slug,
      slug,
      description: null,
      created_at: versions[0].created_at,
      updated_at: versions[versions.length - 1].created_at,
      latest_version: versions[versions.length - 1].version,
      versions,
    };
    try { await writeJsonAtomic(path.join(this.projectDir(slug), "project.json"), idx); } catch { /* read-only fs */ }
    return idx;
  }

  async listProjects(): Promise<ProjectIndex[]> {
    await this.init();
    const dirs = await readdir(this.projectsRoot(), { withFileTypes: true });
    const out: ProjectIndex[] = [];
    for (const d of dirs) {
      if (!d.isDirectory() || d.name.startsWith(".")) continue;
      const p = await this.readProjectBySlug(d.name);
      if (p) out.push(p);
    }
    return out.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  }

  /** Match on the exact project name first, then on slug. Stops "My Project" and "my-project!" from merging. */
  async readProjectByName(name: string): Promise<ProjectIndex | null> {
    const all = await this.listProjects();
    const n = String(name ?? "").trim().toLowerCase();
    return (
      all.find((p) => p.name.trim().toLowerCase() === n) ??
      all.find((p) => p.slug === slugify(name)) ??
      null
    );
  }

  /**
   * Forgiving lookup for READ operations only.
   *
   * Writes (save, note_event) deliberately stay strict via readProjectByName: guessing on a
   * read is recoverable, guessing on a write silently merges two projects. Ambiguity is never
   * resolved by picking one - the candidates are returned so the caller can ask.
   */
  async findProjectFuzzy(name: string): Promise<{
    match: ProjectIndex | null;
    candidates: ProjectIndex[];
    how: "exact" | "slug" | "normalized" | "substring" | "typo" | "none";
  }> {
    const all = await this.listProjects();
    const raw = String(name ?? "").trim();
    const n = raw.toLowerCase();

    const exact = all.find((p) => p.name.trim().toLowerCase() === n);
    if (exact) return { match: exact, candidates: [], how: "exact" };

    const bySlug = all.find((p) => p.slug === slugify(raw));
    if (bySlug) return { match: bySlug, candidates: [], how: "slug" };

    const q = normalizeName(raw);
    if (!q) return { match: null, candidates: all, how: "none" };

    const norm = all.filter((p) => normalizeName(p.name) === q);
    if (norm.length === 1) return { match: norm[0], candidates: [], how: "normalized" };
    if (norm.length > 1) return { match: null, candidates: norm, how: "normalized" };

    if (q.length >= 3) {
      const sub = all.filter((p) => {
        const pn = normalizeName(p.name);
        return pn.includes(q) || q.includes(pn);
      });
      if (sub.length === 1) return { match: sub[0], candidates: [], how: "substring" };
      if (sub.length > 1) return { match: null, candidates: sub, how: "substring" };
    }

    const budget = Math.min(3, Math.max(1, Math.floor(q.length * 0.25)));
    const scored = all
      .map((p) => ({ p, d: editDistance(q, normalizeName(p.name), budget) }))
      .filter((x) => x.d <= budget)
      .sort((a, b) => a.d - b.d);
    if (scored.length === 1 || (scored.length > 1 && scored[0].d < scored[1].d)) {
      return { match: scored[0].p, candidates: [], how: "typo" };
    }
    if (scored.length > 1) return { match: null, candidates: scored.map((x) => x.p), how: "typo" };

    return { match: null, candidates: all, how: "none" };
  }

  /** Everything needed to recognise a project again after weeks away. */
  async summarizeProjects(): Promise<{
    name: string; slug: string; latest_version: string | null; savepoint_count: number;
    updated_at: string; title: string | null; headline: string | null;
    source_platform: string | null; pending_journal: number;
  }[]> {
    const all = await this.listProjects();
    const out = [];
    for (const p of all) {
      let title: string | null = null;
      let headline: string | null = null;
      let source: string | null = null;
      if (p.latest_version) {
        const sp = await this.loadBySlug(p.slug, p.latest_version);
        if (sp) {
          title = sp.meta.title ?? null;
          source = sp.meta.source_platform ?? null;
          const s = String(sp.state?.executive_summary ?? "").replace(/\s+/g, " ").trim();
          headline = s.length > 160 ? `${s.slice(0, 157)}...` : s || null;
        }
      }
      out.push({
        name: p.name,
        slug: p.slug,
        latest_version: p.latest_version,
        savepoint_count: p.versions.length,
        updated_at: p.updated_at,
        title, headline,
        source_platform: source,
        pending_journal: (await this.readJournalUnlocked(p.slug)).length,
      });
    }
    return out;
  }

  async history(name: string): Promise<ProjectVersionEntry[]> {
    return (await this.readProjectByName(name))?.versions ?? [];
  }

  async latest(name: string): Promise<Savepoint | null> {
    const p = await this.readProjectByName(name);
    if (!p?.latest_version) return null;
    return this.loadBySlug(p.slug, p.latest_version);
  }

  /** A free slug for a new project, or the existing slug for a known project name. */
  private async resolveSlug(name: string): Promise<string> {
    const all = await this.listProjects();
    const n = name.trim().toLowerCase();
    const exact = all.find((p) => p.name.trim().toLowerCase() === n);
    if (exact) return exact.slug;
    const taken = new Set(all.map((p) => p.slug));
    const base = slugify(name);
    if (!taken.has(base)) return base;
    for (let i = 2; i < 1000; i++) {
      const c = `${base}-${i}`;
      if (!taken.has(c)) return c;
    }
    return `${base}-${randomUUID().slice(0, 8)}`;
  }

  /** Highest version on disk OR in the index, whichever is greater. Never reuses a number. */
  private async nextVersion(slug: string, type: "minor" | "major"): Promise<{ major: number; minor: number }> {
    const idx = await this.readProjectBySlug(slug);
    const names = new Set<string>(idx?.versions.map((v) => v.version) ?? []);
    try {
      for (const e of await readdir(this.projectDir(slug), { withFileTypes: true })) {
        if (e.isDirectory() && VERSION_RE.test(e.name)) names.add(e.name);
      }
    } catch { /* project dir does not exist yet */ }

    let major = -1, minor = -1;
    for (const v of names) {
      const m = VERSION_RE.exec(v);
      if (!m) continue;
      const ma = Number(m[1]), mi = Number(m[2]);
      if (ma > major || (ma === major && mi > minor)) { major = ma; minor = mi; }
    }
    if (major < 0) return type === "major" ? { major: 1, minor: 0 } : { major: 0, minor: 1 };
    return type === "major" ? { major: major + 1, minor: 0 } : { major, minor: minor + 1 };
  }

  // ------------------------------------------------------------------ write

  async save(args: SaveArgs) {
    await this.init();
    return this.withLock(args.project_name.trim().toLowerCase(), () => this.saveUnlocked(args));
  }

  private async saveUnlocked(args: SaveArgs) {
    const slug = await this.resolveSlug(args.project_name);
    const existing = await this.readProjectBySlug(slug);
    const v = await this.nextVersion(slug, args.checkpoint_type);
    const version = `v${v.major}.${v.minor}`;

    // The previous savepoint is the reference for carry-forward and integrity checks.
    const prev = existing?.latest_version ? await this.loadBySlug(slug, existing.latest_version) : null;
    const journalEntries = await this.readJournalUnlocked(slug);

    const projectDir = this.projectDir(slug);
    const finalDir = this.versionDir(slug, version);
    const tmpDir = path.join(projectDir, `.tmp-${version}-${randomUUID()}`);
    const createdAt = new Date().toISOString();
    const manifest: ArtifactManifestEntry[] = [];
    const used = new Set<string>();
    const warnings: IntegrityWarning[] = [];

    await mkdir(path.join(tmpDir, "artifacts"), { recursive: true });
    try {
      for (const input of args.artifacts ?? []) {
        const original = String(input.name ?? "");
        const name = uniqueName(safeFilename(original), used);
        const renamed = name !== original ? original : null;
        let bytes: Buffer | null = null;
        let rel: string | null = null;
        let note = input.note ?? null;
        let status: "stored" | "pending" = input.transfer === "pending" ? "pending" : "stored";

        try {
          if (input.transfer === "text") bytes = Buffer.from(input.text_content ?? "", "utf8");
          else if (input.transfer === "base64") bytes = Buffer.from(input.base64_content ?? "", "base64");

          if (bytes && bytes.length > MAX_ARTIFACT_BYTES) {
            throw new Error(`exceeds STATEARK_MAX_ARTIFACT_BYTES (${bytes.length} > ${MAX_ARTIFACT_BYTES})`);
          }
          if (bytes) {
            rel = path.join("artifacts", name);
            const full = resolveInside(tmpDir, rel);
            if (!full) throw new Error("resolved artifact path escapes the savepoint directory");
            await writeFile(full, bytes);
          }
        } catch (e: unknown) {
          // One bad artifact must never destroy the whole savepoint.
          bytes = null; rel = null; status = "pending";
          const msg = e instanceof Error ? e.message : String(e);
          note = `${note ? note + " | " : ""}StateArk: not stored (${msg})`;
        }

        // A model that summarises a file instead of reproducing it usually says so.
        if (bytes && looksTextual(bytes)) {
          const marker = findTruncationMarker(bytes.toString("utf8"));
          if (marker) {
            warnings.push({
              code: "truncation_marker",
              artifact: name,
              message: `"${name}" contains a truncation marker (${marker}). The stored file is probably not the complete artifact.`,
            });
          }
        }

        manifest.push({
          name,
          kind: input.kind,
          mime_type: input.mime_type ?? null,
          status,
          size_bytes: bytes?.length ?? null,
          sha256: bytes ? sha256(bytes) : null,
          note,
          relative_path: rel,
          original_name: renamed,
          carried_forward_from: null,
        });
      }

      // ---- carry forward anything the model simply forgot to re-submit -----
      const submitted = new Set(manifest.map((m) => m.name));
      const deleted = new Set((args.deleted_artifacts ?? []).map((n) => safeFilename(n)));

      for (const old of prev?.manifest ?? []) {
        if (submitted.has(old.name) || deleted.has(old.name)) continue;
        if (old.status !== "stored" || !old.relative_path) continue;
        const from = resolveInside(prev!.dir, old.relative_path);
        const rel = path.join("artifacts", old.name);
        const to = resolveInside(tmpDir, rel);
        if (!from || !to) continue;
        try {
          await copyFile(from, to);
          manifest.push({ ...old, relative_path: rel, carried_forward_from: prev!.meta.version });
          warnings.push({
            code: "artifact_carried_forward",
            artifact: old.name,
            message: `"${old.name}" was not re-submitted and was not declared deleted, so it was carried forward unchanged from ${prev!.meta.version}. Confirm it is still current.`,
          });
        } catch { /* source unreadable: nothing to carry, leave it out */ }
      }

      // ---- compare against the previous savepoint --------------------------
      if (prev) {
        const prevByName = new Map(prev.manifest.map((m) => [m.name, m]));
        for (const entry of manifest) {
          if (entry.carried_forward_from) continue;
          const old = prevByName.get(entry.name);
          if (!old) continue;

          if (old.status === "stored" && entry.status === "pending") {
            warnings.push({
              code: "artifact_became_pending",
              artifact: entry.name,
              message: `"${entry.name}" was stored in ${prev.meta.version} but is only "pending" now. Its content may have been lost.`,
            });
            continue;
          }
          const shrink = assessShrink(old, entry);
          if (shrink.suspicious) {
            warnings.push({
              code: "artifact_shrank",
              artifact: entry.name,
              message: `"${entry.name}" shrank by ${shrink.pct}% (${old.size_bytes} -> ${entry.size_bytes} bytes) versus ${prev.meta.version}. Check for truncated content.`,
            });
          }
        }

        const sameState = JSON.stringify(prev.state) === JSON.stringify(args.state);
        const sameArtifacts =
          manifest.length === prev.manifest.length &&
          manifest.every((m) => prevByName.get(m.name)?.sha256 === m.sha256);
        if (sameState && sameArtifacts) {
          warnings.push({
            code: "no_change",
            message: `This savepoint is identical to ${prev.meta.version}. Nothing from this session was captured.`,
          });
        }
      }

      // ---- files the prose talks about but that were never handed over -----
      // StateArk cannot read the conversation, so a model that forgets to attach a file
      // would otherwise fail completely silently. Names in the prose are the one clue.
      {
        const w = missingArtifactWarning(args.state, manifest, args.deleted_artifacts ?? []);
        if (w) warnings.push(w);
      }

      // ---- journal entries that never made it into the state ---------------
      if (journalEntries.length) {
        const declared = [
          ...(args.state.decisions ?? []),
          ...(args.state.rejected_approaches ?? []).map((r) => r.approach),
          ...(args.state.validated_findings ?? []),
          ...(args.state.requirements ?? []),
          ...(args.state.open_questions ?? []),
          ...(args.state.next_steps ?? []),
        ].join("\n").toLowerCase();
        const substantive = journalEntries.filter(
          (e) => e.type === "decision" || e.type === "rejected" || e.type === "finding" || e.type === "requirement",
        );
        if (substantive.length && !declared.trim()) {
          warnings.push({
            code: "journal_not_reflected",
            message: `${substantive.length} journal entr${substantive.length === 1 ? "y" : "ies"} recorded decisions or findings during this session, but the submitted state lists none. The full journal is preserved in ${version}/${JOURNAL_FILE}.`,
          });
        }
      }

      const meta: SavepointMeta = {
        project_name: args.project_name,
        project_slug: slug,
        version, major: v.major, minor: v.minor,
        title: args.title,
        checkpoint_type: args.checkpoint_type,
        source_platform: args.source_platform,
        created_at: createdAt,
        previous_version: existing?.latest_version ?? null,
        cloud_sync: "disabled",
        format_version: FORMAT_VERSION,
        integrity_warnings: warnings,
        journal_entries_consumed: journalEntries.length,
      };
      const md = renderMarkdown(args.project_name, version, args.title, args.state, manifest, createdAt, warnings);

      await writeFile(path.join(tmpDir, "state.json"), JSON.stringify(args.state, null, 2), "utf8");
      await writeFile(path.join(tmpDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
      await writeFile(path.join(tmpDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
      await writeFile(path.join(tmpDir, "state.md"), md, "utf8");
      if (journalEntries.length) {
        await writeFile(
          path.join(tmpDir, JOURNAL_FILE),
          journalEntries.map((e) => JSON.stringify(e)).join("\n") + "\n",
          "utf8",
        );
      }

      await mkdir(projectDir, { recursive: true });
      await rename(tmpDir, finalDir); // atomic publish; fails loudly if the version already exists

      // The journal is only cleared once the savepoint is durably published.
      if (journalEntries.length) await this.clearJournalUnlocked(slug, journalEntries.length);

      const versions = [
        ...(existing?.versions ?? []).filter((x) => x.version !== version),
        { version, created_at: createdAt, title: args.title ?? null, checkpoint_type: args.checkpoint_type },
      ].sort((a, b) => cmpVersion(a.version, b.version));

      const project: ProjectIndex = {
        name: args.project_name,
        slug,
        description: args.project_description ?? existing?.description ?? null,
        created_at: existing?.created_at ?? createdAt,
        updated_at: createdAt,
        latest_version: versions[versions.length - 1].version,
        versions,
      };
      await writeJsonAtomic(path.join(projectDir, "project.json"), project);

      return {
        project, meta, state: args.state, manifest, markdown: md, dir: finalDir,
        warnings, journal_consumed: journalEntries.length,
      };
    } catch (e) {
      await rm(tmpDir, { recursive: true, force: true });
      if (!existing) {
        // Do not leave an empty orphan project directory behind after a failed first save.
        try {
          const left = await readdir(projectDir);
          if (left.length === 0) await rm(projectDir, { recursive: true, force: true });
        } catch { /* ignore */ }
      }
      throw e;
    }
  }

  // ------------------------------------------------------------------- read

  async loadBySlug(slug: string, version: string): Promise<Savepoint | null> {
    if (!VERSION_RE.test(version)) return null;
    const dir = this.versionDir(slug, version);
    try {
      return {
        meta: JSON.parse(await readFile(path.join(dir, "meta.json"), "utf8")),
        state: JSON.parse(await readFile(path.join(dir, "state.json"), "utf8")),
        manifest: JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")),
        markdown: await readFile(path.join(dir, "state.md"), "utf8"),
        dir,
      };
    } catch { return null; }
  }

  async load(name: string, version: string): Promise<Savepoint | null> {
    const p = await this.readProjectByName(name);
    if (!p) return null;
    return this.loadBySlug(p.slug, version);
  }

  async getArtifact(name: string, version: string, artifactName: string) {
    const sp = await this.load(name, version);
    if (!sp) return null;
    const wanted = safeFilename(artifactName);
    const a = sp.manifest.find((x) => x.name === wanted) ?? sp.manifest.find((x) => x.original_name === artifactName);
    if (!a) return null;
    if (a.status === "pending" || !a.relative_path) {
      return { entry: a, pending: true as const, bytes: null, full: null };
    }
    const full = resolveInside(sp.dir, a.relative_path);
    if (!full) return null;
    const bytes = await readFile(full);
    return { entry: a, pending: false as const, bytes, full };
  }

  // ----------------------------------------------------------------- mutate

  async attachFile(
    projectName: string, version: string | null, filename: string, bytes: Buffer, mime?: string, note?: string,
  ) {
    const p = await this.readProjectByName(projectName) ?? (await this.findProjectFuzzy(projectName)).match;
    if (!p) throw new Error(`Unknown project "${projectName}"`);
    version = version ?? p.latest_version;
    if (!version) throw new Error(`"${p.name}" has no savepoints yet`);
    if (!VERSION_RE.test(version)) throw new Error("Invalid version (expected vMAJOR.MINOR, e.g. v0.3)");
    return this.withLock(p.name.trim().toLowerCase(), async () => {
      const sp = await this.loadBySlug(p.slug, version);
      if (!sp) throw new Error(`Savepoint ${version} not found for "${p.name}"`);
      if (bytes.length > MAX_ARTIFACT_BYTES) throw new Error("File exceeds STATEARK_MAX_ARTIFACT_BYTES");

      const name = safeFilename(filename);
      const rel = path.join("artifacts", name);
      const full = resolveInside(sp.dir, rel);
      if (!full) throw new Error("Refusing to write outside the savepoint directory");
      await mkdir(path.join(sp.dir, "artifacts"), { recursive: true });
      await writeFile(full, bytes);

      const prev = sp.manifest.find((x) => x.name === name);
      const entry: ArtifactManifestEntry = {
        name,
        kind: prev?.kind ?? "other",
        mime_type: mime || prev?.mime_type || "application/octet-stream",
        status: "stored",
        size_bytes: bytes.length,
        sha256: sha256(bytes),
        note: note || prev?.note || "Manually attached",
        relative_path: rel,
        original_name: prev?.original_name ?? null,
      };
      const manifest = prev
        ? sp.manifest.map((x) => (x.name === name ? entry : x))  // replace in place, keep ordering
        : [...sp.manifest, entry];

      await writeJsonAtomic(path.join(sp.dir, "manifest.json"), manifest);

      // Re-evaluate: this artifact is no longer missing, and warnings about it are stale.
      const warnings = ((sp.meta.integrity_warnings ?? []) as IntegrityWarning[])
        .filter((w) => w.artifact !== name && w.code !== "artifacts_mentioned_but_missing");
      const stillMissing = missingArtifactWarning(sp.state, manifest);
      if (stillMissing) warnings.push(stillMissing);
      sp.meta.integrity_warnings = warnings;
      await writeJsonAtomic(path.join(sp.dir, "meta.json"), sp.meta);

      const md = renderMarkdown(
        sp.meta.project_name, version, sp.meta.title, sp.state, manifest, sp.meta.created_at, warnings,
      );
      await writeFile(path.join(sp.dir, "state.md"), md, "utf8");
      return { entry, version, dir: sp.dir, remaining_warnings: warnings };
    });
  }

  // ---------------------------------------------------------------- journal

  private journalPath(slug: string) { return path.join(this.projectDir(slug), JOURNAL_FILE); }

  private async readJournalUnlocked(slug: string): Promise<JournalEntry[]> {
    let raw: string;
    try { raw = await readFile(this.journalPath(slug), "utf8"); } catch { return []; }
    const out: JournalEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as JournalEntry); } catch { /* skip a torn line */ }
    }
    return out;
  }

  /** Drop the first `count` entries; anything appended since stays pending. */
  private async clearJournalUnlocked(slug: string, count: number): Promise<void> {
    const all = await this.readJournalUnlocked(slug);
    const rest = all.slice(count);
    const file = this.journalPath(slug);
    if (!rest.length) { await rm(file, { force: true }); return; }
    await writeJsonLinesAtomic(file, rest);
  }

  /**
   * Append one journal entry. Refuses unknown projects on purpose: a project only
   * becomes journal-tracked once the user has deliberately saved or resumed it,
   * so scratch conversations are never recorded.
   */
  async appendJournal(projectName: string, entry: JournalEntryInput) {
    const p = await this.readProjectByName(projectName);
    if (!p) return { tracked: false as const, pending: 0, since_version: null, project_name: projectName };
    return this.withLock(p.name.trim().toLowerCase(), async () => {
      const record: JournalEntry = {
        id: randomUUID(),
        at: new Date().toISOString(),
        since_version: p.latest_version,
        type: entry.type,
        summary: entry.summary,
        ...(entry.detail ? { detail: entry.detail } : {}),
        ...(entry.session_id ? { session_id: entry.session_id } : {}),
      };
      await mkdir(this.projectDir(p.slug), { recursive: true });
      await appendFile(this.journalPath(p.slug), JSON.stringify(record) + "\n", "utf8");
      const pending = await this.readJournalUnlocked(p.slug);
      return {
        tracked: true as const,
        pending: pending.length,
        since_version: p.latest_version,
        project_name: p.name,
      };
    });
  }

  async readJournal(projectName: string): Promise<JournalEntry[]> {
    const p = await this.readProjectByName(projectName);
    if (!p) return [];
    return this.readJournalUnlocked(p.slug);
  }

  async setCloudSync(name: string, version: string, status: SavepointMeta["cloud_sync"]) {
    const sp = await this.load(name, version);
    if (!sp) return;
    sp.meta.cloud_sync = status;
    await writeJsonAtomic(path.join(sp.dir, "meta.json"), sp.meta);
  }
}

export function renderMarkdown(
  project: string, version: string, title: string | undefined,
  state: ProjectState, artifacts: ArtifactManifestEntry[], createdAt: string,
  warnings: IntegrityWarning[] = [],
): string {
  const l: string[] = [
    `# ${project} — ${version}`, "",
    `> StateArk Savepoint · ${createdAt}${title ? ` · ${title}` : ""}`, "",
  ];
  if (warnings.length) {
    l.push("## Integrity warnings", ...warnings.map((w) => `- **${w.code}** — ${w.message}`), "");
  }
  l.push(
    "## Executive summary", state.executive_summary, "",
    "## Canonical current state", state.current_state,
  );
  const add = (h: string, x: string[] | undefined) => {
    const items = x ?? [];
    l.push("", `## ${h}`, ...(items.length ? items.map((v) => `- ${v}`) : ["- None recorded."]));
  };
  add("Decisions", state.decisions);
  add("Requirements", state.requirements);
  add("Constraints", state.constraints);
  add("Assumptions", state.assumptions);
  add("Validated findings", state.validated_findings);

  const rejected = state.rejected_approaches ?? [];
  l.push("", "## Rejected approaches",
    ...(rejected.length ? rejected.map((x) => `- **${x.approach}** — ${x.reason}`) : ["- None recorded."]));

  add("Open questions", state.open_questions);
  add("Next steps", state.next_steps);

  l.push("", "## Artifact manifest");
  if (!artifacts.length) l.push("- No artifacts recorded.");
  for (const a of artifacts) {
    const bits = [
      a.kind, a.status,
      a.size_bytes != null ? `${a.size_bytes} bytes` : null,
      a.sha256 ? `sha256:${a.sha256}` : null,
      a.original_name ? `renamed from "${a.original_name}"` : null,
      a.note,
    ].filter(Boolean);
    l.push(`- **${a.name}** — ${bits.join(" · ")}`);
  }
  l.push("", "## Resume instructions", state.resume_instructions, "");
  return l.join("\n");
}
