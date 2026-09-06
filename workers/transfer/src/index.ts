import { estimateR2Cost, MAX_BYTES, PART_SIZE, RETENTION_HOURS } from "./cost";
import { corsHeaders, json, requireUploadAccess, withCors } from "./access";
import type { Env } from "./env";
import { hashPassword, verifyPassword } from "./password";
import {
  type DlTokenRecord,
  type TransferMeta,
  META_PREFIX,
  SLOT_KEY,
  isValidSlug,
  metaKey,
  tokenKey,
} from "./meta";

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

async function getMeta(env: Env, slug: string): Promise<TransferMeta | null> {
  const raw = await env.META.get(metaKey(slug));
  if (!raw) return null;
  return JSON.parse(raw) as TransferMeta;
}

async function putMeta(env: Env, meta: TransferMeta): Promise<void> {
  const ttl = Math.max(60, Math.ceil((meta.expiresAt - Date.now()) / 1000) + 3600);
  await env.META.put(metaKey(meta.slug), JSON.stringify(meta), { expirationTtl: ttl });
}

async function cleanupExpired(env: Env): Promise<string[]> {
  const removed: string[] = [];
  const listed = await env.META.list({ prefix: META_PREFIX });
  const now = Date.now();
  for (const key of listed.keys) {
    const raw = await env.META.get(key.name);
    if (!raw) continue;
    const meta = JSON.parse(raw) as TransferMeta;
    const pendingStale = meta.status === "pending" && now - meta.createdAt > 2 * 3600_000;
    const expired = meta.expiresAt <= now;
    if (!expired && !pendingStale) continue;

    if (meta.uploadId) {
      try {
        await env.BUCKET.resumeMultipartUpload(meta.r2Key, meta.uploadId).abort();
      } catch {
        /* ignore */
      }
    }
    try {
      await env.BUCKET.delete(meta.r2Key);
    } catch {
      /* ignore */
    }
    await env.META.delete(key.name);
    const slot = await env.META.get(SLOT_KEY);
    if (slot === meta.slug) await env.META.delete(SLOT_KEY);
    removed.push(meta.slug);
  }
  return removed;
}

