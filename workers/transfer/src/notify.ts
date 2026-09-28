import type { Env } from "./env";
import type { TransferMeta } from "./meta";
import { formatBytes } from "./cost";
import { getAccessTokenForEmail, listConnectedEmails } from "./google";

const DEFAULT_TO = "yuto.k051028@gmail.com";

export type UploadNotifyContext = {
  request: Request;
  origin: string;
  authMode: string;
  downloadPath: string;
};

function notifyTo(env: Env): string {
  return (env.NOTIFY_TO || DEFAULT_TO).trim().toLowerCase() || DEFAULT_TO;
}

/** Gmail account used to send (must have connected Google with gmail.send). */
function notifySenderCandidates(env: Env): string[] {
  const preferred = (env.NOTIFY_GMAIL || env.NOTIFY_TO || DEFAULT_TO).trim().toLowerCase();
  const allow = (env.UPLOAD_ALLOW_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set([preferred, ...allow, DEFAULT_TO].filter(Boolean))];
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function destinationDetails(meta: TransferMeta, ctx: UploadNotifyContext): {
  textLines: string[];
  htmlRows: string[];
} {
  const dlUrl = `${ctx.origin}${ctx.downloadPath}`;
  const textLines = [
    `ファイル名: ${meta.originalName}`,
    `サイズ: ${formatBytes(meta.size)} (${meta.size} bytes)`,
    `Content-Type: ${meta.contentType}`,
    `スラッグ: ${meta.slug}`,
    `ダウンロード URL: ${dlUrl}`,
    `バックエンド: ${meta.backend}`,
    `有効期限: ${new Date(meta.expiresAt).toISOString()}`,
    `認証モード: ${ctx.authMode}`,
    `作成時刻: ${new Date(meta.createdAt).toISOString()}`,
  ];
  const htmlRows: [string, string][] = [
    ["ファイル名", meta.originalName],
    ["サイズ", `${formatBytes(meta.size)} (${meta.size} bytes)`],
    ["Content-Type", meta.contentType],
    ["スラッグ", meta.slug],
    ["ダウンロード URL", dlUrl],
    ["バックエンド", meta.backend],
    ["有効期限", new Date(meta.expiresAt).toISOString()],
    ["認証モード", ctx.authMode],
    ["作成時刻", new Date(meta.createdAt).toISOString()],
  ];

  if (meta.backend === "r2") {
    textLines.push(`R2 key: ${meta.r2Key}`);
    htmlRows.push(["R2 key", meta.r2Key]);
  } else {
    textLines.push(`Drive folderId: ${meta.driveFolderId}`);
    htmlRows.push(["Drive folderId", meta.driveFolderId]);
    if (meta.driveFileId) {
      textLines.push(`Drive fileId: ${meta.driveFileId}`);
      htmlRows.push(["Drive fileId", meta.driveFileId]);
    }
    if (meta.ownerEmail) {
      textLines.push(`Drive owner: ${meta.ownerEmail}`);
      htmlRows.push(["Drive owner", meta.ownerEmail]);
    }
  }

  const ip = ctx.request.headers.get("CF-Connecting-IP") || "(unknown)";
  const ua = ctx.request.headers.get("User-Agent") || "(unknown)";
  const country = ctx.request.headers.get("CF-IPCountry") || "";
  textLines.push(`クライアント IP: ${ip}${country ? ` (${country})` : ""}`);
  textLines.push(`User-Agent: ${ua}`);
  htmlRows.push(["クライアント IP", `${ip}${country ? ` (${country})` : ""}`]);
  htmlRows.push(["User-Agent", ua]);

  return {
    textLines,
    htmlRows: htmlRows.map(
      ([k, v]) =>
        `<tr><th style="text-align:left;padding:4px 12px 4px 0;vertical-align:top">${esc(k)}</th><td style="padding:4px 0;word-break:break-all">${esc(v)}</td></tr>`,
    ),
  };
}

function b64urlUtf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function buildRawMime(opts: {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}): string {
  const boundary = `mix_${crypto.randomUUID().replace(/-/g, "")}`;
  const subjectEncoded = `=?UTF-8?B?${btoa(unescape(encodeURIComponent(opts.subject)))}?=`;
  const lines = [
    `From: tools.yutok.dev transfer <${opts.from}>`,
    `To: ${opts.to}`,
    `Subject: ${subjectEncoded}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    opts.text,
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    opts.html,
    `--${boundary}--`,
    "",
  ];
  return lines.join("\r\n");
}

async function refreshAccessToken(
  env: Env,
  refreshToken: string,
): Promise<string | null> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json()) as { access_token?: string; error?: string };
  if (!res.ok || !json.access_token) return null;
  return json.access_token;
}

async function sendViaGmail(
  env: Env,
  opts: { to: string; subject: string; text: string; html: string },
): Promise<{ ok: true; id?: string; from: string } | { ok: false; reason: string }> {
  // 1) Preferred: shared notify refresh token (kakeibo / gmail-mcp) — no per-upload Google login
  if (env.NOTIFY_GMAIL_REFRESH_TOKEN && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    const access = await refreshAccessToken(env, env.NOTIFY_GMAIL_REFRESH_TOKEN.trim());
    if (access) {
      const from = (env.NOTIFY_GMAIL || env.NOTIFY_TO || DEFAULT_TO).trim().toLowerCase();
      const raw = buildRawMime({
        from,
        to: opts.to,
        subject: opts.subject,
        text: opts.text,
        html: opts.html,
      });
      const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST",
        headers: {
          authorization: `Bearer ${access}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ raw: b64urlUtf8(raw) }),
      });
      if (res.ok) {
        const json = (await res.json()) as { id?: string };
        return { ok: true, id: json.id, from };
      }
      const errText = await res.text();
      console.warn("notify via NOTIFY_GMAIL_REFRESH_TOKEN failed", res.status, errText.slice(0, 200));
    } else {
      console.warn("notify: NOTIFY_GMAIL_REFRESH_TOKEN refresh failed");
    }
  }

  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.TOKEN_ENC_KEY) {
    return { ok: false, reason: "Google OAuth 未設定" };
  }

  const connected = await listConnectedEmails(env);
  const candidates = [
    ...notifySenderCandidates(env).filter((e) => connected.includes(e)),
    ...connected,
  ];
  const unique = [...new Set(candidates)];
  if (!unique.length) {
    return {
      ok: false,
      reason:
        "通知用トークン未設定。NOTIFY_GMAIL_REFRESH_TOKEN を入れるか、Google でログインしてください",
    };
  }

  let lastErr = "token missing";
  for (const email of unique) {
    let tok: { accessToken: string; email: string } | null = null;
    try {
      tok = await getAccessTokenForEmail(env, email);
    } catch (e) {
      lastErr = `${email}: ${e instanceof Error ? e.message : String(e)}`;
      continue;
    }
    if (!tok) {
      lastErr = `${email}: no refresh token`;
      continue;
    }
    const raw = buildRawMime({
      from: tok.email,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
    });
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: {
        authorization: `Bearer ${tok.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ raw: b64urlUtf8(raw) }),
    });
    if (res.ok) {
      const json = (await res.json()) as { id?: string };
      return { ok: true, id: json.id, from: tok.email };
    }
    const errText = await res.text();
    lastErr = `${email}: ${res.status} ${errText.slice(0, 200)}`;
    if (res.status === 403 && /insufficient|ACCESS_TOKEN_SCOPE/i.test(errText)) {
      lastErr = `${email}: Gmail スコープ不足`;
    }
  }
  return { ok: false, reason: lastErr };
}

/**
 * Notify owner of a completed upload. Failures are logged only — never fail the upload.
 * Free path: Gmail API via stored Google OAuth (no Workers Paid / no iCloud MX change).
 * Optional: Cloudflare EMAIL binding to verified destination (also free) if configured.
 */
export async function notifyUploadComplete(
  env: Env,
  meta: TransferMeta,
  ctx: UploadNotifyContext,
): Promise<void> {
  const to = notifyTo(env);
  const { textLines, htmlRows } = destinationDetails(meta, ctx);
  const subject = `[tools-transfer] アップロード完了: ${meta.originalName} (${meta.slug})`;
  const text = ["ファイル転送に新しいアップロードがありました。", "", ...textLines].join("\n");
  const html = `<!DOCTYPE html><html><body>
<p>ファイル転送に新しいアップロードがありました。</p>
<table>${htmlRows.join("")}</table>
</body></html>`;

  // 1) Free primary: Gmail API (keeps iCloud @yutok.dev MX untouched)
  const gmail = await sendViaGmail(env, { to, subject, text, html });
  if (gmail.ok) {
    console.log("notifyUploadComplete gmail ok", gmail.from, gmail.id || "");
    return;
  }
  console.warn("notifyUploadComplete gmail skipped:", gmail.reason);

  // 2) Optional Cloudflare EMAIL (free only to verified destinations; needs CF routing domain)
  if (!env.EMAIL) {
    console.error("notifyUploadComplete: no EMAIL binding and Gmail failed");
    return;
  }
  const from = (env.NOTIFY_FROM || "transfer@notify.yutok.dev").trim();
  try {
    const response = await env.EMAIL.send({
      to,
      from: { email: from, name: "tools.yutok.dev transfer" },
      subject,
      text,
      html,
    });
    console.log("notifyUploadComplete cf-email ok", response?.messageId || "(no messageId)");
  } catch (e) {
    console.error(
      "notifyUploadComplete cf-email failed",
      e instanceof Error ? e.message : String(e),
    );
  }
}
