import { estimateR2Cost, FREE_STORAGE_BYTES, MAX_BYTES, PART_SIZE, RETENTION_HOURS, formatBytes } from "./cost";
import {
  accessLoginUrl,
  accessLogoutUrl,
  authMethods,
  corsHeaders,
  createUploadSession,
  destroyUploadSession,
  json,
  requireUploadAccess,
  requireUploadIdentity,
  resolveAuthIdentity,
  verifyUploadGatePassword,
  withCors,
} from "./access";
import {
  driveUploadEndpoints,
  findOrCreateFolder,
  getDrivePrefs,
  putDrivePrefs,
  requireDriveAccessToken,
  streamDriveFile,
  verifyDriveFile,
} from "./drive";
import type { Env } from "./env";
import {
  buildGoogleAuthUrl,
  consumeOauthState,
  createOauthState,
  exchangeGoogleCode,
  googleConfigured,
  loadStoredTokens,
} from "./google";
import { hashPassword, verifyPassword } from "./password";
import {
  type DlTokenRecord,
  type DriveTransferMeta,
  type R2TransferMeta,
  type TransferMeta,
  META_PREFIX,
  isValidSlug,
  metaKey,
  slugToUrlPath,
  tokenKey,
} from "./meta";
import { resolveDlInfo } from "./listing";

/** Public (Access-free) prefix for download + OAuth entrypoints. */
const SHARE_PREFIX = "/share";
const DL_PAGE_PREFIX = `${SHARE_PREFIX}/d`;
const DL_API_PREFIX = `${SHARE_PREFIX}/api/dl`;

const SLUG_RULE_ERROR =
  "スラッグは英小文字・数字・ハイフンのセグメント（/ 区切り可、合計 200 文字以内）です";

function decodeSlugParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

