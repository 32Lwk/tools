const slug = window.__TRANSFER_SLUG__;
const dlApi = window.__TRANSFER_DL_API__ || "/share/api/dl";
const infoEl = document.getElementById("info");
const msgEl = document.getElementById("msg");
const form = document.getElementById("form");
const dirList = document.getElementById("dir-list");
const previewPanel = document.getElementById("preview-panel");
const previewMedia = document.getElementById("preview-media");
const previewHint = document.getElementById("preview-hint");
const downloadBtn = document.getElementById("download-btn");

const PREVIEW_TEXT_MAX = 512 * 1024;

function showMsg(text, ok = false) {
  msgEl.hidden = !text;
  msgEl.textContent = text || "";
  msgEl.classList.toggle("ok", !!ok);
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return String(n);
  const units = ["B", "KiB", "MiB", "GiB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function fileUrl(token, { inline = false } = {}) {
  const q = new URLSearchParams({ token });
  if (inline) q.set("inline", "1");
  return `${dlApi}/${encodeURIComponent(slug)}/file?${q}`;
}

function clearPreview() {
  previewMedia.replaceChildren();
  previewHint.hidden = true;
  previewHint.textContent = "";
  previewPanel.hidden = true;
  downloadBtn.removeAttribute("href");
  downloadBtn.removeAttribute("download");
}

function previewKind(contentType = "", name = "") {
  const type = (contentType || "").toLowerCase().split(";")[0].trim();
  const lower = (name || "").toLowerCase();
  if (type.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(lower)) return "image";
  if (type.startsWith("video/") || /\.(mp4|webm|ogg|mov)$/i.test(lower)) return "video";
  if (type.startsWith("audio/") || /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(lower)) return "audio";
  if (type === "application/pdf" || lower.endsWith(".pdf")) return "pdf";
  if (
    type.startsWith("text/") ||
    type === "application/json" ||
    type === "application/xml" ||
    /\.(txt|md|csv|json|xml|html?|css|js|ts|log)$/i.test(lower)
  ) {
    return "text";
  }
  return "none";
}

async function renderPreview({ token, filename, contentType, size }) {
  clearPreview();
  const kind = previewKind(contentType, filename);
  const inlineUrl = fileUrl(token, { inline: true });
  const attachUrl = fileUrl(token);

  downloadBtn.href = attachUrl;
  downloadBtn.download = filename || slug;
  previewPanel.hidden = false;

  if (kind === "image") {
    const img = document.createElement("img");
    img.src = inlineUrl;
    img.alt = filename || "preview";
    img.className = "preview-image";
    previewMedia.appendChild(img);
    return;
  }

  if (kind === "video") {
    const video = document.createElement("video");
    video.src = inlineUrl;
    video.controls = true;
    video.className = "preview-video";
    previewMedia.appendChild(video);
    return;
  }

  if (kind === "audio") {
    const audio = document.createElement("audio");
    audio.src = inlineUrl;
    audio.controls = true;
    audio.className = "preview-audio";
    previewMedia.appendChild(audio);
    return;
  }

  if (kind === "pdf") {
    const frame = document.createElement("iframe");
    frame.src = inlineUrl;
    frame.title = filename || "PDF preview";
    frame.className = "preview-frame";
    previewMedia.appendChild(frame);
    return;
  }

  if (kind === "text") {
    if (size > PREVIEW_TEXT_MAX) {
      previewHint.hidden = false;
      previewHint.textContent = "テキストが大きいためプレビューは省略します。ダウンロードしてください。";
      return;
    }
    const res = await fetch(inlineUrl);
    if (!res.ok) throw new Error("プレビューの取得に失敗しました");
    const text = await res.text();
    const pre = document.createElement("pre");
    pre.className = "preview-text";
    pre.textContent = text;
    previewMedia.appendChild(pre);
    return;
  }

  previewHint.hidden = false;
  previewHint.textContent = "この形式はプレビュー非対応です。下のボタンからダウンロードできます。";
}

function renderDir(data) {
  form.hidden = true;
  dirList.hidden = false;
  dirList.replaceChildren();
  const exp = data.expiresAt ? ` / 期限 ${new Date(data.expiresAt).toLocaleString()}` : "";
  infoEl.textContent = `フォルダ「${data.slug}」（${data.entries.length} 項目）${exp}`;
  for (const e of data.entries) {
    const a = document.createElement("a");
    a.className = "dir-item";
    a.href = e.path || `/share/d/${e.slug}`;
    if (e.kind === "dir") {
      a.textContent = `${e.name}/`;
    } else {
      a.textContent = `${e.originalName || e.name}（${formatBytes(e.size)}）`;
    }
    dirList.appendChild(a);
  }
}

async function loadInfo() {
  try {
    const res = await fetch(`${dlApi}/${encodeURIComponent(slug)}/info`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "not found");
    if (data.type === "dir") {
      renderDir(data);
      return;
    }
    form.hidden = false;
    dirList.hidden = true;
    const backend = data.backend === "drive" ? "Drive" : "R2";
    const sizeLabel = formatBytes(data.size);
    infoEl.textContent = `${data.originalName}（${sizeLabel} · ${backend}） / 期限 ${new Date(data.expiresAt).toLocaleString()}`;
  } catch (e) {
    infoEl.textContent = `取得できません: ${e.message}`;
    form.hidden = true;
    dirList.hidden = true;
  }
}

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  showMsg("");
  clearPreview();
  const password = document.getElementById("password").value;
  try {
    const authRes = await fetch(`${dlApi}/${encodeURIComponent(slug)}/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const auth = await authRes.json();
    if (!authRes.ok) throw new Error(auth.error || "auth failed");
    await renderPreview({
      token: auth.token,
      filename: auth.filename || slug,
      contentType: auth.contentType || "",
      size: auth.size || 0,
    });
    showMsg("パスワードを確認しました", true);
  } catch (e) {
    showMsg(e.message || String(e));
  }
});

loadInfo();
