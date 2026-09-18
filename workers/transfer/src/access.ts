import type { Env } from "./env";
import { googleConfigured } from "./google";

const SESSION_COOKIE = "tools_transfer_up";
const SESSION_TTL_SEC = 12 * 3600;
const SESSION_KV_PREFIX = "upses:";

export type UploadSessionInfo = {
  email?: string;
  mode: "google" | "gate" | "dev" | "session";
};

export type AuthIdentity = {
  authenticated: true;
  email?: string;
  mode: "access" | "google" | "gate" | "dev" | "session";
  accessLogoutUrl?: string;
};

function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function parseCookies(request: Request): Record<string, string> {
  const raw = request.headers.get("Cookie") || "";
  const out: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function sessionCookieHeader(token: string, maxAge = SESSION_TTL_SEC): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearSessionCookieHeader(): string {
  return sessionCookieHeader("", 0);
}

export async function createUploadSession(
  env: Env,
  info: UploadSessionInfo = { mode: "session" },
): Promise<{ token: string; setCookie: string }> {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await env.META.put(`${SESSION_KV_PREFIX}${token}`, JSON.stringify(info), {
    expirationTtl: SESSION_TTL_SEC,
  });
  return { token, setCookie: sessionCookieHeader(token) };
}

export async function destroyUploadSession(request: Request, env: Env): Promise<string> {
  const cookies = parseCookies(request);
  const token = cookies[SESSION_COOKIE];
  if (token) await env.META.delete(`${SESSION_KV_PREFIX}${token}`);
  return clearSessionCookieHeader();
}

async function readUploadSession(
  request: Request,
  env: Env,
): Promise<UploadSessionInfo | null> {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token || token.length < 16) return null;
  const hit = await env.META.get(`${SESSION_KV_PREFIX}${token}`);
  if (!hit) return null;
  if (hit === "1") return { mode: "session" };
  try {
    return JSON.parse(hit) as UploadSessionInfo;
  } catch {
    return { mode: "session" };
  }
}

