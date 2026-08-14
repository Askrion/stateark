import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";
import { resolveInside, type LocalStore } from "./local-store.js";

const TEXT_KINDS = /^(code|prompt|schema|config)$/;
const TEXT_EXT = /\.(md|txt|py|js|ts|tsx|jsx|json|sql|yaml|yml|toml|csv|xml|html|css|sh|ps1)$/i;
const MAX_INLINE_TEXT = 2_000_000;
const INSERT_CHUNK = 100;

export function isTextLike(kind: string, name: string): boolean {
  return TEXT_KINDS.test(kind) || TEXT_EXT.test(name);
}

export class SupabaseSync {
  client: SupabaseClient;
  bucket: string;
  owner: string;

  constructor(url: string, key: string, owner: string, bucket = "stateark-artifacts") {
    this.client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    this.owner = owner;
    this.bucket = bucket;
  }

  async push(local: LocalStore, projectName: string, version: string) {
    const sp = await local.load(projectName, version);
    if (!sp) throw new Error("Local savepoint not found");
    const slug = sp.meta.project_slug;

    // 1. project row
    const found = await this.client
      .from("stateark_projects").select("*")
      .eq("owner_id", this.owner).eq("slug", slug).maybeSingle();
    if (found.error) throw found.error;

    let project = found.data;
    if (!project) {
      const r = await this.client
        .from("stateark_projects")
        .insert({ owner_id: this.owner, slug, name: sp.meta.project_name })
        .select("*").single();
      if (r.error) throw r.error;
      project = r.data;
    } else if (project.name !== sp.meta.project_name) {
      await this.client.from("stateark_projects").update({ name: sp.meta.project_name }).eq("id", project.id);
    }

    // 2. savepoint row
    const savepointRow = {
      owner_id: this.owner,
      project_id: project.id,
      version_major: sp.meta.major,
      version_minor: sp.meta.minor,
      title: sp.meta.title ?? null,
      checkpoint_type: sp.meta.checkpoint_type,
      source_platform: sp.meta.source_platform,
      state: sp.state,
      rendered_markdown: sp.markdown,
    };
    const upserted = await this.client
      .from("stateark_savepoints")
      .upsert(savepointRow, { onConflict: "project_id,version_major,version_minor" })
      .select("*").single();
    if (upserted.error) throw upserted.error;
    const savepoint = upserted.data;

    // 3. artifact rows. Names are unique per savepoint (enforced locally), so upsert is safe
    //    and, unlike delete-then-insert, never leaves the cloud copy empty on a mid-way failure.
    const artifactRows: Record<string, unknown>[] = [];
    for (const a of sp.manifest) {
      let storage_path: string | null = null;
      let text_content: string | null = null;

      if (a.status === "stored" && a.relative_path) {
        const full = resolveInside(sp.dir, a.relative_path);
        if (!full) throw new Error(`Refusing to read artifact outside the savepoint: ${a.name}`);
        const bytes = await readFile(full);
        if (isTextLike(a.kind, a.name) && bytes.length <= MAX_INLINE_TEXT) {
          text_content = bytes.toString("utf8");
        } else {
          storage_path = `${this.owner}/${slug}/${version}/${a.name}`;
          const u = await this.client.storage.from(this.bucket).upload(storage_path, bytes, {
            contentType: a.mime_type ?? "application/octet-stream",
            upsert: true,
          });
          if (u.error) throw u.error;
        }
      }

      artifactRows.push({
        owner_id: this.owner,
        project_id: project.id,
        savepoint_id: savepoint.id,
        name: a.name,
        kind: a.kind,
        mime_type: a.mime_type ?? null,
        storage_path,
        text_content,
        size_bytes: a.size_bytes ?? null,
        sha256: a.sha256 ?? null,
        status: a.status,
        note: a.note ?? null,
      });
    }

    for (let i = 0; i < artifactRows.length; i += INSERT_CHUNK) {
      const chunk = artifactRows.slice(i, i + INSERT_CHUNK);
      const r = await this.client
        .from("stateark_artifacts")
        .upsert(chunk, { onConflict: "savepoint_id,name" });
      if (r.error) throw r.error;
    }

    // 4. drop cloud rows for artifacts that no longer exist in this savepoint
    const keep = artifactRows.map((r) => r.name as string);
    const del = this.client.from("stateark_artifacts").delete()
      .eq("owner_id", this.owner).eq("savepoint_id", savepoint.id);
    const r4 = keep.length
      ? await del.not("name", "in", `(${keep.map((n) => `"${n.replace(/"/g, '""')}"`).join(",")})`)
      : await del;
    if (r4.error) throw r4.error;

    await this.client.from("stateark_projects")
      .update({ updated_at: new Date().toISOString() }).eq("id", project.id);

    await local.setCloudSync(projectName, version, "synced");
    return { project: sp.meta.project_name, version, artifacts: artifactRows.length };
  }
}
