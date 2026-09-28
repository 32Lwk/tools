import type { Env } from "./env";
import { decryptJson, encryptJson } from "./google";

/**
 * Picture-choice challenge for the gate (limited-access) login.
 *
 * Config lives in KV (`authcfg:picture`) and images in R2 under `auth-challenge/`,
 * never in the repo: the repo root is served as public static assets.
 * Each round always shows the same 3 images (answer + 2 fixed decoys) in random
 * order, so observing many challenges does not reveal which image is correct.
 * Challenges are stateless AES-GCM tokens so that issuing them costs no KV writes
 * (free-plan KV allows only 1,000 writes/day).
 */

export const CHALLENGE_IMAGE_PREFIX = "auth-challenge/";
const CONFIG_KEY = "authcfg:picture";
const CHALLENGE_TTL_SEC = 600;
const TOKEN_PURPOSE = "picture-challenge";
const FAIL_KV_PREFIX = "authfail:";
const FAIL_WINDOW_SEC = 15 * 60;
export const MAX_LOGIN_FAILURES = 5;
const MAX_ROUNDS = 5;
const DEFAULT_PROMPT = "正しいイラストを選んでください";

type RoundConfig = {
  prompt?: string;
  answer: string;
  decoys: string[];
};

type PictureConfig = {
  rounds: RoundConfig[];
};

/** perms[r][i] = index into [answer, decoy0, decoy1] shown at position i. */
type ChallengeToken = {
  p: typeof TOKEN_PURPOSE;
  exp: number;
  perms: number[][];
};

function isImageKey(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.startsWith(CHALLENGE_IMAGE_PREFIX) &&
    v.length > CHALLENGE_IMAGE_PREFIX.length &&
    !v.includes("..")
  );
}

function parseConfig(raw: string | null): PictureConfig | null {
  if (!raw) return null;
  try {
    const cfg = JSON.parse(raw) as PictureConfig;
    if (!Array.isArray(cfg.rounds) || cfg.rounds.length < 1 || cfg.rounds.length > MAX_ROUNDS) {
      return null;
    }
    for (const r of cfg.rounds) {
      if (!isImageKey(r.answer)) return null;
      if (!Array.isArray(r.decoys) || r.decoys.length !== 2 || !r.decoys.every(isImageKey)) {
        return null;
      }
      if (new Set([r.answer, ...r.decoys]).size !== 3) return null;
    }
    return cfg;
  } catch {
    return null;
  }
}

async function loadConfig(env: Env): Promise<PictureConfig | null> {
  const raw = await env.META.get(CONFIG_KEY);
  const cfg = parseConfig(raw);
  if (!cfg && raw) {
    console.error(JSON.stringify({ err: "invalid picture challenge config", key: CONFIG_KEY }));
  }
  return cfg;
}

export async function challengeConfigured(env: Env): Promise<boolean> {
  return (await loadConfig(env)) !== null;
}

function randomInt(maxExclusive: number): number {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive;
  do {
    crypto.getRandomValues(buf);
  } while (buf[0]! >= limit);
  return buf[0]! % maxExclusive;
}

function randomPerm3(): number[] {
  const out = [0, 1, 2];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

async function readToken(env: Env, token: string): Promise<ChallengeToken | null> {
  if (!token || token.length > 2048 || !env.TOKEN_ENC_KEY) return null;
  try {
    const t = await decryptJson<ChallengeToken>(env, token);
    if (t.p !== TOKEN_PURPOSE || !Array.isArray(t.perms) || t.exp <= Date.now()) return null;
    return t;
  } catch {
    return null;
  }
}

export async function createChallenge(
  env: Env,
  imageBasePath: string,
): Promise<{ id: string; expiresIn: number; rounds: { prompt: string; images: string[] }[] } | null> {
  const cfg = await loadConfig(env);
  if (!cfg) return null;
  if (!env.TOKEN_ENC_KEY) throw new Error("TOKEN_ENC_KEY が未設定のためイラスト選択を発行できません");
  const payload: ChallengeToken = {
    p: TOKEN_PURPOSE,
    exp: Date.now() + CHALLENGE_TTL_SEC * 1000,
    perms: cfg.rounds.map(() => randomPerm3()),
  };
  const id = await encryptJson(env, payload);
  const idPath = encodeURIComponent(id);
  return {
    id,
    expiresIn: CHALLENGE_TTL_SEC,
    rounds: cfg.rounds.map((r, ri) => ({
      prompt: (r.prompt || DEFAULT_PROMPT).slice(0, 120),
      images: [0, 1, 2].map((i) => `${imageBasePath}/${idPath}/${ri}/${i}`),
    })),
  };
}

export async function challengeImage(
  env: Env,
  id: string,
  round: number,
  idx: number,
): Promise<Response | null> {
  const token = await readToken(env, id);
  const cfg = token ? await loadConfig(env) : null;
  if (!token || !cfg) return null;
  const r = cfg.rounds[round];
  const which = token.perms[round]?.[idx];
  if (!r || which === undefined) return null;
  const key = [r.answer, ...r.decoys][which];
  if (!key) return null;
  const obj = await env.BUCKET.get(key);
  if (!obj) return null;
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'");
  return new Response(obj.body, { headers });
}

export async function verifyChallenge(
  env: Env,
  id: string | undefined,
  picks: unknown,
): Promise<"ok" | "wrong" | "expired"> {
  const token = typeof id === "string" ? await readToken(env, id) : null;
  const cfg = token ? await loadConfig(env) : null;
  if (!token || !cfg || token.perms.length !== cfg.rounds.length) return "expired";
  if (!Array.isArray(picks) || picks.length !== token.perms.length) return "wrong";
  let diff = 0;
  token.perms.forEach((perm, i) => {
    diff |= Number(picks[i]) === perm.indexOf(0) ? 0 : 1;
  });
  return diff === 0 ? "ok" : "wrong";
}

function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

export async function loginLockedOut(request: Request, env: Env): Promise<boolean> {
  const raw = await env.META.get(`${FAIL_KV_PREFIX}${clientIp(request)}`);
  return Number(raw || 0) >= MAX_LOGIN_FAILURES;
}

export async function recordLoginFailure(request: Request, env: Env): Promise<number> {
  const key = `${FAIL_KV_PREFIX}${clientIp(request)}`;
  const count = Number((await env.META.get(key)) || 0) + 1;
  await env.META.put(key, String(count), { expirationTtl: FAIL_WINDOW_SEC });
  return count;
}

export async function clearLoginFailures(request: Request, env: Env): Promise<void> {
  await env.META.delete(`${FAIL_KV_PREFIX}${clientIp(request)}`);
}
