import type { ArtifactManifestEntry, ProjectState } from "./types.js";
import type { Savepoint } from "./local-store.js";

/** Above this, a line-level diff is not worth the O(n*m) table. */
const MAX_DIFF_LINES = 3000;

export type TextDiff = {
  changed: boolean;
  added: string[];
  removed: string[];
};

export type ListDiff = {
  added: string[];
  removed: string[];
  unchanged_count: number;
};

export type ArtifactChange = {
  name: string;
  from_size: number | null;
  to_size: number | null;
  from_sha: string | null;
  to_sha: string | null;
  shrink_pct: number | null;
};

export type ArtifactDiff = {
  added: string[];
  removed: string[];
  modified: ArtifactChange[];
  unchanged: string[];
  carried_forward: string[];
  became_pending: string[];
};

export type SavepointDiff = {
  project: string;
  from_version: string;
  to_version: string;
  from_created_at: string;
  to_created_at: string;
  executive_summary: TextDiff;
  current_state: TextDiff;
  resume_instructions: TextDiff;
  decisions: ListDiff;
  requirements: ListDiff;
  constraints: ListDiff;
  assumptions: ListDiff;
  validated_findings: ListDiff;
  rejected_approaches: ListDiff;
  open_questions: ListDiff;
  next_steps: ListDiff;
  artifacts: ArtifactDiff;
  /** Deterministic red flags worth a human look. */
  attention: string[];
};

// ----------------------------------------------------------------- text diff

function lines(s: string | undefined): string[] {
  return String(s ?? "").replace(/\r\n/g, "\n").split("\n");
}

