import { estimateR2Cost, formatBytes, FREE_STORAGE_BYTES, MAX_BYTES, PART_SIZE } from "./cost.js";
import { uploadToDriveResumable } from "./drive.js";

const $ = (id) => document.getElementById(id);

let qrModulePromise = null;
let authState = { authenticated: false, email: null, mode: null, accessLogoutUrl: null };
let authMethodsState = { access: false, google: false };

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

function showDriveMsg(text, ok = false) {
  const el = $("drive-msg");
  el.hidden = !text;
  el.textContent = text || "";
  el.classList.toggle("ok", !!ok);
}

function showDriveShareMsg(text, ok = false) {
  const el = $("drive-share-msg");
  el.hidden = !text;
  el.textContent = text || "";
  el.classList.toggle("ok", !!ok);
}

function showDriveConnectMsg(text, ok = false) {
  const el = $("drive-connect-msg");
  el.hidden = !text;
  el.textContent = text || "";
  el.classList.toggle("ok", !!ok);
}

function setAuthenticated(ok, identity = null) {
  authState.authenticated = ok;
  if (identity) {
    authState.email = identity.email || null;
    authState.mode = identity.mode || null;
    authState.accessLogoutUrl = identity.accessLogoutUrl || null;
  }
  if (!ok) {
    authState.email = null;
    authState.mode = null;
  }

  $("auth-gate").hidden = ok;
  $("upload-area").hidden = !ok;
  $("settings-auth-hint").hidden = ok;
  $("settings-purge").disabled = !ok;
  $("settings-refresh").disabled = false;

  const label = $("auth-user-label");
  if (ok) {
    const who = authState.email ? `（${authState.email}）` : "";
    const mode = authState.mode ? ` · ${authState.mode}` : "";
    label.textContent = `認証済み${who}${mode}`;
  }
}

