import type { Env } from "./env";
import { type TransferMeta, META_PREFIX, metaKey } from "./meta";

export type DirEntry =
  | {
      kind: "file";
      name: string;
      slug: string;
      size: number;
      contentType: string;
      originalName: string;
      backend: TransferMeta["backend"];
      expiresAt: number;
    }
  | {
      kind: "dir";
      name: string;
      slug: string;
    };

async function loadMeta(env: Env, slug: string): Promise<TransferMeta | null> {
  const raw = await env.META.get(metaKey(slug));
  if (!raw) return null;
  return JSON.parse(raw) as TransferMeta;
}

/**
 * List immediate children under a directory slug prefix (e.g. "photos" → photos/a, photos/b/…).
 */
export async function listDirEntries(env: Env, dirSlug: string): Promise<DirEntry[]> {
  const prefix = `${META_PREFIX}${dirSlug}/`;
  const listed = await env.META.list({ prefix });
  const dirs = new Map<string, DirEntry>();
  const files: DirEntry[] = [];
  const now = Date.now();

  for (const key of listed.keys) {
    const slug = key.name.slice(META_PREFIX.length);
    if (!slug.startsWith(`${dirSlug}/`)) continue;
    const rest = slug.slice(dirSlug.length + 1);
    if (!rest) continue;
    const slash = rest.indexOf("/");
    if (slash >= 0) {
      const name = rest.slice(0, slash);
      const childSlug = `${dirSlug}/${name}`;
      if (!dirs.has(childSlug)) {
        dirs.set(childSlug, { kind: "dir", name, slug: childSlug });
      }
      continue;
    }
    const raw = await env.META.get(key.name);
    if (!raw) continue;
    const meta = JSON.parse(raw) as TransferMeta;
    if (meta.status !== "ready" || meta.expiresAt <= now) continue;
    files.push({
      kind: "file",
      name: rest,
      slug,
      size: meta.size,
      contentType: meta.contentType,
      originalName: meta.originalName,
      backend: meta.backend,
      expiresAt: meta.expiresAt,
    });
  }

  const entries = [...dirs.values(), ...files];
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

export async function resolveDlInfo(
  env: Env,
  slug: string,
): Promise<
  | { type: "file"; meta: TransferMeta }
  | { type: "dir"; slug: string; entries: DirEntry[]; expiresAt: number | null }
  | null
> {
  const meta = await loadMeta(env, slug);
  if (meta && meta.status === "ready" && meta.expiresAt > Date.now()) {
    return { type: "file", meta };
  }
  const entries = await listDirEntries(env, slug);
  if (entries.length === 0) return null;
  let expiresAt: number | null = null;
  for (const e of entries) {
    if (e.kind === "file") {
      expiresAt = expiresAt == null ? e.expiresAt : Math.min(expiresAt, e.expiresAt);
    }
  }
  return { type: "dir", slug, entries, expiresAt };
}
