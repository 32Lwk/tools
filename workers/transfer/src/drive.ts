import type { Env } from "./env";
import type { DrivePrefs } from "./meta";
import { gdrivePrefsKey } from "./meta";
import { getAccessTokenForEmail } from "./google";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";

export async function getDrivePrefs(env: Env, email: string): Promise<DrivePrefs | null> {
  const raw = await env.META.get(gdrivePrefsKey(email));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DrivePrefs;
  } catch {
    return null;
  }
}

export async function putDrivePrefs(env: Env, prefs: DrivePrefs): Promise<void> {
  await env.META.put(gdrivePrefsKey(prefs.email), JSON.stringify(prefs));
}

async function driveFetch(
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${accessToken}`);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return fetch(`${DRIVE_API}${path}`, { ...init, headers });
}

export async function findOrCreateFolder(
  accessToken: string,
  folderName: string,
): Promise<{ id: string; name: string }> {
  const q = encodeURIComponent(
    `mimeType='application/vnd.google-apps.folder' and name='${folderName.replace(/'/g, "\\'")}' and trashed=false`,
  );
  const listRes = await driveFetch(
    accessToken,
    `/files?q=${q}&fields=files(id,name)&pageSize=1&spaces=drive`,
  );
  const listJson = (await listRes.json()) as {
    files?: { id: string; name: string }[];
    error?: { message?: string };
  };
  if (!listRes.ok) {
    throw new Error(listJson.error?.message || "Drive folder search failed");
  }
  const existing = listJson.files?.[0];
  if (existing) return existing;

  const createRes = await driveFetch(accessToken, "/files?fields=id,name", {
    method: "POST",
    body: JSON.stringify({
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
    }),
  });
  const created = (await createRes.json()) as {
    id?: string;
    name?: string;
    error?: { message?: string };
  };
  if (!createRes.ok || !created.id) {
    throw new Error(created.error?.message || "Drive folder create failed");
  }
  return { id: created.id, name: created.name || folderName };
}

export async function verifyDriveFile(
  accessToken: string,
  fileId: string,
): Promise<{ id: string; name: string; size: string; mimeType: string } | null> {
  const res = await driveFetch(
    accessToken,
    `/files/${encodeURIComponent(fileId)}?fields=id,name,size,mimeType,trashed`,
  );
  if (res.status === 404) return null;
  const json = (await res.json()) as {
    id?: string;
    name?: string;
    size?: string;
    mimeType?: string;
    trashed?: boolean;
    error?: { message?: string };
  };
  if (!res.ok || !json.id || json.trashed) {
    if (!res.ok) throw new Error(json.error?.message || "Drive file lookup failed");
    return null;
  }
  return {
    id: json.id,
    name: json.name || "file",
    size: json.size || "0",
    mimeType: json.mimeType || "application/octet-stream",
  };
}

export async function streamDriveFile(
  accessToken: string,
  fileId: string,
): Promise<Response> {
  const res = await fetch(
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  return res;
}

/** Client does resumable upload; Worker only mints metadata + access token. */
export function driveUploadEndpoints(): { resumableCreate: string } {
  return {
    resumableCreate: `${DRIVE_UPLOAD}/files?uploadType=resumable&fields=id,name,size,mimeType`,
  };
}

export async function requireDriveAccessToken(
  env: Env,
  email: string | undefined,
): Promise<{ accessToken: string; email: string } | { error: string; status: number }> {
  if (!email) {
    return { error: "Google アカウントでログインしてください", status: 401 };
  }
  try {
    const tok = await getAccessTokenForEmail(env, email);
    if (!tok) {
      return { error: "Google Drive が未接続です。Google でログインしてください", status: 401 };
    }
    return tok;
  } catch (e) {
    return {
      error: e instanceof Error ? e.message : "Google token refresh failed",
      status: 401,
    };
  }
}
