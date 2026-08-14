import type { ArtifactManifestEntry } from "./types.js";

export type IntegrityWarning = {
  code:
    | "artifact_carried_forward"
    | "artifact_became_pending"
    | "artifact_shrank"
    | "truncation_marker"
    | "no_change"
    | "journal_not_reflected"
    | "artifacts_mentioned_but_missing";
  artifact?: string;
  message: string;
};

/** Extensions worth treating as "this is a file the session probably produced". */
const FILE_EXT =
  "sql|py|ts|tsx|js|jsx|mjs|cjs|json|md|sh|bash|ps1|ya?ml|toml|ini|csv|tsv|xml|html|css|scss|" +
  "ipynb|go|rs|java|rb|php|swift|kt|scala|c|cc|cpp|h|hpp|cs|txt|zip|tar|gz|xlsx|xls|docx|pptx|pdf";

const FILENAME_RE = new RegExp(
  `\\b([A-Za-z0-9_][A-Za-z0-9._\\-]{0,60})\\.(${FILE_EXT})\\b`,
  "gi",
);

/**
 * Filenames named in the prose of a savepoint. StateArk cannot see the conversation, so this
 * is the only signal available that the session handled a file the model then failed to attach.
 */
export function mentionedFilenames(text: string): string[] {
  const out = new Set<string>();
  for (const m of String(text ?? "").matchAll(FILENAME_RE)) {
    const name = m[0];
    // Skip things that are almost certainly a domain or a version string.
    if (/^\d+(\.\d+)*$/.test(name)) continue;
    out.add(name);
  }
  return [...out];
}

/**
 * Markers a model emits when it is summarising a file instead of reproducing it.
 * Word-anchored to keep false positives low: a bare "..." is not enough.
 */
const TRUNCATION_MARKERS = new RegExp(
  "^[ \\t]*(?:\\/\\/|#|--|\\/\\*|\\*|<!--|;)?[ \\t]*(?:\\.\\.\\.|\\u2026|\\[\\.\\.\\.\\])[ \\t]*" +
  "\\(?(?:the )?(?:rest|remainder|remaining|unchanged|omitted|snip|snipped|truncated|abbreviated|" +
  "same as (?:before|above|previous)|as (?:before|above)|previous(?:ly)?|" +
  "rest wie|unver\\u00e4ndert|gek\\u00fcrzt|weitere|wie oben|wie gehabt)",
  "im",
);

/** A second, stricter shape: "// ... (rest of file unchanged)" style on its own line. */
const TRUNCATION_PARENTHETICAL = new RegExp(
  "\\((?:\\.\\.\\.|\\u2026)?[ \\t]*(?:rest|remainder|remaining)[ \\t]+of[ \\t]+(?:the[ \\t]+)?" +
  "(?:file|code|function|class|content)[ \\t]+(?:is[ \\t]+)?(?:unchanged|omitted|the same)",
  "i",
);

export function findTruncationMarker(text: string): string | null {
  const m = TRUNCATION_MARKERS.exec(text) ?? TRUNCATION_PARENTHETICAL.exec(text);
  return m ? m[0].trim().slice(0, 120) : null;
}

/** Text-ish content is worth scanning for truncation markers; binaries are not. */
export function looksTextual(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, 4096);
  if (sample.includes(0)) return false;
  let weird = 0;
  for (const b of sample) if (b < 9 || (b > 13 && b < 32)) weird++;
  return weird / Math.max(sample.length, 1) < 0.05;
}

export type ShrinkVerdict = { suspicious: boolean; pct: number };

/** Only flag a real collapse of a file that had substance to begin with. */
export function assessShrink(
  prev: ArtifactManifestEntry | undefined,
  next: ArtifactManifestEntry,
  minPrevBytes = 200,
  thresholdPct = 50,
): ShrinkVerdict {
  const from = prev?.size_bytes ?? null;
  const to = next.size_bytes ?? null;
  if (from == null || to == null || from < minPrevBytes) return { suspicious: false, pct: 0 };
  const pct = Math.round((1 - to / from) * 100);
  return { suspicious: pct >= thresholdPct, pct };
}
