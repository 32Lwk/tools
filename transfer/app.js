import { estimateR2Cost, formatBytes, MAX_BYTES, PART_SIZE } from "./cost.js";

const $ = (id) => document.getElementById(id);

let qrModulePromise = null;

function loadQrModule() {
  if (!qrModulePromise) {
    qrModulePromise = import("https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm");
  }
  return qrModulePromise;
}

function showMsg(text, ok = false) {
  const el = $("r2-msg");
  el.hidden = !text;
  el.textContent = text || "";
  el.classList.toggle("ok", !!ok);
}

function showAuthMsg(text, ok = false) {
  const el = $("auth-msg");
  el.hidden = !text;
  el.textContent = text || "";
  el.classList.toggle("ok", !!ok);
}

function showShareMsg(text, ok = false) {
  const el = $("share-msg");
  el.hidden = !text;
  el.textContent = text || "";
  el.classList.toggle("ok", !!ok);
}

function showSettingsMsg(text, ok = false) {
  const el = $("settings-msg");
  el.hidden = !text;
  el.textContent = text || "";
  el.classList.toggle("ok", !!ok);
}

function setAuthenticated(ok) {
  $("auth-gate").hidden = ok;
  $("upload-area").hidden = !ok;
  $("settings-auth-hint").hidden = ok;
  $("settings-purge").disabled = !ok;
  $("settings-refresh").disabled = false;
}

function wireTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => {
        const on = t === tab;
        t.classList.toggle("active", on);
        t.setAttribute("aria-selected", on ? "true" : "false");
      });
      document.querySelectorAll(".panel").forEach((p) => {
        p.hidden = p.id !== `panel-${tab.dataset.tab}`;
      });
    });
  });
}

function renderCost(file) {
  const box = $("cost-box");
  const list = $("cost-list");
  const ack = $("cost-ack");
  const btn = $("upload-btn");
  if (!file) {
    box.hidden = true;
    ack.checked = false;
    btn.disabled = true;
    return null;
  }
  const estimate = estimateR2Cost(file.size);
  list.innerHTML = `
    <li>サイズ: <strong>${formatBytes(file.size)}</strong></li>
    <li>保管: 24 時間（約 <strong>${estimate.gbMonth.toFixed(3)} GB-month</strong>）</li>
    <li>Class A 概算: <strong>${estimate.classAOps.toLocaleString()}</strong> ops</li>
    <li>超過時の概算料金: <strong>$${estimate.totalUsd.toFixed(4)}</strong>（無料枠内なら $0）</li>
    <li>無料枠内: <strong>${estimate.withinFreeBudget ? "はい" : "いいえ"}</strong></li>
  `;
  for (const w of estimate.warnings) {
    const li = document.createElement("li");
    li.textContent = `注意: ${w}`;
    list.appendChild(li);
  }
  box.hidden = false;
  const overCap = file.size > MAX_BYTES;
  btn.disabled = !(ack.checked && !overCap);
  return estimate;
}

async function readJsonResponse(res) {
  const text = await res.text();
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("<!") || trimmed.startsWith("<html")) {
    const err = new Error(
      "転送 API が HTML を返しました（Worker 未経由）。Chrome など通常ブラウザで開くか、DNS 橙雲とキャッシュを確認してください。",
    );
    err.code = "API_HTML";
    throw err;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const err = new Error("転送 API の応答が JSON ではありません");
    err.code = "API_NOT_JSON";
    throw err;
  }
}

async function refreshStatus() {
  const line = $("status-line");
  try {
    const res = await fetch("/transfer/api/status", { credentials: "include" });
    const data = await readJsonResponse(res);
    if (res.status === 401 || data.authRequired) {
      line.textContent = "未認証のため状態は表示しません";
      setAuthenticated(false);
      return;
    }
    if (!res.ok) throw new Error(data.error || res.statusText);
    setAuthenticated(true);
    if (data.active) {
      line.textContent = `現在保管中: ${data.active.slug}（${formatBytes(data.active.size)}） / 期限 ${new Date(data.active.expiresAt).toLocaleString()}`;
    } else {
      line.textContent = "空きスロットあり（同時保管 1 本・最大 15 GiB・24 時間）";
    }
  } catch (e) {
    line.textContent = `状態取得に失敗: ${e.message}`;
    $("auth-gate").hidden = false;
    $("upload-area").hidden = true;
  }
}

async function checkAuth() {
  try {
    const res = await fetch("/transfer/api/auth/me", { credentials: "include" });
    if (res.ok) {
      setAuthenticated(true);
      return true;
    }
  } catch {
    /* ignore */
  }
  setAuthenticated(false);
  return false;
}