function allowlistEmails(env: Env): string[] {
  return (env.UPLOAD_ALLOW_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = atob(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function accessConfigured(env: Env): boolean {
  return !!(env.ACCESS_AUD && env.TEAM_DOMAIN);
}

export function accessLoginUrl(env: Env, returnUrl: string): string | null {
  if (!env.TEAM_DOMAIN) return null;
  const team = env.TEAM_DOMAIN.replace(/\/$/, "");
  let host = "tools.yutok.dev";
  try {
    host = new URL(returnUrl).hostname;
  } catch {
    /* keep default */
  }
  return `${team}/cdn-cgi/access/login/${host}?redirect_url=${encodeURIComponent(returnUrl)}`;
}

export function accessLogoutUrl(env: Env): string | null {
  if (!env.TEAM_DOMAIN) return null;
  return `${env.TEAM_DOMAIN.replace(/\/$/, "")}/cdn-cgi/access/logout`;
}

export function authMethods(env: Env): {
  access: boolean;
  google: boolean;
  gateEmergency: boolean;
  accessLoginHint?: string;
} {
  return {
    access: accessConfigured(env),
    google: googleConfigured(env),
    gateEmergency: !!env.UPLOAD_GATE,
  };
}

async function verifyAccessJwt(
  jwt: string,
  env: Env,
): Promise<{ ok: true; email?: string } | { ok: false; reason: string }> {
  if (!env.ACCESS_AUD || !env.TEAM_DOMAIN) {
    return { ok: false, reason: "Access AUD / TEAM_DOMAIN 未設定" };
  }
  const team = env.TEAM_DOMAIN.replace(/\/$/, "");
  try {
    const res = await fetch(`${team}/cdn-cgi/access/certs`);
    if (!res.ok) return { ok: false, reason: "Access certs 取得失敗" };
    const jwks = (await res.json()) as {
      keys?: { kid?: string; kty: string; n: string; e: string }[];
    };
    const headerJson = JSON.parse(
      atob(jwt.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/")),
    ) as { kid?: string; alg?: string };
    const jwk = (jwks.keys || []).find((k) => k.kid === headerJson.kid) || jwks.keys?.[0];
    if (!jwk) return { ok: false, reason: "JWK なし" };

    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const [h, p, s] = jwt.split(".");
    const data = new TextEncoder().encode(`${h}.${p}`);
    const sig = Uint8Array.from(
      atob(s!.replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0),
    );
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, data);
    if (!valid) return { ok: false, reason: "署名不正" };

    const payload = decodeJwtPayload(jwt);
    if (!payload) return { ok: false, reason: "payload 不正" };
    const aud = payload.aud;
    const audOk = Array.isArray(aud) ? aud.includes(env.ACCESS_AUD) : aud === env.ACCESS_AUD;
    if (!audOk) return { ok: false, reason: "aud 不一致" };
    if (payload.iss !== team) return { ok: false, reason: "iss 不一致" };
    const exp = Number(payload.exp || 0);
    if (exp && exp * 1000 < Date.now()) return { ok: false, reason: "期限切れ" };

    const email = String(payload.email || "").toLowerCase();
    const allow = allowlistEmails(env);
    if (allow.length && (!email || !allow.includes(email))) {
      return { ok: false, reason: "許可されていないメール" };
    }
    return { ok: true, email: email || undefined };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "verify failed" };
  }
}

export async function verifyUploadGatePassword(env: Env, password: string): Promise<boolean> {
  if (!env.UPLOAD_GATE) return false;
  const expected = env.UPLOAD_GATE.trim();
  const given = password.trim();
  return timingSafeEqual(given, expected);
}

export async function resolveAuthIdentity(
  request: Request,
  env: Env,
): Promise<AuthIdentity | null> {
  if (env.DEV_OPEN_UPLOAD === "1") {
    return { authenticated: true, mode: "dev", email: "dev@localhost" };
  }

  const session = await readUploadSession(request, env);
  if (session) {
    return {
      authenticated: true,
      mode: session.mode === "google" ? "google" : session.mode === "gate" ? "gate" : "session",
      email: session.email,
      accessLogoutUrl: accessLogoutUrl(env) || undefined,
    };
  }

  const jwt =
    request.headers.get("Cf-Access-Jwt-Assertion") ||
    parseCookies(request)["CF_Authorization"] ||
    "";
  if (jwt && accessConfigured(env)) {
    const verified = await verifyAccessJwt(jwt, env);
    if (verified.ok) {
      return {
        authenticated: true,
        mode: "access",
        email: verified.email,
        accessLogoutUrl: accessLogoutUrl(env) || undefined,
      };
    }
  }

  return null;
}

/**
 * Fail-closed upload gate.
 * Allows: DEV_OPEN_UPLOAD | Access JWT | upload session (Google / emergency gate).
 */
export async function requireUploadAccess(request: Request, env: Env): Promise<Response | null> {
  const identity = await resolveAuthIdentity(request, env);
  if (identity) return null;

  const jwt =
    request.headers.get("Cf-Access-Jwt-Assertion") ||
    parseCookies(request)["CF_Authorization"] ||
    "";
  if (jwt && accessConfigured(env)) {
    const verified = await verifyAccessJwt(jwt, env);
    if (!verified.ok) {
      return json(
        {
          error: "Cloudflare Access 認証に失敗しました",
          detail: verified.reason,
          authRequired: true,
        },
        401,
      );
    }
  }

  const methods = authMethods(env);
  if (!methods.access && !methods.google && !methods.gateEmergency) {
    return json(
      {
        error:
          "アップロード認証が未設定です（Cloudflare Access または Google OAuth を設定してください）",
        authRequired: true,
      },
      503,
    );
  }

  return json({ error: "アップロードには認証が必要です", authRequired: true }, 401);
}

export async function requireUploadIdentity(
  request: Request,
  env: Env,
): Promise<{ identity: AuthIdentity } | { response: Response }> {
  const gate = await requireUploadAccess(request, env);
  if (gate) return { response: gate };
  const identity = await resolveAuthIdentity(request, env);
  if (!identity) {
    return { response: json({ error: "アップロードには認証が必要です", authRequired: true }, 401) };
  }
  return { identity };
}

export function json(data: unknown, status = 200, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}

export function corsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Cf-Access-Jwt-Assertion",
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
}

export function withCors(resp: Response, request: Request): Response {
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(corsHeaders(request))) headers.set(k, String(v));
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
}
