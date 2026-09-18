import type { Env } from "./env";
import { GDRIVE_PREFIX, OAUTH_STATE_PREFIX, gdriveKey } from "./meta";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO = "https://www.googleapis.com/oauth2/v3/userinfo";
const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/drive.file",
].join(" ");

export type StoredGoogleTokens = {
  email: string;
  refreshToken: string;
  updatedAt: number;
};

function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function googleConfigured(env: Env): boolean {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.TOKEN_ENC_KEY);
}

export function googleRedirectUri(env: Env, requestUrl: URL): string {
  if (env.GOOGLE_REDIRECT_URI) return env.GOOGLE_REDIRECT_URI;
  return `${requestUrl.origin}/share/api/auth/google/callback`;
}

async function importAesKey(env: Env): Promise<CryptoKey> {
  const raw = env.TOKEN_ENC_KEY!.trim();
  let keyBytes: Uint8Array;

  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    keyBytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) keyBytes[i] = Number.parseInt(raw.slice(i * 2, i * 2 + 2), 16);
  } else {
    try {
      const bin = atob(raw);
      if (bin.length === 32) {
        keyBytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) keyBytes[i] = bin.charCodeAt(i);
      } else {
        // Treat as passphrase → SHA-256
        keyBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)));
      }
    } catch {
      keyBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)));
    }
  }

  return crypto.subtle.importKey("raw", keyBytes as BufferSource, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

async function encryptJson(env: Env, data: unknown): Promise<string> {
  const key = await importAesKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(data));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain);
  return `${b64url(iv)}.${b64url(cipher)}`;
}

async function decryptJson<T>(env: Env, packed: string): Promise<T> {
  const [ivB64, cipherB64] = packed.split(".");
  if (!ivB64 || !cipherB64) throw new Error("encrypted payload invalid");
  const key = await importAesKey(env);
  const iv = fromB64url(ivB64);
  const cipher = fromB64url(cipherB64);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

export async function createOauthState(env: Env, returnTo: string): Promise<string> {
  const state = b64url(crypto.getRandomValues(new Uint8Array(24)));
  await env.META.put(
    `${OAUTH_STATE_PREFIX}${state}`,
    JSON.stringify({ returnTo, createdAt: Date.now() }),
    { expirationTtl: 600 },
  );
  return state;
}

export async function consumeOauthState(
  env: Env,
  state: string,
): Promise<{ returnTo: string } | null> {
  const key = `${OAUTH_STATE_PREFIX}${state}`;
  const raw = await env.META.get(key);
  if (!raw) return null;
  await env.META.delete(key);
  try {
    return JSON.parse(raw) as { returnTo: string };
  } catch {
    return null;
  }
}

export function buildGoogleAuthUrl(env: Env, requestUrl: URL, state: string): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: googleRedirectUri(env, requestUrl),
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${GOOGLE_AUTH}?${params}`;
}

export async function exchangeGoogleCode(
  env: Env,
  requestUrl: URL,
  code: string,
): Promise<{ accessToken: string; refreshToken?: string; email: string }> {
  const body = new URLSearchParams({
    code,
    client_id: env.GOOGLE_CLIENT_ID!,
    client_secret: env.GOOGLE_CLIENT_SECRET!,
    redirect_uri: googleRedirectUri(env, requestUrl),
    grant_type: "authorization_code",
  });
  const tokenRes = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const tokenJson = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!tokenRes.ok || !tokenJson.access_token) {
    throw new Error(tokenJson.error_description || tokenJson.error || "token exchange failed");
  }

  const infoRes = await fetch(GOOGLE_USERINFO, {
    headers: { authorization: `Bearer ${tokenJson.access_token}` },
  });
  const info = (await infoRes.json()) as { email?: string; error?: string };
  if (!infoRes.ok || !info.email) {
    throw new Error(info.error || "userinfo failed");
  }
  const email = info.email.toLowerCase();

  const allow = (env.UPLOAD_ALLOW_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (allow.length && !allow.includes(email)) {
    throw new Error("許可されていない Google アカウントです");
  }

  if (tokenJson.refresh_token) {
    await saveRefreshToken(env, email, tokenJson.refresh_token);
  } else {
    const existing = await loadStoredTokens(env, email);
    if (!existing) {
      throw new Error(
        "refresh token が取得できませんでした。Google 連携を一度解除してから再試行してください",
      );
    }
  }

  return {
    accessToken: tokenJson.access_token,
    refreshToken: tokenJson.refresh_token,
    email,
  };
}

export async function saveRefreshToken(env: Env, email: string, refreshToken: string): Promise<void> {
  const payload: StoredGoogleTokens = {
    email: email.toLowerCase(),
    refreshToken,
    updatedAt: Date.now(),
  };
  const packed = await encryptJson(env, payload);
  await env.META.put(gdriveKey(email), packed);
}

export async function loadStoredTokens(env: Env, email: string): Promise<StoredGoogleTokens | null> {
  const raw = await env.META.get(gdriveKey(email));
  if (!raw) return null;
  try {
    return await decryptJson<StoredGoogleTokens>(env, raw);
  } catch {
    return null;
  }
}

export async function getAccessTokenForEmail(
  env: Env,
  email: string,
): Promise<{ accessToken: string; email: string } | null> {
  const stored = await loadStoredTokens(env, email);
  if (!stored) return null;
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    client_secret: env.GOOGLE_CLIENT_SECRET!,
    refresh_token: stored.refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !json.access_token) {
    throw new Error(json.error_description || json.error || "refresh failed");
  }
  return { accessToken: json.access_token, email: stored.email };
}

export async function listConnectedEmails(env: Env): Promise<string[]> {
  const listed = await env.META.list({ prefix: GDRIVE_PREFIX });
  return listed.keys.map((k) => k.name.slice(GDRIVE_PREFIX.length));
}
