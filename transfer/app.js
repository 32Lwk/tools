import { estimateR2Cost, formatBytes, MAX_BYTES, PART_SIZE } from "./cost.js";

const $ = (id) => document.getElementById(id);

function showMsg(text, ok = false) {
  const el = $("r2-msg");
  el.hidden = !text;
  el.textContent = text || "";
  el.classList.toggle("ok", !!ok);
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

async function refreshStatus() {
  const line = $("status-line");
  try {
    const res = await fetch("/transfer/api/status");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    if (data.active) {
      line.textContent = `現在保管中: ${data.active.slug}（${formatBytes(data.active.size)}） / 期限 ${new Date(data.active.expiresAt).toLocaleString()}`;
    } else {
      line.textContent = "空きスロットあり（同時保管 1 本・最大 15 GiB・24 時間）";
    }
  } catch (e) {
    line.textContent = `状態取得に失敗（Worker 未デプロイの可能性）: ${e.message}`;
  }
}

async function uploadFile(file, slug, password) {
  const initRes = await fetch("/transfer/api/r2/init", {
    method: "POST",
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
  const init = await initRes.json();
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
    const partRes = await fetch(url, { method: "PUT", body: blob });
    const partJson = await partRes.json();
    if (!partRes.ok) throw new Error(partJson.error || `part ${partNumber} failed`);
    parts.push({ partNumber: partJson.partNumber, etag: partJson.etag });
    const pct = Math.round((partNumber / totalParts) * 100);
    $("progress-bar").style.width = `${pct}%`;
    $("progress-text").textContent = `アップロード中… ${partNumber}/${totalParts} (${pct}%)`;
  }

  const doneRes = await fetch("/transfer/api/r2/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug, uploadId: init.uploadId, parts }),
  });
  const done = await doneRes.json();
  if (!doneRes.ok) throw new Error(done.error || "complete failed");
  return done;
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
      const link = $("result-link");
      link.href = href;
      link.textContent = `${location.origin}${href}`;
      $("result").hidden = false;
      showMsg("アップロード完了", true);
      await refreshStatus();
    } catch (e) {
      showMsg(e.message || String(e));
      try {
        await fetch("/transfer/api/r2/abort", {
          method: "DELETE",
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

wireTabs();
wireForm();
refreshStatus();