async function handleApi(request: Request, env: Env, path: string): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  if (path === "/transfer/api/status" && request.method === "GET") {
    const gate = await requireUploadAccess(request, env);
    if (gate) return gate;
    await cleanupExpired(env);
    const slot = await env.META.get(SLOT_KEY);
    const active = slot ? await getMeta(env, slot) : null;
    const ready =
      active && active.status === "ready" && active.expiresAt > Date.now() ? active : null;
    return json({
      active: ready
        ? {
            slug: ready.slug,
            size: ready.size,
            originalName: ready.originalName,
            expiresAt: ready.expiresAt,
            status: ready.status,
          }
        : null,
      limits: {
        maxBytes: MAX_BYTES,
        retentionHours: RETENTION_HOURS,
        concurrent: 1,
        partSize: PART_SIZE,
      },
    });
  }

  if (path === "/transfer/api/r2/init" && request.method === "POST") {
    const gate = await requireUploadAccess(request, env);
    if (gate) return gate;
    const body = await readJson<{
      slug: string;
      password: string;
      filename: string;
      size: number;
      contentType?: string;
      costAck?: boolean;
    }>(request);
    if (!body) return json({ error: "Invalid JSON" }, 400);
    if (!body.costAck) return json({ error: "コスト確認への同意（costAck）が必要です" }, 400);
    if (!isValidSlug(body.slug)) {
      return json(
        { error: "スラッグは 3〜64 文字の英小文字・数字・ハイフン（両端は英数字）です" },
        400,
      );
    }
    if (!body.password || body.password.length < 4) {
      return json({ error: "パスワードは4文字以上必須です" }, 400);
    }
    if (!Number.isFinite(body.size) || body.size <= 0 || body.size > MAX_BYTES) {
      return json({ error: `ファイルサイズは 1 バイト〜 ${MAX_BYTES} バイトです` }, 400);
    }
    if (!body.filename || body.filename.length > 255) {
      return json({ error: "ファイル名が不正です" }, 400);
    }

    const estimate = estimateR2Cost(body.size);
    await cleanupExpired(env);

    const existingSlot = await env.META.get(SLOT_KEY);
    if (existingSlot) {
      const existing = await getMeta(env, existingSlot);
      if (existing && existing.expiresAt > Date.now() && existing.status === "ready") {
        return json(
          {
            error: "同時保管は1本までです。既存ファイルの期限切れ後に再試行してください",
            activeSlug: existing.slug,
          },
          409,
        );
      }
    }
    const collision = await getMeta(env, body.slug);
    if (collision && collision.expiresAt > Date.now()) {
      return json({ error: "このスラッグは使用中です" }, 409);
    }

    const r2Key = `transfers/${body.slug}/${crypto.randomUUID()}`;
    const mpu = await env.BUCKET.createMultipartUpload(r2Key, {
      httpMetadata: {
        contentType: body.contentType || "application/octet-stream",
        contentDisposition: `attachment; filename="${body.filename.replace(/"/g, "")}"`,
      },
      customMetadata: { slug: body.slug, originalName: body.filename },
    });
    const { hash, salt } = await hashPassword(body.password);
    const now = Date.now();
    const meta: TransferMeta = {
      slug: body.slug,
      backend: "r2",
      status: "pending",
      passwordHash: hash,
      passwordSalt: salt,
      size: body.size,
      contentType: body.contentType || "application/octet-stream",
      originalName: body.filename,
      r2Key,
      uploadId: mpu.uploadId,
      createdAt: now,
      expiresAt: now + RETENTION_HOURS * 3600_000,
    };
    await putMeta(env, meta);
    await env.META.put(SLOT_KEY, body.slug, { expirationTtl: 36 * 3600 });

    return json({
      uploadId: mpu.uploadId,
      key: r2Key,
      partSize: PART_SIZE,
      expiresAt: meta.expiresAt,
      estimate,
      downloadPath: `/transfer/d/${body.slug}`,
    });
  }

  if (path === "/transfer/api/r2/part" && request.method === "PUT") {
    const gate = await requireUploadAccess(request, env);
    if (gate) return gate;
    const url = new URL(request.url);
    const slug = url.searchParams.get("slug") || "";
    const uploadId = url.searchParams.get("uploadId") || "";
    const partNumber = Number(url.searchParams.get("partNumber") || "0");
    if (!isValidSlug(slug) || !uploadId || !Number.isInteger(partNumber) || partNumber < 1) {
      return json({ error: "slug / uploadId / partNumber が不正です" }, 400);
    }
    if (!request.body) return json({ error: "body が空です" }, 400);
    const meta = await getMeta(env, slug);
    if (!meta || meta.status !== "pending" || meta.uploadId !== uploadId) {
      return json({ error: "アップロードセッションが見つかりません" }, 404);
    }
    try {
      const mpu = env.BUCKET.resumeMultipartUpload(meta.r2Key, uploadId);
      const uploaded = await mpu.uploadPart(partNumber, request.body);
      return json({ partNumber: uploaded.partNumber, etag: uploaded.etag });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "uploadPart failed";
      return json({ error: msg }, 400);
    }
  }

  if (path === "/transfer/api/r2/complete" && request.method === "POST") {
    const gate = await requireUploadAccess(request, env);
    if (gate) return gate;
    const body = await readJson<{
      slug: string;
      uploadId: string;
      parts: { partNumber: number; etag: string }[];
    }>(request);
    if (!body || !isValidSlug(body.slug) || !body.uploadId || !Array.isArray(body.parts)) {
      return json({ error: "Invalid body" }, 400);
    }
    const meta = await getMeta(env, body.slug);
    if (!meta || meta.uploadId !== body.uploadId) {
      return json({ error: "セッションが見つかりません" }, 404);
    }
    try {
      const mpu = env.BUCKET.resumeMultipartUpload(meta.r2Key, body.uploadId);
      await mpu.complete(body.parts);
      meta.status = "ready";
      delete meta.uploadId;
      await putMeta(env, meta);
      await env.META.put(SLOT_KEY, meta.slug, {
        expirationTtl: Math.max(60, Math.ceil((meta.expiresAt - Date.now()) / 1000) + 60),
      });
      return json({
        ok: true,
        slug: meta.slug,
        expiresAt: meta.expiresAt,
        downloadPath: `/transfer/d/${meta.slug}`,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "complete failed";
      return json({ error: msg }, 400);
    }
  }

  if (path === "/transfer/api/r2/abort" && request.method === "DELETE") {
    const gate = await requireUploadAccess(request, env);
    if (gate) return gate;
    const body = await readJson<{ slug: string }>(request);
    if (!body || !isValidSlug(body.slug)) return json({ error: "Invalid slug" }, 400);
    const meta = await getMeta(env, body.slug);
    if (meta) {
      if (meta.uploadId) {
        try {
          await env.BUCKET.resumeMultipartUpload(meta.r2Key, meta.uploadId).abort();
        } catch {
          /* ignore */
        }
      }
      try {
        await env.BUCKET.delete(meta.r2Key);
      } catch {
        /* ignore */
      }
      await env.META.delete(metaKey(body.slug));
      const slot = await env.META.get(SLOT_KEY);
      if (slot === body.slug) await env.META.delete(SLOT_KEY);
    }
    return json({ ok: true });
  }

  const authMatch = path.match(/^\/transfer\/api\/dl\/([^/]+)\/auth$/);
  if (authMatch && request.method === "POST") {
    const slug = authMatch[1]!;
    if (!isValidSlug(slug)) return json({ error: "Invalid slug" }, 400);
    const body = await readJson<{ password: string }>(request);
    if (!body?.password) return json({ error: "password required" }, 400);
    const meta = await getMeta(env, slug);
    if (!meta || meta.status !== "ready" || meta.expiresAt <= Date.now()) {
      return json({ error: "ファイルが見つからないか期限切れです" }, 404);
    }
    const ok = await verifyPassword(body.password, meta.passwordHash, meta.passwordSalt);
    if (!ok) return json({ error: "パスワードが違います" }, 403);
    const token = crypto.randomUUID() + crypto.randomUUID();
    const rec: DlTokenRecord = { slug, exp: Date.now() + 5 * 60_000 };
    await env.META.put(tokenKey(token), JSON.stringify(rec), { expirationTtl: 300 });
    return json({
      token,
      expiresIn: 300,
      filename: meta.originalName,
      size: meta.size,
      contentType: meta.contentType,
    });
  }

  const fileMatch = path.match(/^\/transfer\/api\/dl\/([^/]+)\/file$/);
  if (fileMatch && request.method === "GET") {
    const slug = fileMatch[1]!;
    const url = new URL(request.url);
    const token = url.searchParams.get("token") || "";
    if (!isValidSlug(slug) || !token) return json({ error: "token required" }, 400);
    const raw = await env.META.get(tokenKey(token));
    if (!raw) return json({ error: "トークンが無効または期限切れです" }, 403);
    const rec = JSON.parse(raw) as DlTokenRecord;
    if (rec.slug !== slug || rec.exp <= Date.now()) {
      return json({ error: "トークンが無効または期限切れです" }, 403);
    }
    const meta = await getMeta(env, slug);
    if (!meta || meta.status !== "ready") return json({ error: "not found" }, 404);
    const obj = await env.BUCKET.get(meta.r2Key);
    if (!obj) return json({ error: "object missing" }, 404);
    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set("etag", obj.httpEtag);
    headers.set(
      "content-disposition",
      `attachment; filename="${meta.originalName.replace(/"/g, "")}"`,
    );
    headers.set("cache-control", "no-store");
    return new Response(obj.body, { headers });
  }

  const infoMatch = path.match(/^\/transfer\/api\/dl\/([^/]+)\/info$/);
  if (infoMatch && request.method === "GET") {
    const slug = infoMatch[1]!;
    const meta = await getMeta(env, slug);
    if (!meta || meta.status !== "ready" || meta.expiresAt <= Date.now()) {
      return json({ error: "not found" }, 404);
    }
    return json({
      slug: meta.slug,
      originalName: meta.originalName,
      size: meta.size,
      expiresAt: meta.expiresAt,
      backend: meta.backend,
    });
  }

  return json({ error: "Not found" }, 404);
}

function downloadPageHtml(slug: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ダウンロード — ${slug}</title>
  <script src="/theme-boot.js"></script>
  <link rel="stylesheet" href="/theme.css" />
  <link rel="stylesheet" href="/transfer/styles.css" />
</head>
<body>
  <main class="wrap">
    <p class="crumb"><a href="/">tools.yutok.dev</a> / <a href="/transfer/">transfer</a> / d / ${slug}</p>
    <h1>ダウンロード</h1>
    <p id="info" class="muted">読み込み中…</p>
    <form id="form" class="stack">
      <label>パスワード
        <input type="password" id="password" required autocomplete="current-password" />
      </label>
      <button type="submit">ダウンロード</button>
    </form>
    <p id="msg" class="msg" hidden></p>
  </main>
  <script>window.__TRANSFER_SLUG__ = ${JSON.stringify(slug)};</script>
  <script type="module" src="/transfer/download.js"></script>
</body>
</html>`;
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    let path = url.pathname;
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

    try {
      if (path.startsWith("/transfer/api")) {
        return withCors(await handleApi(request, env, path), request);
      }

      const dlPage = path.match(/^\/transfer\/d\/([^/]+)$/);
      if (dlPage && request.method === "GET") {
        const slug = dlPage[1]!;
        if (!isValidSlug(slug)) return new Response("Invalid slug", { status: 400 });
        return new Response(downloadPageHtml(slug), {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }

      if (path === "/transfer" || path.startsWith("/transfer/")) {
        const assetPath = path === "/transfer" ? "/transfer/index.html" : path;
        return env.ASSETS.fetch(new Request(new URL(assetPath, url.origin), request));
      }

      return new Response("Not found", { status: 404 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "internal error";
      console.error(JSON.stringify({ err: msg }));
      return json({ error: msg }, 500);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(cleanupExpired(env));
  },
} satisfies ExportedHandler<Env>;
