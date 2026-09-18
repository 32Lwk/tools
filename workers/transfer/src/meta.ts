export type TransferMetaBase = {
  slug: string;
  status: "pending" | "ready";
  passwordHash: string;
  passwordSalt: string;
  size: number;
  contentType: string;
  originalName: string;
  createdAt: number;
  expiresAt: number;
  /** Google account that owns Drive file (drive backend only). */
  ownerEmail?: string;
};

export type R2TransferMeta = TransferMetaBase & {
  backend: "r2";
  r2Key: string;
  uploadId?: string;
};

export type DriveTransferMeta = TransferMetaBase & {
  backend: "drive";
  driveFolderId: string;
  driveFileId?: string;
};

export type TransferMeta = R2TransferMeta | DriveTransferMeta;

export type DlTokenRecord = {
  slug: string;
  exp: number;
};

export type DrivePrefs = {
  email: string;
  folderId: string;
  folderName: string;
  updatedAt: number;
};

export const META_PREFIX = "meta:";
export const TOKEN_PREFIX = "dltoken:";
export const GDRIVE_PREFIX = "gdrive:";
export const GDRIVE_PREFS_PREFIX = "gprefs:";
export const OAUTH_STATE_PREFIX = "oauth:";

export function metaKey(slug: string): string {
  return `${META_PREFIX}${slug}`;
}

export function tokenKey(token: string): string {
  return `${TOKEN_PREFIX}${token}`;
}

export function gdriveKey(email: string): string {
  return `${GDRIVE_PREFIX}${email.toLowerCase()}`;
}

export function gdrivePrefsKey(email: string): string {
  return `${GDRIVE_PREFS_PREFIX}${email.toLowerCase()}`;
}

export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(slug) && slug.length >= 3 && slug.length <= 64;
}
