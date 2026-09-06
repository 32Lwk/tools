export type TransferMeta = {
  slug: string;
  backend: "r2";
  status: "pending" | "ready";
  passwordHash: string;
  passwordSalt: string;
  size: number;
  contentType: string;
  originalName: string;
  r2Key: string;
  uploadId?: string;
  createdAt: number;
  expiresAt: number;
};

export type DlTokenRecord = {
  slug: string;
  exp: number;
};

export const META_PREFIX = "meta:";
export const SLOT_KEY = "slot:r2-active";
export const TOKEN_PREFIX = "dltoken:";

export function metaKey(slug: string): string {
  return `${META_PREFIX}${slug}`;
}

export function tokenKey(token: string): string {
  return `${TOKEN_PREFIX}${token}`;
}

export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(slug) && slug.length >= 3 && slug.length <= 64;
}
