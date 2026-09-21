/** Slug helpers for path-like transfer IDs (e.g. folder/sub/file). */

const SEGMENT_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MAX_SLUG_LEN = 200;
const MAX_SEGMENT_LEN = 64;

export function isValidSlugSegment(seg: string): boolean {
  return SEGMENT_RE.test(seg) && seg.length >= 1 && seg.length <= MAX_SEGMENT_LEN;
}

/** Single segment or path of segments joined by `/`. */
export function isValidSlug(slug: string): boolean {
  if (!slug || slug.length < 1 || slug.length > MAX_SLUG_LEN) return false;
  if (slug.includes("//") || slug.startsWith("/") || slug.endsWith("/")) return false;
  const parts = slug.split("/");
  if (parts.length === 0 || parts.length > 32) return false;
  // Overall min length 3 for single-segment (legacy); multi-segment: each segment valid
  if (parts.length === 1) {
    return isValidSlugSegment(parts[0]!) && parts[0]!.length >= 3;
  }
  return parts.every((p) => isValidSlugSegment(p));
}

export function slugifySegment(raw: string, { minLength = 1 }: { minLength?: number } = {}): string {
  let s = (raw || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  s = s.toLowerCase();
  // Keep extension as hyphen suffix: report.pdf → report-pdf
  s = s.replace(/\./g, "-");
  s = s.replace(/[^a-z0-9]+/g, "-");
  s = s.replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!s) s = "file";
  if (s.length > MAX_SEGMENT_LEN) s = s.slice(0, MAX_SEGMENT_LEN).replace(/-$/, "");
  while (s.length < minLength) s = `${s}x`;
  if (!isValidSlugSegment(s)) {
    s = `f-${s}`.replace(/-+/g, "-").slice(0, MAX_SEGMENT_LEN);
  }
  return s;
}

/** Build slug from a file name (basename). */
export function slugFromFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() || filename;
  return slugifySegment(base, { minLength: 3 });
}

/**
 * Build path slug from webkitRelativePath or similar.
 * @param relativePath e.g. "MyFolder/sub/a.png"
 * @param rootSlug optional override for the first segment
 */
export function slugFromRelativePath(relativePath: string, rootSlug?: string): string {
  const cleaned = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length === 0) return slugFromFilename("file");
  const filePart = parts[parts.length - 1]!;
  const dirParts = parts.slice(0, -1);
  const segs: string[] = [];
  if (rootSlug) {
    segs.push(slugifySegment(rootSlug, { minLength: 3 }));
    for (const d of dirParts.slice(1)) segs.push(slugifySegment(d, { minLength: 1 }));
  } else {
    for (const d of dirParts) segs.push(slugifySegment(d, { minLength: dirParts.length === 1 ? 3 : 1 }));
    if (segs.length === 0) {
      /* single file in folder picker without dirs — use file name as root */
    }
  }
  segs.push(slugifySegment(filePart, { minLength: segs.length === 0 ? 3 : 1 }));
  let out = segs.join("/");
  if (out.length > MAX_SLUG_LEN) {
    const keep = segs[0]!;
    const leaf = segs[segs.length - 1]!;
    out = `${keep}/…/${leaf}`.replace("…", slugifySegment(segs.slice(1, -1).join("-") || "x", { minLength: 1 }));
    if (out.length > MAX_SLUG_LEN) out = out.slice(0, MAX_SLUG_LEN).replace(/\/$/, "");
  }
  return out;
}

export function parentSlug(slug: string): string | null {
  const i = slug.lastIndexOf("/");
  if (i <= 0) return null;
  return slug.slice(0, i);
}

export function slugLeaf(slug: string): string {
  const i = slug.lastIndexOf("/");
  return i >= 0 ? slug.slice(i + 1) : slug;
}

/** URL path under /share/d/… */
export function slugToUrlPath(slug: string): string {
  return slug.split("/").map(encodeURIComponent).join("/");
}