function activateTab(tabName) {
  document.querySelectorAll(".tab").forEach((t) => {
    const on = t.dataset.tab === tabName;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll(".panel").forEach((p) => {
    p.hidden = p.id !== `panel-${tabName}`;
  });
  if (tabName === "drive") refreshDriveStatus();
}

function wireTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      activateTab(tab.dataset.tab);
      if (tab.dataset.tab === "drive") {
        history.replaceState(null, "", "#drive");
      } else if (location.hash === "#drive") {
        history.replaceState(null, "", location.pathname + location.search);
      }
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

async function loadAuthMethods() {
  try {
    const res = await fetch("/share/api/auth/methods", { credentials: "include" });
    const data = await readJsonResponse(res);
    authMethodsState = {
      access: !!data.access,
      google: !!data.google,
    };

    const accessBtn = $("auth-access-btn");
    const googleBtn = $("auth-google-btn");
    const hint = $("auth-config-hint");

    if (data.access && data.accessLoginUrl) {
      accessBtn.hidden = false;
      accessBtn.href = data.accessLoginUrl;
    } else {
      accessBtn.hidden = true;
    }

    if (data.google) {
      googleBtn.hidden = false;
      googleBtn.href = `/share/api/auth/google/start?returnTo=${encodeURIComponent(`${location.origin}/transfer/`)}`;
      $("drive-google-btn").href =
        `/share/api/auth/google/start?returnTo=${encodeURIComponent(`${location.origin}/transfer/#drive`)}`;
    } else {
      googleBtn.hidden = true;
    }

    hint.hidden = !!(data.access || data.google);
    return data;
  } catch (e) {
    showAuthMsg(e.message || String(e));
    $("auth-config-hint").hidden = false;
    return null;
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
    setAuthenticated(true, authState);
    const used = typeof data.usedBytes === "number" ? data.usedBytes : 0;
    const cap = data.limits?.maxTotalBytes || FREE_STORAGE_BYTES;
    const actives = Array.isArray(data.actives) ? data.actives : data.active ? [data.active] : [];
    const capLabel = `${formatBytes(used)} / ${formatBytes(cap)}`;
    if (actives.length === 0) {
      line.textContent = `空きあり（${capLabel}・並列無制限・保管 24 時間）`;
    } else {
      const names = actives
        .slice(0, 3)
        .map((a) => a.slug)
        .join(", ");
      const more = actives.length > 3 ? ` ほか ${actives.length - 3} 本` : "";
      line.textContent = `使用中 ${capLabel}（${actives.length} 本: ${names}${more}）`;
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
    const data = await readJsonResponse(res);
    if (res.ok && data.authenticated) {
      setAuthenticated(true, data);
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
    const partUrl = `/transfer/api/r2/part?slug=${encodeURIComponent(slug)}&uploadId=${encodeURIComponent(init.uploadId)}&partNumber=${partNumber}`;
    const partRes = await fetch(partUrl, { method: "PUT", body: blob, credentials: "include" });
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

async function renderShareResult(href, {
  linkId = "result-link",
  resultId = "result",
  qrId = "result-qr",
  shareMsg = showShareMsg,
} = {}) {
  const absolute = href.startsWith("http") ? href : `${location.origin}${href}`;
  const link = $(linkId);
  link.href = absolute;
  link.textContent = absolute;
  $(resultId).hidden = false;
  shareMsg("");

  try {
    const QRCode = await loadQrModule();
    const canvas = $(qrId);
    await QRCode.toCanvas(canvas, absolute, {
      width: 160,
      margin: 1,
      color: { dark: "#111111", light: "#ffffff" },
    });
  } catch (e) {
    shareMsg(`QR 生成に失敗: ${e.message || e}`);
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

  $("drive-copy-link-btn").addEventListener("click", async () => {
    try {
      await copyText($("drive-result-link").href);
      showDriveShareMsg("リンクをコピーしました", true);
    } catch (e) {
      showDriveShareMsg(e.message || "コピーに失敗しました");
    }
  });

  $("drive-share-btn").addEventListener("click", async () => {
    const url = $("drive-result-link").href;
    try {
      if (navigator.share) {
        await navigator.share({ title: "ファイル転送", text: "ダウンロードリンク", url });
        showDriveShareMsg("共有シートを開きました", true);
      } else {
        await copyText(url);
        showDriveShareMsg("この端末では共有 API 非対応のため、リンクをコピーしました", true);
      }
    } catch (e) {
      if (e?.name === "AbortError") return;
      showDriveShareMsg(e.message || "共有に失敗しました");
    }
  });
}

function wireAuth() {
  $("logout-btn").addEventListener("click", async () => {
    try {
      const res = await fetch("/transfer/api/auth/logout", {
        method: "POST",
        credentials: "include",
      });
      const data = await readJsonResponse(res).catch(() => ({}));
      setAuthenticated(false);
      $("status-line").textContent = "ログアウトしました";
      $("drive-area").hidden = true;
      $("drive-connect").hidden = false;
      $("drive-status-line").textContent = "未認証です";
      const accessLogout = data.accessLogoutUrl || authState.accessLogoutUrl;
      if (accessLogout && authState.mode === "access") {
        location.href = accessLogout;
      }
    } catch {
      setAuthenticated(false);
    }
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
      const href = done.downloadPath || `/share/d/${slug}`;
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

async function refreshDriveStatus() {
  const line = $("drive-status-line");
  showDriveConnectMsg("");
  try {
    if (!authState.authenticated) {
      const ok = await checkAuth();
      if (!ok) {
        line.textContent = "アップロード認証が必要です（上部のログイン）";
        $("drive-connect").hidden = false;
        $("drive-area").hidden = true;
        return;
      }
    }

    const res = await fetch("/transfer/api/drive/status", { credentials: "include" });
    const data = await readJsonResponse(res);
    if (res.status === 401 || data.authRequired) {
      setAuthenticated(false);
      line.textContent = "未認証です";
      $("drive-connect").hidden = false;
      $("drive-area").hidden = true;
      return;
    }
    if (!res.ok) throw new Error(data.error || res.statusText);

    if (!data.googleConfigured) {
      line.textContent = "Google OAuth が未設定です（GOOGLE_CLIENT_ID 等）";
      $("drive-connect").hidden = true;
      $("drive-area").hidden = true;
      return;
    }

    if (!data.connected) {
      line.textContent = "Google Drive 未接続";
      $("drive-connect").hidden = false;
      $("drive-area").hidden = true;
      return;
    }

    $("drive-connect").hidden = true;
    $("drive-area").hidden = false;
    line.textContent = `接続中: ${data.email}`;
    if (data.folder) {
      $("drive-folder-info").textContent =
        `割当フォルダ: ${data.folder.name}（${data.folder.id}）`;
      $("drive-folder-name").value = data.folder.name;
    } else {
      $("drive-folder-info").textContent =
        "フォルダ未割当です。名前を指定して「フォルダを割り当て」するか、アップロード時に tools-transfer が作成されます。";
      $("drive-folder-name").value = "tools-transfer";
    }
  } catch (e) {
    line.textContent = `Drive 状態取得に失敗: ${e.message}`;
    $("drive-connect").hidden = false;
    $("drive-area").hidden = true;
  }
}

function wireDrive() {
  const fileInput = $("drive-file");
  const ack = $("drive-cost-ack");
  const btn = $("drive-upload-btn");

  const update = () => {
    const file = fileInput.files?.[0];
    const over = file && file.size > MAX_BYTES;
    btn.disabled = !(file && ack.checked && !over);
  };
  fileInput.addEventListener("change", update);
  ack.addEventListener("change", update);

  $("drive-folder-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    showDriveMsg("");
    $("drive-folder-btn").disabled = true;
    try {
      const res = await fetch("/transfer/api/drive/folder", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ folderName: $("drive-folder-name").value.trim() || "tools-transfer" }),
      });
      const data = await readJsonResponse(res);
      if (!res.ok) throw new Error(data.error || "folder failed");
      $("drive-folder-info").textContent =
        `割当フォルダ: ${data.folder.name}（${data.folder.id}）`;
      showDriveMsg("フォルダを割り当てました", true);
    } catch (e) {
      showDriveMsg(e.message || String(e));
    } finally {
      $("drive-folder-btn").disabled = false;
    }
  });

  $("drive-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    showDriveMsg("");
    const file = fileInput.files?.[0];
    const slug = $("drive-slug").value.trim();
    const password = $("drive-password").value;
    if (!file || !ack.checked) return;
    btn.disabled = true;
    $("drive-progress-wrap").hidden = false;
    $("drive-progress-bar").style.width = "0%";
    $("drive-progress-text").textContent = "セッション準備中…";

    try {
      const initRes = await fetch("/transfer/api/drive/init", {
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

      const uploaded = await uploadToDriveResumable({
        accessToken: init.accessToken,
        resumableCreate: init.upload.resumableCreate,
        metadata: init.metadata,
        file,
        onProgress: (pct, loaded, total) => {
          $("drive-progress-bar").style.width = `${pct}%`;
          $("drive-progress-text").textContent =
            `Drive アップロード中… ${formatBytes(loaded)} / ${formatBytes(total)} (${pct}%)`;
        },
      });

      const doneRes = await fetch("/transfer/api/drive/complete", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug, driveFileId: uploaded.id }),
      });
      const done = await readJsonResponse(doneRes);
      if (!doneRes.ok) throw new Error(done.error || "complete failed");

      const href = done.downloadPath || `/share/d/${slug}`;
      await renderShareResult(href, {
        linkId: "drive-result-link",
        resultId: "drive-result",
        qrId: "drive-result-qr",
        shareMsg: showDriveShareMsg,
      });
      showDriveMsg("アップロード完了", true);
      $("drive-progress-text").textContent = "完了";
    } catch (e) {
      showDriveMsg(e.message || String(e));
      try {
        await fetch("/transfer/api/drive/abort", {
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
    list.innerHTML = `<p class="muted">転送データはありません。</p>`;
    return;
  }

  for (const t of transfers) {
    const el = document.createElement("article");
    el.className = "settings-item";
    const loc =
      t.backend === "drive"
        ? `Drive: ${t.driveFileId || "(pending)"}`
        : t.r2Key || "";
    el.innerHTML = `
      <h3>${t.slug} <span class="muted">(${t.backend || "r2"} / ${t.status})</span></h3>
      <p class="meta">${t.originalName} · ${formatBytes(t.size)}</p>
      <p class="meta">作成 ${new Date(t.createdAt).toLocaleString()} / 期限 ${new Date(t.expiresAt).toLocaleString()}</p>
      <p class="meta">${loc}</p>
      <div class="row-actions">
        <a class="secondary-btn" href="/share/d/${encodeURIComponent(t.slug)}" target="_blank" rel="noopener">DL ページ</a>
        <button type="button" class="danger-btn" data-del-slug="${t.slug}">削除</button>
      </div>
    `;
    list.appendChild(el);
  }

  for (const o of orphans) {
    const el = document.createElement("article");
    el.className = "settings-item";
    el.innerHTML = `
      <h3>孤立オブジェクト（R2）</h3>
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
      $("settings-summary").textContent =
        "未認証です。Zero Trust または Google でログインしてください。";
      $("settings-list").innerHTML = "";
      return;
    }
    const data = await readJsonResponse(res);
    if (!res.ok) throw new Error(data.error || res.statusText);
    setAuthenticated(true, authState);
    const totals = data.totals || { transferCount: 0, objectCount: 0, bytes: 0 };
    $("settings-summary").textContent =
      `転送 ${totals.transferCount} 件 / R2 オブジェクト ${totals.objectCount} 件 / 合計 ${formatBytes(totals.bytes)}` +
      (data.slot ? ` / R2 スロット: ${data.slot}` : " / R2 スロット空き");
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
    if (!confirm("転送メタデータと R2 オブジェクトをすべて削除します（Drive 上のファイル本体は残ります）。よろしいですか？")) {
      return;
    }
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

function handleAuthErrorQuery() {
  const params = new URLSearchParams(location.search);
  const err = params.get("auth_error");
  if (!err) return;
  showAuthMsg(`認証エラー: ${err}`);
  $("auth-gate").hidden = false;
  params.delete("auth_error");
  const next = `${location.pathname}${params.toString() ? `?${params}` : ""}${location.hash}`;
  history.replaceState(null, "", next);
}

wireTabs();
wireAuth();
wireForm();
wireDrive();
wireShare();
wireSettings();
(async () => {
  handleAuthErrorQuery();
  await loadAuthMethods();
  const ok = await checkAuth();
  if (ok) {
    await refreshStatus();
  } else {
    $("status-line").textContent = "アップロードには認証が必要です";
    $("auth-gate").hidden = false;
  }
  if (location.hash === "#drive") {
    activateTab("drive");
  } else if (ok) {
    /* drive status lazy on tab */
  }
})();