async function uploadFile(file, slug, password) {
  const initRes = await fetch("/transfer/api/r2/init", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      slug,
      password,
      filename: file.name,
      size: file.size,
      contentType: file.type || "application/octet-stream",
      costAck: true,
    }),
  });
  const init = await readJsonResponse(initRes);
  if (initRes.status === 401 || init.authRequired) {
    setAuthenticated(false);
    throw new Error(init.error || "認証が必要です");
  }
  if (!initRes.ok) throw new Error(init.error || "init failed");

  const partSize = init.partSize || PART_SIZE;
  const parts = [];
  const totalParts = Math.max(1, Math.ceil(file.size / partSize));
  $("progress-wrap").hidden = false;

  for (let i = 0; i < totalParts; i++) {
    const start = i * partSize;
    const blob = file.slice(start, Math.min(file.size, start + partSize));
    const partNumber = i + 1;
    const url = `/transfer/api/r2/part?slug=${encodeURIComponent(slug)}&uploadId=${encodeURIComponent(init.uploadId)}&partNumber=${partNumber}`;
    const partRes = await fetch(url, { method: "PUT", body: blob, credentials: "include" });
    const partJson = await readJsonResponse(partRes);
    if (!partRes.ok) throw new Error(partJson.error || `part ${partNumber} failed`);
    parts.push({ partNumber: partJson.partNumber, etag: partJson.etag });
    const pct = Math.round((partNumber / totalParts) * 100);
    $("progress-bar").style.width = `${pct}%`;
    $("progress-text").textContent = `アップロード中… ${partNumber}/${totalParts} (${pct}%)`;
  }

  const doneRes = await fetch("/transfer/api/r2/complete", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug, uploadId: init.uploadId, parts }),
  });
  const done = await readJsonResponse(doneRes);
  if (!doneRes.ok) throw new Error(done.error || "complete failed");
  return done;
}

async function renderShareResult(href) {
  const absolute = href.startsWith("http") ? href : `${location.origin}${href}`;
  const link = $("result-link");
  link.href = absolute;
  link.textContent = absolute;
  $("result").hidden = false;
  showShareMsg("");

  try {
    const QRCode = await loadQrModule();
    const canvas = $("result-qr");
    await QRCode.toCanvas(canvas, absolute, {
      width: 160,
      margin: 1,
      color: { dark: "#111111", light: "#ffffff" },
    });
  } catch (e) {
    showShareMsg(`QR 生成に失敗: ${e.message || e}`);
  }
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
}

function wireShare() {
  $("copy-link-btn").addEventListener("click", async () => {
    const url = $("result-link").href;
    try {
      await copyText(url);
      showShareMsg("リンクをコピーしました", true);
    } catch (e) {
      showShareMsg(e.message || "コピーに失敗しました");
    }
  });

  $("share-btn").addEventListener("click", async () => {
    const url = $("result-link").href;
    try {
      if (navigator.share) {
        await navigator.share({ title: "ファイル転送", text: "ダウンロードリンク", url });
        showShareMsg("共有シートを開きました", true);
      } else {
        await copyText(url);
        showShareMsg("この端末では共有 API 非対応のため、リンクをコピーしました", true);
      }
    } catch (e) {
      if (e?.name === "AbortError") return;
      showShareMsg(e.message || "共有に失敗しました");
    }
  });
}

function wireAuth() {
  $("auth-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    showAuthMsg("");
    const password = $("gate-password").value.trim();
    if (!password) {
      showAuthMsg("ゲートパスワードを入力してください");
      return;
    }
    $("auth-btn").disabled = true;
    try {
      const res = await fetch("/transfer/api/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.status === 405) {
        throw new Error(
          "POST が GitHub Pages に遮断されています（405）。Chrome など通常ブラウザで開くか、DNS 橙雲とキャッシュを確認してください。",
        );
      }
      const data = await readJsonResponse(res);
      if (!res.ok) throw new Error(data.error || "認証に失敗しました");
      $("gate-password").value = "";
      setAuthenticated(true);
      showAuthMsg("");
      await refreshStatus();
      if (!$("settings-dialog").open) {
        /* keep dialog state */
      } else {
        await loadSettingsList();
      }
    } catch (e) {
      showAuthMsg(e.message || String(e));
      setAuthenticated(false);
    } finally {
      $("auth-btn").disabled = false;
    }
  });

  $("logout-btn").addEventListener("click", async () => {
    await fetch("/transfer/api/auth/logout", { method: "POST", credentials: "include" });
    setAuthenticated(false);
    $("status-line").textContent = "ログアウトしました";
  });
}

function wireForm() {
  const fileInput = $("file");
  const ack = $("cost-ack");

  const update = () => {
    renderCost(fileInput.files?.[0] || null);
  };

  fileInput.addEventListener("change", update);
  ack.addEventListener("change", update);

  $("r2-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    showMsg("");
    const file = fileInput.files?.[0];
    const slug = $("slug").value.trim();
    const password = $("password").value;
    if (!file || !ack.checked) return;
    $("upload-btn").disabled = true;
    try {
      const done = await uploadFile(file, slug, password);
      const href = done.downloadPath || `/transfer/d/${slug}`;
      await renderShareResult(href);
      showMsg("アップロード完了", true);
      await refreshStatus();
    } catch (e) {
      showMsg(e.message || String(e));
      try {
        await fetch("/transfer/api/r2/abort", {
          method: "DELETE",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ slug }),
        });
      } catch {
        /* ignore */
      }
    } finally {
      update();
    }
  });
}

