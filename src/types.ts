import { z } from "zod";

export const ArtifactKind = z.enum([
  "code", "prompt", "document", "schema", "config", "archive", "image", "data", "other",
]);

const BASE64_RE = /^[A-Za-z0-9+/\r\n\t ]*={0,2}$/;

export const ArtifactSchema = z
  .object({
    name: z.string().min(1).max(255),
    kind: ArtifactKind.default("other"),
    mime_type: z.string().max(255).optional(),
    transfer: z.enum(["text", "base64", "pending"]),
    text_content: z.string().optional(),
    base64_content: z.string().optional(),
    note: z.string().max(2000).optional(),
  })
  .superRefine((a, ctx) => {
    if (a.transfer === "text" && a.text_content === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "text_content is required when transfer=text" });
    }
    if (a.transfer === "base64") {
      if (!a.base64_content) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "base64_content is required when transfer=base64" });
      } else if (!BASE64_RE.test(a.base64_content)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "base64_content is not valid base64" });
      }
    }
  });

export const StateSchema = z.object({
  executive_summary: z.string().min(1),
  current_state: z.string().min(1),
  decisions: z.array(z.string()).default([]),
  requirements: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]),
  validated_findings: z.array(z.string()).default([]),
  rejected_approaches: z.array(z.object({ approach: z.string(), reason: z.string() })).default([]),
  open_questions: z.array(z.string()).default([]),
  next_steps: z.array(z.string()).default([]),
  resume_instructions: z.string().min(1),
});

export type ArtifactInput = z.infer<typeof ArtifactSchema>;
export type ProjectState = z.infer<typeof StateSchema>;

export type ArtifactManifestEntry = {
  name: string;
  kind: string;
  mime_type?: string | null;
  status: "stored" | "pending";
  size_bytes?: number | null;
  sha256?: string | null;
  note?: string | null;
  relative_path?: string | null;
  /** Set when the artifact was renamed during sanitisation, so the caller can map it back. */
  original_name?: string | null;
  /** Set when the artifact was not re-submitted and was copied over from an earlier version. */
  carried_forward_from?: string | null;
};

export const JournalEventType = z.enum([
  "decision", "rejected", "artifact", "finding", "requirement", "question", "risk", "other",
]);

export const JournalEntrySchema = z.object({
  type: JournalEventType.default("other"),
  summary: z.string().min(1).max(500),
  detail: z.string().max(4000).optional(),
  session_id: z.string().max(120).optional(),
});

export type JournalEntryInput = z.infer<typeof JournalEntrySchema>;

export type JournalEntry = JournalEntryInput & {
  id: string;
  at: string;
  since_version: string | null;
};

export type SavepointMeta = {
  project_name: string;
  project_slug: string;
  version: string;
  major: number;
  minor: number;
  title?: string;
  checkpoint_type: "minor" | "major";
  source_platform: string;
  created_at: string;
  previous_version?: string | null;
  cloud_sync?: "disabled" | "pending" | "synced" | "failed";
  format_version?: number;
  integrity_warnings?: { code: string; artifact?: string; message: string }[];
  journal_entries_consumed?: number;
};

export type ProjectVersionEntry = {
  version: string;
  created_at: string;
  title: string | null;
  checkpoint_type: "minor" | "major";
};

export type ProjectIndex = {
  name: string;
  slug: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  latest_version: string | null;
  versions: ProjectVersionEntry[];
};
