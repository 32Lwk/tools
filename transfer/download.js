const slug = window.__TRANSFER_SLUG__;
const infoEl = document.getElementById("info");
const msgEl = document.getElementById("msg");
const form = document.getElementById("form");

function showMsg(text) {
  msgEl.hidden = !text;
  msgEl.textContent = text || "";
}

async function loadInfo() {
  try {
    const res = await fetch(`/transfer/api/dl/${encodeURIComponent(slug)}/info`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "not found");
    infoEl.textContent = `${data.originalName}（${data.size} bytes） / 期限 ${new Date(data.expiresAt).toLocaleString()}`;
  } catch (e) {
    infoEl.textContent = `取得できません: ${e.message}`;
    form.hidden = true;
  }
}

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  showMsg("");
  const password = document.getElementById("password").value;
  try {
    const authRes = await fetch(`/transfer/api/dl/${encodeURIComponent(slug)}/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const auth = await authRes.json();
    if (!authRes.ok) throw new Error(auth.error || "auth failed");
    const url = `/transfer/api/dl/${encodeURIComponent(slug)}/file?token=${encodeURIComponent(auth.token)}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = auth.filename || slug;
    document.body.appendChild(a);
    a.click();
    a.remove();
    showMsg("ダウンロードを開始しました");
  } catch (e) {
    showMsg(e.message || String(e));
  }
});

loadInfo();