function renderSettingsList(data) {
  const list = $("settings-list");
  list.innerHTML = "";
  const transfers = data.transfers || [];
  const orphans = data.orphans || [];

  if (!transfers.length && !orphans.length) {
    list.innerHTML = `<p class="muted">R2 上に転送データはありません。</p>`;
    return;
  }

  for (const t of transfers) {
    const el = document.createElement("article");
    el.className = "settings-item";
    el.innerHTML = `
      <h3>${t.slug} <span class="muted">(${t.status})</span></h3>
      <p class="meta">${t.originalName} · ${formatBytes(t.size)}</p>
      <p class="meta">作成 ${new Date(t.createdAt).toLocaleString()} / 期限 ${new Date(t.expiresAt).toLocaleString()}</p>
      <p class="meta">${t.r2Key}</p>
      <div class="row-actions">
        <a class="secondary-btn" href="/transfer/d/${encodeURIComponent(t.slug)}" target="_blank" rel="noopener">DL ページ</a>
        <button type="button" class="danger-btn" data-del-slug="${t.slug}">削除</button>
      </div>
    `;
    list.appendChild(el);
  }

  for (const o of orphans) {
    const el = document.createElement("article");
    el.className = "settings-item";
    el.innerHTML = `
      <h3>孤立オブジェクト</h3>
      <p class="meta">${o.key} · ${formatBytes(o.size)}</p>
      <p class="meta">uploaded ${new Date(o.uploaded).toLocaleString()}</p>
      <div class="row-actions">
        <button type="button" class="danger-btn" data-del-key="${o.key}">削除</button>
      </div>
    `;
    list.appendChild(el);
  }
}

async function loadSettingsList() {
  showSettingsMsg("");
  $("settings-summary").textContent = "読み込み中…";
  try {
    const res = await fetch("/transfer/api/admin/r2", { credentials: "include" });
    if (res.status === 401) {
      setAuthenticated(false);
      $("settings-summary").textContent = "未認証です。ゲートパスワードでログインしてください。";
      $("settings-list").innerHTML = "";
      return;
    }
    const data = await readJsonResponse(res);
    if (!res.ok) throw new Error(data.error || res.statusText);
    setAuthenticated(true);
    const totals = data.totals || { transferCount: 0, objectCount: 0, bytes: 0 };
    $("settings-summary").textContent =
      `転送 ${totals.transferCount} 件 / オブジェクト ${totals.objectCount} 件 / 合計 ${formatBytes(totals.bytes)}` +
      (data.slot ? ` / スロット: ${data.slot}` : " / スロット空き");
    renderSettingsList(data);
  } catch (e) {
    $("settings-summary").textContent = "取得に失敗しました";
    showSettingsMsg(e.message || String(e));
  }
}

async function deleteAdmin({ slug, key, all }) {
  const res = await fetch("/transfer/api/admin/r2", {
    method: "DELETE",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug, key, all }),
  });
  const data = await readJsonResponse(res);
  if (!res.ok) throw new Error(data.error || "削除に失敗しました");
  return data;
}

function wireSettings() {
  const dialog = $("settings-dialog");
  $("settings-btn").addEventListener("click", async () => {
    dialog.showModal();
    await loadSettingsList();
  });

  $("settings-refresh").addEventListener("click", () => loadSettingsList());

  $("settings-purge").addEventListener("click", async () => {
    if (!confirm("R2 上の転送データと孤立オブジェクトをすべて削除します。よろしいですか？")) return;
    try {
      const result = await deleteAdmin({ all: true });
      showSettingsMsg(
        `すべて削除しました（転送 ${result.deletedTransfers || 0} / オブジェクト ${result.deletedObjects || 0}）`,
        true,
      );
      await loadSettingsList();
      await refreshStatus();
    } catch (e) {
      showSettingsMsg(e.message || String(e));
    }
  });

  $("settings-list").addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-del-slug], [data-del-key]");
    if (!btn) return;
    const slug = btn.getAttribute("data-del-slug");
    const key = btn.getAttribute("data-del-key");
    const label = slug || key;
    if (!confirm(`削除します: ${label}`)) return;
    try {
      await deleteAdmin(slug ? { slug } : { key });
      showSettingsMsg("削除しました", true);
      await loadSettingsList();
      await refreshStatus();
    } catch (e) {
      showSettingsMsg(e.message || String(e));
    }
  });
}

wireTabs();
wireAuth();
wireForm();
wireShare();
wireSettings();
(async () => {
  const ok = await checkAuth();
  if (ok) await refreshStatus();
  else {
    $("status-line").textContent = "アップロードには認証が必要です";
    $("auth-gate").hidden = false;
  }
})();