/** Longest-common-subsequence diff over lines. Falls back to a set diff on huge inputs. */
export function diffText(a: string | undefined, b: string | undefined): TextDiff {
  const A = lines(a), B = lines(b);
  if (A.join("\n") === B.join("\n")) return { changed: false, added: [], removed: [] };

  if (A.length > MAX_DIFF_LINES || B.length > MAX_DIFF_LINES) {
    const setA = new Set(A), setB = new Set(B);
    return {
      changed: true,
      added: B.filter((l) => !setA.has(l) && l.trim()),
      removed: A.filter((l) => !setB.has(l) && l.trim()),
    };
  }

  // table[i][j] = LCS length of A[i:] and B[j:]
  const table: number[][] = Array.from({ length: A.length + 1 }, () => new Array<number>(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--) {
    for (let j = B.length - 1; j >= 0; j--) {
      table[i][j] = A[i] === B[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const added: string[] = [], removed: string[] = [];
  let i = 0, j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) { i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) { if (A[i].trim()) removed.push(A[i]); i++; }
    else { if (B[j].trim()) added.push(B[j]); j++; }
  }
  for (; i < A.length; i++) if (A[i].trim()) removed.push(A[i]);
  for (; j < B.length; j++) if (B[j].trim()) added.push(B[j]);

  return { changed: true, added, removed };
}

export function diffList(a: string[] | undefined, b: string[] | undefined): ListDiff {
  const A = a ?? [], B = b ?? [];
  const setA = new Set(A), setB = new Set(B);
  return {
    added: B.filter((x) => !setA.has(x)),
    removed: A.filter((x) => !setB.has(x)),
    unchanged_count: A.filter((x) => setB.has(x)).length,
  };
}

function rejectedAsStrings(state: ProjectState): string[] {
  return (state.rejected_approaches ?? []).map((r) => `${r.approach} — ${r.reason}`);
}

// ------------------------------------------------------------- artifact diff

export function diffArtifacts(from: ArtifactManifestEntry[], to: ArtifactManifestEntry[]): ArtifactDiff {
  const byName = (xs: ArtifactManifestEntry[]) => new Map(xs.map((x) => [x.name, x]));
  const A = byName(from), B = byName(to);

  const added: string[] = [];
  const removed: string[] = [];
  const modified: ArtifactChange[] = [];
  const unchanged: string[] = [];
  const carried_forward: string[] = [];
  const became_pending: string[] = [];

  for (const [name, b] of B) {
    if (b.carried_forward_from) carried_forward.push(name);
    const a = A.get(name);
    if (!a) { added.push(name); continue; }
    if (a.status === "stored" && b.status === "pending") became_pending.push(name);
    if (a.sha256 && b.sha256 && a.sha256 === b.sha256) { unchanged.push(name); continue; }
    if (a.status === "pending" && b.status === "pending") { unchanged.push(name); continue; }
    const fromSize = a.size_bytes ?? null;
    const toSize = b.size_bytes ?? null;
    modified.push({
      name,
      from_size: fromSize,
      to_size: toSize,
      from_sha: a.sha256 ?? null,
      to_sha: b.sha256 ?? null,
      shrink_pct: fromSize && toSize != null && fromSize > 0
        ? Math.round((1 - toSize / fromSize) * 100)
        : null,
    });
  }
  for (const name of A.keys()) if (!B.has(name)) removed.push(name);

  return { added, removed, modified, unchanged, carried_forward, became_pending };
}

// ------------------------------------------------------------------ assemble

export function diffSavepoints(from: Savepoint, to: Savepoint): SavepointDiff {
  const artifacts = diffArtifacts(from.manifest, to.manifest);

  const attention: string[] = [];
  for (const name of artifacts.removed) {
    attention.push(`"${name}" existed in ${from.meta.version} and is gone in ${to.meta.version}.`);
  }
  for (const name of artifacts.became_pending) {
    attention.push(`"${name}" was stored in ${from.meta.version} but is only "pending" in ${to.meta.version} - content may have been lost.`);
  }
  for (const m of artifacts.modified) {
    if (m.shrink_pct != null && m.shrink_pct >= 50 && (m.from_size ?? 0) > 200) {
      attention.push(`"${m.name}" shrank by ${m.shrink_pct}% (${m.from_size} -> ${m.to_size} bytes). Check for truncated content.`);
    }
  }
  if (artifacts.carried_forward.length) {
    attention.push(`Carried forward unchanged because they were not re-submitted: ${artifacts.carried_forward.join(", ")}.`);
  }

  const d = (k: keyof ProjectState) => diffList(from.state[k] as string[], to.state[k] as string[]);

  return {
    project: to.meta.project_name,
    from_version: from.meta.version,
    to_version: to.meta.version,
    from_created_at: from.meta.created_at,
    to_created_at: to.meta.created_at,
    executive_summary: diffText(from.state.executive_summary, to.state.executive_summary),
    current_state: diffText(from.state.current_state, to.state.current_state),
    resume_instructions: diffText(from.state.resume_instructions, to.state.resume_instructions),
    decisions: d("decisions"),
    requirements: d("requirements"),
    constraints: d("constraints"),
    assumptions: d("assumptions"),
    validated_findings: d("validated_findings"),
    rejected_approaches: diffList(rejectedAsStrings(from.state), rejectedAsStrings(to.state)),
    open_questions: d("open_questions"),
    next_steps: d("next_steps"),
    artifacts,
    attention,
  };
}

// ------------------------------------------------------------------- render

function renderTextDiff(title: string, t: TextDiff, out: string[]) {
  if (!t.changed) return;
  out.push("", `### ${title}`);
  for (const l of t.removed) out.push(`- ${l}`);
  for (const l of t.added) out.push(`+ ${l}`);
}

function renderListDiff(title: string, l: ListDiff, out: string[]) {
  if (!l.added.length && !l.removed.length) return;
  out.push("", `### ${title}`);
  for (const x of l.removed) out.push(`- ${x}`);
  for (const x of l.added) out.push(`+ ${x}`);
}

export function renderDiffMarkdown(d: SavepointDiff): string {
  const out: string[] = [
    `# ${d.project}: ${d.from_version} to ${d.to_version}`,
    "",
    `> ${d.from_created_at} to ${d.to_created_at}`,
  ];

  if (d.attention.length) {
    out.push("", "## Needs attention");
    for (const a of d.attention) out.push(`- ${a}`);
  }

  out.push("", "## State");
  const before = out.length;
  renderTextDiff("Executive summary", d.executive_summary, out);
  renderTextDiff("Canonical current state", d.current_state, out);
  renderListDiff("Decisions", d.decisions, out);
  renderListDiff("Requirements", d.requirements, out);
  renderListDiff("Constraints", d.constraints, out);
  renderListDiff("Assumptions", d.assumptions, out);
  renderListDiff("Validated findings", d.validated_findings, out);
  renderListDiff("Rejected approaches", d.rejected_approaches, out);
  renderListDiff("Open questions", d.open_questions, out);
  renderListDiff("Next steps", d.next_steps, out);
  renderTextDiff("Resume instructions", d.resume_instructions, out);
  if (out.length === before) out.push("", "_No state changes._");

  out.push("", "## Artifacts");
  const a = d.artifacts;
  if (a.added.length) out.push(`- **Added:** ${a.added.join(", ")}`);
  if (a.removed.length) out.push(`- **Removed:** ${a.removed.join(", ")}`);
  for (const m of a.modified) {
    const size = m.from_size != null && m.to_size != null ? ` (${m.from_size} -> ${m.to_size} bytes)` : "";
    out.push(`- **Modified:** ${m.name}${size}`);
  }
  if (a.carried_forward.length) out.push(`- **Carried forward:** ${a.carried_forward.join(", ")}`);
  if (a.unchanged.length) out.push(`- **Unchanged:** ${a.unchanged.join(", ")}`);
  if (!a.added.length && !a.removed.length && !a.modified.length && !a.carried_forward.length && !a.unchanged.length) {
    out.push("- _No artifacts in either savepoint._");
  }

  out.push("");
  return out.join("\n");
}
