import type { Env } from "./env";

export async function requireUploadAccess(request: Request, env: Env): Promise<Response | null> {
  if (env.DEV_OPEN_UPLOAD === "1") return null;
  if (!env.ACCESS_AUD) return null;
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!jwt || jwt.length < 20) {
    return json({ error: "Cloudflare Access 認証が必要です" }, 401);
  }
  return null;
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