/** Map /share/... public aliases onto /transfer/... handlers. */
function normalizeApiPath(path: string): string {
  if (path.startsWith(`${SHARE_PREFIX}/api/`)) {
    return `/transfer/api/${path.slice(`${SHARE_PREFIX}/api/`.length)}`;
  }
  return path;
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

async function deleteTransferByMeta(env: Env, meta: TransferMeta): Promise<void> {
  if (meta.backend === "r2") {
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
  }
  // Drive: delete site metadata only; file remains on user's Drive
  await env.META.delete(metaKey(meta.slug));
}

async function listTransfers(env: Env): Promise<
  {
    slug: string;
    backend: TransferMeta["backend"];
    status: TransferMeta["status"];
    size: number;
    originalName: string;
    contentType: string;
    r2Key?: string;
    driveFileId?: string;
    createdAt: number;
    expiresAt: number;
  }[]
> {
  const listed = await env.META.list({ prefix: META_PREFIX });
  const items = [];
  for (const key of listed.keys) {
    const raw = await env.META.get(key.name);
    if (!raw) continue;
    const meta = JSON.parse(raw) as TransferMeta;
    items.push({
      slug: meta.slug,
      backend: meta.backend,
      status: meta.status,
      size: meta.size,
      originalName: meta.originalName,
      contentType: meta.contentType,
      r2Key: meta.backend === "r2" ? meta.r2Key : undefined,
      driveFileId: meta.backend === "drive" ? meta.driveFileId : undefined,
      createdAt: meta.createdAt,
      expiresAt: meta.expiresAt,
    });
  }
  items.sort((a, b) => b.createdAt - a.createdAt);
  return items;
}

async function listR2Objects(env: Env): Promise<{ key: string; size: number; uploaded: string }[]> {
  const out: { key: string; size: number; uploaded: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ prefix: "transfers/", cursor, limit: 500 });
    for (const obj of page.objects) {
      out.push({
        key: obj.key,
        size: obj.size,
        uploaded: obj.uploaded.toISOString(),
      });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

async function listActiveR2Transfers(env: Env): Promise<R2TransferMeta[]> {
  const listed = await env.META.list({ prefix: META_PREFIX });
  const now = Date.now();
  const out: R2TransferMeta[] = [];
  for (const key of listed.keys) {
    const raw = await env.META.get(key.name);
    if (!raw) continue;
    const meta = JSON.parse(raw) as TransferMeta;
    if (meta.backend !== "r2") continue;
    if (meta.expiresAt <= now) continue;
    const pendingStale = meta.status === "pending" && now - meta.createdAt > 2 * 3600_000;
    if (pendingStale) continue;
    out.push(meta);
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

function r2UsageSummary(actives: R2TransferMeta[]) {
  const usedBytes = actives.reduce((sum, m) => sum + m.size, 0);
  return {
    usedBytes,
    remainingBytes: Math.max(0, FREE_STORAGE_BYTES - usedBytes),
    count: actives.length,
  };
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

    if (meta.backend === "r2") {
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
    }
    await env.META.delete(key.name);
    removed.push(meta.slug);
  }
  return removed;
}

function safeReturnTo(raw: string | null, origin: string): string {
  const fallback = `${origin}/share/`;
  if (!raw) return fallback;
  try {
    const u = new URL(raw, origin);
    if (u.origin !== origin) return fallback;
    if (!(u.pathname.startsWith("/share") || u.pathname.startsWith("/transfer"))) return fallback;
    // Prefer public /share UI (Access-free)
    if (u.pathname === "/transfer" || u.pathname === "/transfer/") {
      return `${origin}/share/`;
    }
    if (u.pathname.startsWith("/transfer/") && u.hash) {
      return `${origin}/share/${u.hash}`;
    }
    return u.toString();
  } catch {
    return fallback;
  }
}

async function handleApi(request: Request, env: Env, path: string): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  const url = new URL(request.url);

  if (path === "/transfer/api/auth/methods" && request.method === "GET") {
    const methods = authMethods(env);
    const returnTo = `${url.origin}/share/`;
    // Access login must hit a protected /transfer path so the JWT cookie is issued
    const accessReturn = `${url.origin}/transfer/`;
    return json({
      ...methods,
      accessLoginUrl: methods.access ? accessLoginUrl(env, accessReturn) : null,
      googleStartUrl: methods.google ? `${SHARE_PREFIX}/api/auth/google/start` : null,
      accessLogoutUrl: accessLogoutUrl(env),
      appPath: `${SHARE_PREFIX}/`,
    });
  }

  if (path === "/transfer/api/auth/google/start" && request.method === "GET") {
    if (!googleConfigured(env)) {
      return json({ error: "Google OAuth が未設定です" }, 503);
    }
    const returnTo = safeReturnTo(url.searchParams.get("returnTo"), url.origin);
    const state = await createOauthState(env, returnTo);
    const dest = buildGoogleAuthUrl(env, url, state);
    return Response.redirect(dest, 302);
  }

  if (path === "/transfer/api/auth/google/callback" && request.method === "GET") {
    if (!googleConfigured(env)) {
      return json({ error: "Google OAuth が未設定です" }, 503);
    }
    const err = url.searchParams.get("error");
    if (err) {
      return Response.redirect(
        `${url.origin}/share/?auth_error=${encodeURIComponent(err)}`,
        302,
      );
    }
    const code = url.searchParams.get("code") || "";
    const state = url.searchParams.get("state") || "";
    const st = await consumeOauthState(env, state);
    if (!code || !st) {
      return Response.redirect(
        `${url.origin}/share/?auth_error=${encodeURIComponent("invalid_oauth_state")}`,
        302,
      );
    }
    try {
      const exchanged = await exchangeGoogleCode(env, url, code);
      const session = await createUploadSession(env, { email: exchanged.email, mode: "google" });
      const dest = safeReturnTo(st.returnTo, url.origin);
      return new Response(null, {
        status: 302,
        headers: {
          location: dest,
          "set-cookie": session.setCookie,
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "oauth_failed";
      return Response.redirect(
        `${url.origin}/share/?auth_error=${encodeURIComponent(msg)}`,
        302,
      );
    }
  }

  if (path === "/transfer/api/auth/login" && request.method === "POST") {
    // Emergency gate only (UI hidden). Prefer Access / Google.
    if (env.DEV_OPEN_UPLOAD === "1") {
      const session = await createUploadSession(env, { mode: "dev", email: "dev@localhost" });
      return json({ ok: true, mode: "dev" }, 200, { "set-cookie": session.setCookie });
    }
    const body = await readJson<{ password?: string }>(request);
    if (!body?.password) return json({ error: "password required", authRequired: true }, 400);
    if (!(await verifyUploadGatePassword(env, body.password))) {
      return json({ error: "認証に失敗しました", authRequired: true }, 401);
    }
    const session = await createUploadSession(env, { mode: "gate" });
    return json({ ok: true, mode: "gate" }, 200, { "set-cookie": session.setCookie });
  }

  if (path === "/transfer/api/auth/logout" && request.method === "POST") {
    const clear = await destroyUploadSession(request, env);
    return json(
      { ok: true, accessLogoutUrl: accessLogoutUrl(env) },
      200,
      { "set-cookie": clear },
    );
  }

  if (path === "/transfer/api/auth/me" && request.method === "GET") {
    const identity = await resolveAuthIdentity(request, env);
    if (!identity) {
      return json({ ok: false, authenticated: false, authRequired: true }, 401);
    }
    return json({
      ok: true,
      authenticated: true,
      email: identity.email || null,
      mode: identity.mode,
      accessLogoutUrl: identity.accessLogoutUrl || accessLogoutUrl(env),
      methods: authMethods(env),
    });
  }

  if (path === "/transfer/api/status" && request.method === "GET") {
    const gate = await requireUploadAccess(request, env);
    if (gate) return gate;
    await cleanupExpired(env);
    const actives = await listActiveR2Transfers(env);
    const usage = r2UsageSummary(actives);
    const ready = actives.filter((m) => m.status === "ready");
    return json({
      active: ready[0]
        ? {
            slug: ready[0].slug,
            size: ready[0].size,
            originalName: ready[0].originalName,
            expiresAt: ready[0].expiresAt,
            status: ready[0].status,
            backend: ready[0].backend,
          }
        : null,
      actives: actives.map((m) => ({
        slug: m.slug,
        size: m.size,
        originalName: m.originalName,
        expiresAt: m.expiresAt,
        status: m.status,
        backend: m.backend,
      })),
      usedBytes: usage.usedBytes,
      remainingBytes: usage.remainingBytes,
      limits: {
        maxBytes: MAX_BYTES,
        maxTotalBytes: FREE_STORAGE_BYTES,
        retentionHours: RETENTION_HOURS,
        partSize: PART_SIZE,
      },
    });
  }

  if (path === "/transfer/api/drive/status" && request.method === "GET") {
    const auth = await requireUploadIdentity(request, env);
    if ("response" in auth) return auth.response;
    const email = auth.identity.email;
    if (!email || !googleConfigured(env)) {
      return json({
        connected: false,
        email: email || null,
        folder: null,
        googleConfigured: googleConfigured(env),
      });
    }
    const tokens = await loadStoredTokens(env, email);
    const prefs = tokens ? await getDrivePrefs(env, email) : null;
    return json({
      connected: !!tokens,
      email,
      folder: prefs
        ? { id: prefs.folderId, name: prefs.folderName }
        : null,
      googleConfigured: true,
    });
  }

  if (path === "/transfer/api/drive/folder" && request.method === "POST") {
    const auth = await requireUploadIdentity(request, env);
    if ("response" in auth) return auth.response;
    const email = auth.identity.email;
    const tok = await requireDriveAccessToken(env, email);
    if ("error" in tok) return json({ error: tok.error }, tok.status);
    const body = await readJson<{ folderName?: string }>(request);
    const folderName = (body?.folderName || "tools-transfer").trim().slice(0, 120) || "tools-transfer";
    try {
      const folder = await findOrCreateFolder(tok.accessToken, folderName);
      await putDrivePrefs(env, {
        email: tok.email,
        folderId: folder.id,
        folderName: folder.name,
        updatedAt: Date.now(),
      });
      return json({ ok: true, folder: { id: folder.id, name: folder.name } });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "folder failed" }, 400);
    }
  }

  if (path === "/transfer/api/drive/init" && request.method === "POST") {
    const auth = await requireUploadIdentity(request, env);
    if ("response" in auth) return auth.response;
    const email = auth.identity.email;
    const tok = await requireDriveAccessToken(env, email);
    if ("error" in tok) return json({ error: tok.error }, tok.status);

    const body = await readJson<{
      slug: string;
      password: string;
      filename: string;
      size: number;
      contentType?: string;
      costAck?: boolean;
    }>(request);
    if (!body) return json({ error: "Invalid JSON" }, 400);
    if (!body.costAck) return json({ error: "保管条件への同意（costAck）が必要です" }, 400);
    if (!isValidSlug(body.slug)) {
      return json(
        { error: SLUG_RULE_ERROR },
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

    await cleanupExpired(env);
    const collision = await getMeta(env, body.slug);
    if (collision && collision.expiresAt > Date.now()) {
      return json({ error: "このスラッグは使用中です" }, 409);
    }

    let prefs = await getDrivePrefs(env, tok.email);
    if (!prefs) {
      const folder = await findOrCreateFolder(tok.accessToken, "tools-transfer");
      prefs = {
        email: tok.email,
        folderId: folder.id,
        folderName: folder.name,
        updatedAt: Date.now(),
      };
      await putDrivePrefs(env, prefs);
    }

    const { hash, salt } = await hashPassword(body.password);
    const now = Date.now();
    const meta: DriveTransferMeta = {
      slug: body.slug,
      backend: "drive",
      status: "pending",
      passwordHash: hash,
      passwordSalt: salt,
      size: body.size,
      contentType: body.contentType || "application/octet-stream",
      originalName: body.filename,
      driveFolderId: prefs.folderId,
      ownerEmail: tok.email,
      createdAt: now,
      expiresAt: now + RETENTION_HOURS * 3600_000,
    };
    await putMeta(env, meta);

    return json({
      accessToken: tok.accessToken,
      folderId: prefs.folderId,
      folderName: prefs.folderName,
      expiresAt: meta.expiresAt,
      downloadPath: `${DL_PAGE_PREFIX}/${body.slug}`,
      upload: driveUploadEndpoints(),
      metadata: {
        name: body.filename,
        mimeType: body.contentType || "application/octet-stream",
        parents: [prefs.folderId],
      },
    });
  }

  if (path === "/transfer/api/drive/complete" && request.method === "POST") {
    const auth = await requireUploadIdentity(request, env);
    if ("response" in auth) return auth.response;
    const email = auth.identity.email;
    const tok = await requireDriveAccessToken(env, email);
    if ("error" in tok) return json({ error: tok.error }, tok.status);

    const body = await readJson<{ slug: string; driveFileId: string }>(request);
    if (!body || !isValidSlug(body.slug) || !body.driveFileId) {
      return json({ error: "Invalid body" }, 400);
    }
    const meta = await getMeta(env, body.slug);
    if (!meta || meta.backend !== "drive" || meta.status !== "pending") {
      return json({ error: "セッションが見つかりません" }, 404);
    }
    if (meta.ownerEmail && meta.ownerEmail !== tok.email) {
      return json({ error: "所有者のみ完了できます" }, 403);
    }
    try {
      const file = await verifyDriveFile(tok.accessToken, body.driveFileId);
      if (!file) return json({ error: "Drive 上にファイルが見つかりません" }, 400);
      meta.status = "ready";
      meta.driveFileId = file.id;
      meta.size = Number(file.size) || meta.size;
      meta.contentType = file.mimeType || meta.contentType;
      meta.originalName = file.name || meta.originalName;
      await putMeta(env, meta);
      return json({
        ok: true,
        slug: meta.slug,
        expiresAt: meta.expiresAt,
        downloadPath: `${DL_PAGE_PREFIX}/${meta.slug}`,
      });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "complete failed" }, 400);
    }
  }

  if (path === "/transfer/api/drive/abort" && request.method === "DELETE") {
    const auth = await requireUploadIdentity(request, env);
    if ("response" in auth) return auth.response;
    const body = await readJson<{ slug: string }>(request);
    if (!body || !isValidSlug(body.slug)) return json({ error: "Invalid slug" }, 400);
    const meta = await getMeta(env, body.slug);
    if (meta && meta.backend === "drive") {
      if (meta.ownerEmail && auth.identity.email && meta.ownerEmail !== auth.identity.email) {
        return json({ error: "所有者のみ中断できます" }, 403);
      }
      await deleteTransferByMeta(env, meta);
    }
    return json({ ok: true });
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
        { error: SLUG_RULE_ERROR },
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

    const actives = await listActiveR2Transfers(env);
    const usage = r2UsageSummary(actives);
    if (usage.usedBytes + body.size > FREE_STORAGE_BYTES) {
      return json(
        {
          error: `R2 無料枠（合計 ${formatBytes(FREE_STORAGE_BYTES)}）を超えます。使用中 ${formatBytes(usage.usedBytes)} / 残り ${formatBytes(usage.remainingBytes)}`,
          usedBytes: usage.usedBytes,
          remainingBytes: usage.remainingBytes,
          maxTotalBytes: FREE_STORAGE_BYTES,
        },
        409,
      );
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
    const meta: R2TransferMeta = {
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

    return json({
      uploadId: mpu.uploadId,
      key: r2Key,
      partSize: PART_SIZE,
      expiresAt: meta.expiresAt,
      estimate,
      downloadPath: `${DL_PAGE_PREFIX}/${body.slug}`,
      usedBytes: usage.usedBytes + body.size,
      remainingBytes: Math.max(0, FREE_STORAGE_BYTES - usage.usedBytes - body.size),
    });
  }

  if (path === "/transfer/api/r2/part" && request.method === "PUT") {
    const gate = await requireUploadAccess(request, env);
    if (gate) return gate;
    const slug = url.searchParams.get("slug") || "";
    const uploadId = url.searchParams.get("uploadId") || "";
    const partNumber = Number(url.searchParams.get("partNumber") || "0");
    if (!isValidSlug(slug) || !uploadId || !Number.isInteger(partNumber) || partNumber < 1) {
      return json({ error: "slug / uploadId / partNumber が不正です" }, 400);
    }
    if (!request.body) return json({ error: "body が空です" }, 400);
    const meta = await getMeta(env, slug);
    if (!meta || meta.backend !== "r2" || meta.status !== "pending" || meta.uploadId !== uploadId) {
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
    if (!meta || meta.backend !== "r2" || meta.uploadId !== body.uploadId) {
      return json({ error: "セッションが見つかりません" }, 404);
    }
    try {
      const mpu = env.BUCKET.resumeMultipartUpload(meta.r2Key, body.uploadId);
      await mpu.complete(body.parts);
      meta.status = "ready";
      delete meta.uploadId;
      await putMeta(env, meta);
      return json({
        ok: true,
        slug: meta.slug,
        expiresAt: meta.expiresAt,
        downloadPath: `${DL_PAGE_PREFIX}/${meta.slug}`,
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
    if (meta) await deleteTransferByMeta(env, meta);
    return json({ ok: true });
  }

  if (path === "/transfer/api/admin/r2" && request.method === "GET") {
    const gate = await requireUploadAccess(request, env);
    if (gate) return gate;
    await cleanupExpired(env);
    const transfers = await listTransfers(env);
    const objects = await listR2Objects(env);
    const knownKeys = new Set(
      transfers.filter((t) => t.r2Key).map((t) => t.r2Key as string),
    );
    const orphans = objects.filter((o) => !knownKeys.has(o.key));
    const usage = r2UsageSummary(await listActiveR2Transfers(env));
    return json({
      transfers,
      objects,
      orphans,
      usedBytes: usage.usedBytes,
      remainingBytes: usage.remainingBytes,
      maxTotalBytes: FREE_STORAGE_BYTES,
      totals: {
        transferCount: transfers.length,
        objectCount: objects.length,
        bytes: objects.reduce((sum, o) => sum + o.size, 0),
      },
    });
  }

  if (path === "/transfer/api/admin/r2" && request.method === "DELETE") {
    const gate = await requireUploadAccess(request, env);
    if (gate) return gate;
    const body = await readJson<{ slug?: string; key?: string; all?: boolean }>(request);
    if (!body) return json({ error: "Invalid JSON" }, 400);

    if (body.all) {
      const transfers = await listTransfers(env);
      for (const t of transfers) {
        const meta = await getMeta(env, t.slug);
        if (meta) await deleteTransferByMeta(env, meta);
      }
      const objects = await listR2Objects(env);
      if (objects.length) {
        await env.BUCKET.delete(objects.map((o) => o.key));
      }
      return json({ ok: true, deletedTransfers: transfers.length, deletedObjects: objects.length });
    }

    if (body.slug) {
      if (!isValidSlug(body.slug)) return json({ error: "Invalid slug" }, 400);
      const meta = await getMeta(env, body.slug);
      if (!meta) return json({ error: "not found" }, 404);
      await deleteTransferByMeta(env, meta);
      return json({ ok: true, deleted: body.slug });
    }

    if (body.key) {
      if (!body.key.startsWith("transfers/")) return json({ error: "Invalid key" }, 400);
      await env.BUCKET.delete(body.key);
      return json({ ok: true, deletedKey: body.key });
    }

    return json({ error: "slug / key / all のいずれかが必要です" }, 400);
  }

  const authMatch = path.match(/^\/transfer\/api\/dl\/([^/]+)\/auth$/);
  if (authMatch && request.method === "POST") {
    const slug = decodeSlugParam(authMatch[1]!);
    if (!isValidSlug(slug)) return json({ error: "Invalid slug" }, 400);
    const body = await readJson<{ password: string }>(request);
    if (!body?.password) return json({ error: "password required" }, 400);
    const meta = await getMeta(env, slug);
    if (!meta || meta.status !== "ready" || meta.expiresAt <= Date.now()) {
      return json({ error: "ファイルが見つからないか期限切れです" }, 404);
    }
    if (meta.backend === "drive" && !meta.driveFileId) {
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
      backend: meta.backend,
    });
  }

  const fileMatch = path.match(/^\/transfer\/api\/dl\/([^/]+)\/file$/);
  if (fileMatch && request.method === "GET") {
    const slug = decodeSlugParam(fileMatch[1]!);
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

    const inline = url.searchParams.get("inline") === "1";
    const safeName = meta.originalName.replace(/"/g, "");
    const disposition = `${inline ? "inline" : "attachment"}; filename="${safeName}"`;

    if (meta.backend === "drive") {
      if (!meta.driveFileId || !meta.ownerEmail) return json({ error: "object missing" }, 404);
      const tok = await requireDriveAccessToken(env, meta.ownerEmail);
      if ("error" in tok) return json({ error: tok.error }, tok.status);
      const driveRes = await streamDriveFile(tok.accessToken, meta.driveFileId);
      if (!driveRes.ok || !driveRes.body) {
        return json({ error: "Drive からの取得に失敗しました" }, 502);
      }
      const headers = new Headers();
      headers.set("content-type", meta.contentType || "application/octet-stream");
      headers.set("content-disposition", disposition);
      headers.set("cache-control", "no-store");
      if (meta.size) headers.set("content-length", String(meta.size));
      return new Response(driveRes.body, { headers });
    }

    const obj = await env.BUCKET.get(meta.r2Key);
    if (!obj) return json({ error: "object missing" }, 404);
    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set("etag", obj.httpEtag);
    headers.set("content-disposition", disposition);
    headers.set("cache-control", "no-store");
    return new Response(obj.body, { headers });
  }

  const infoMatch = path.match(/^\/transfer\/api\/dl\/([^/]+)\/info$/);
  if (infoMatch && request.method === "GET") {
    const slug = decodeSlugParam(infoMatch[1]!);
    if (!isValidSlug(slug)) return json({ error: "not found" }, 404);
    const resolved = await resolveDlInfo(env, slug);
    if (!resolved) return json({ error: "not found" }, 404);
    if (resolved.type === "file") {
      const meta = resolved.meta;
      return json({
        type: "file",
        slug: meta.slug,
        originalName: meta.originalName,
        size: meta.size,
        contentType: meta.contentType,
        expiresAt: meta.expiresAt,
        backend: meta.backend,
      });
    }
    return json({
      type: "dir",
      slug: resolved.slug,
      entries: resolved.entries.map((e) =>
        e.kind === "dir"
          ? { kind: "dir", name: e.name, slug: e.slug, path: `${DL_PAGE_PREFIX}/${slugToUrlPath(e.slug)}` }
          : {
              kind: "file",
              name: e.name,
              slug: e.slug,
              originalName: e.originalName,
              size: e.size,
              contentType: e.contentType,
              backend: e.backend,
              expiresAt: e.expiresAt,
              path: `${DL_PAGE_PREFIX}/${slugToUrlPath(e.slug)}`,
            },
      ),
      expiresAt: resolved.expiresAt,
    });
  }

  return json({ error: "Not found" }, 404);
}

function downloadPageHtml(slug: string): string {
  const safeSlug = slug.replace(/</g, "");
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ダウンロード — ${safeSlug}</title>
  <script src="/theme-boot.js"></script>
  <link rel="stylesheet" href="/theme.css" />
  <link rel="stylesheet" href="${SHARE_PREFIX}/styles.css" />
</head>
<body>
  <main class="wrap">
    <p class="crumb"><a href="/">tools.yutok.dev</a> / <a href="/transfer/">transfer</a> / d / ${safeSlug}</p>
    <h1>ダウンロード</h1>
    <p id="info" class="muted">読み込み中…</p>
    <nav id="dir-list" class="dir-list" hidden></nav>
    <form id="form" class="stack" hidden>
      <label>パスワード
        <input type="password" id="password" required autocomplete="current-password" />
      </label>
      <button type="submit">確認して表示</button>
    </form>
    <section id="preview-panel" class="preview-panel" hidden>
      <div id="preview-media" class="preview-media"></div>
      <div class="preview-actions">
        <a id="download-btn" class="secondary-btn" href="#">ダウンロード</a>
      </div>
      <p id="preview-hint" class="muted" hidden></p>
    </section>
    <p id="msg" class="msg" hidden></p>
  </main>
  <script>window.__TRANSFER_SLUG__ = ${JSON.stringify(slug)}; window.__TRANSFER_DL_API__ = ${JSON.stringify(DL_API_PREFIX)};</script>
  <script type="module" src="${SHARE_PREFIX}/download.js"></script>
</body>
</html>`;
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // Keep trailing slash for /share/ so relative asset URLs resolve under /share/
    if (url.pathname === "/share") {
      return Response.redirect(`${url.origin}/share/`, 302);
    }
    let path = url.pathname;
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

    try {
      // Public share assets (outside Cloudflare Access on /transfer*)
      const shareStatic = path.match(
        new RegExp(`^${SHARE_PREFIX}/(app|cost|drive|slug|download)\\.js$`),
      );
      if (shareStatic) {
        return env.ASSETS.fetch(new URL(`/transfer/${shareStatic[1]}.js`, url.origin));
      }
      if (path === `${SHARE_PREFIX}/styles.css`) {
        return env.ASSETS.fetch(new URL("/transfer/styles.css", url.origin));
      }

      // Upload UI on /share (Access-free). /transfer/ is Access bootstrap then redirect here.
      if (path === SHARE_PREFIX || path === `${SHARE_PREFIX}/index.html`) {
        return env.ASSETS.fetch(new URL("/transfer/index.html", url.origin));
      }

      if (path.startsWith(`${SHARE_PREFIX}/api/`) || path.startsWith("/transfer/api")) {
        const apiPath = normalizeApiPath(path);
        return withCors(await handleApi(request, env, apiPath), request);
      }

      if (path.startsWith(`${DL_PAGE_PREFIX}/`) && request.method === "GET") {
        const raw = path.slice(DL_PAGE_PREFIX.length + 1);
        const slugAlt = raw
          .split("/")
          .map((seg) => decodeSlugParam(seg))
          .join("/");
        const finalSlug = slugAlt;
        if (!isValidSlug(finalSlug)) return new Response("Invalid slug", { status: 400 });
        return new Response(downloadPageHtml(finalSlug), {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }

      // Legacy DL path (still Access-protected); redirect to public share URL
      if (path.startsWith("/transfer/d/") && request.method === "GET") {
        const raw = path.slice("/transfer/d/".length);
        const finalSlug = raw
          .split("/")
          .map((seg) => decodeSlugParam(seg))
          .join("/");
        if (!isValidSlug(finalSlug)) return new Response("Invalid slug", { status: 400 });
        return Response.redirect(`${url.origin}${DL_PAGE_PREFIX}/${slugToUrlPath(finalSlug)}`, 302);
      }

      // After Access JWT is issued on /transfer*, send users to public /share UI
      if ((path === "/transfer" || path === "/transfer/index.html") && request.method === "GET") {
        const q = url.search ? `${url.search}&from=access` : "?from=access";
        const hash = url.hash || "";
        return Response.redirect(`${url.origin}${SHARE_PREFIX}/${q}${hash}`.replace("/?&", "/?"), 302);
      }

      if (path.startsWith("/transfer/")) {
        const assetPath = path;
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
