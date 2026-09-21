/** Browser-side slug helpers (mirrors workers/transfer/src/slug.ts). */

const SEGMENT_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MAX_SLUG_LEN = 200;
const MAX_SEGMENT_LEN = 64;

export function isValidSlugSegment(seg) {
  return SEGMENT_RE.test(seg) && seg.length >= 1 && seg.length <= MAX_SEGMENT_LEN;
}

export function isValidSlug(slug) {
  if (!slug || slug.length < 1 || slug.length > MAX_SLUG_LEN) return false;
  if (slug.includes("//") || slug.startsWith("/") || slug.endsWith("/")) return false;
  const parts = slug.split("/");
  if (parts.length === 0 || parts.length > 32) return false;
  if (parts.length === 1) {
    return isValidSlugSegment(parts[0]) && parts[0].length >= 3;
  }
  return parts.every((p) => isValidSlugSegment(p));
}

export function slugifySegment(raw, { minLength = 1 } = {}) {
  let s = (raw || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  s = s.toLowerCase();
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

export function slugFromFilename(filename) {
  const base = filename.split(/[/\\]/).pop() || filename;
  return slugifySegment(base, { minLength: 3 });
}

export function slugFromRelativePath(relativePath, rootSlug) {
  const cleaned = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length === 0) return slugFromFilename("file");
  const filePart = parts[parts.length - 1];
  const dirParts = parts.slice(0, -1);
  const segs = [];
  if (rootSlug) {
    segs.push(slugifySegment(rootSlug, { minLength: 3 }));
    for (const d of dirParts.slice(1)) segs.push(slugifySegment(d, { minLength: 1 }));
  } else {
    for (let i = 0; i < dirParts.length; i++) {
      segs.push(slugifySegment(dirParts[i], { minLength: i === 0 ? 3 : 1 }));
    }
  }
  segs.push(slugifySegment(filePart, { minLength: segs.length === 0 ? 3 : 1 }));
  let out = segs.join("/");
  if (out.length > MAX_SLUG_LEN) {
    const keep = segs[0];
    const leaf = segs[segs.length - 1];
    const mid = slugifySegment(segs.slice(1, -1).join("-") || "x", { minLength: 1 });
    out = `${keep}/${mid}/${leaf}`;
    if (out.length > MAX_SLUG_LEN) out = out.slice(0, MAX_SLUG_LEN).replace(/\/$/, "");
  }
  return out;
}

export function rootSlugFromFiles(files) {
  const first = files[0];
  const rel = first?.webkitRelativePath || first?.name || "folder";
  const top = rel.replace(/\\/g, "/").split("/").filter(Boolean)[0] || "folder";
  return slugifySegment(top, { minLength: 3 });
}

export function slugToUrlPath(slug) {
  return slug.split("/").map(encodeURIComponent).join("/");
}
