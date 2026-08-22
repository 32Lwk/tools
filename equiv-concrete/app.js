/**
 * 高エネルギー宇宙線中性子の平均自由行程・等価コンクリート換算
 *
 * 教材混合則:
 *   σ ≈ 45 · A^{0.7}  [mb]
 *   Λ_i = 37 · A^{0.3}  [g/cm²]
 *   1/Λ = Σ w_i / Λ_i
 *   λ = Λ / ρ  [cm]
 *   t_eq = (X_c/Λ_c + τ_soil) · Λ_c / ρ_c
 */

const ELEMENTS = {
  H: 1.008,
  C: 12.011,
  O: 15.999,
  Na: 22.99,
  Mg: 24.305,
  Al: 26.982,
  Si: 28.085,
  K: 39.098,
  Ca: 40.078,
  Ti: 47.867,
  Fe: 55.845,
  Pb: 207.2,
};

const ELEMENT_ORDER = Object.keys(ELEMENTS);

function elementalLambda(sym) {
  return 37.0 * ELEMENTS[sym] ** 0.3;
}

function elementalSigma(sym) {
  return 45.0 * ELEMENTS[sym] ** 0.7;
}

function mixLambda(weights) {
  let total = 0;
  for (const w of Object.values(weights)) total += Math.max(w, 0);
  if (total <= 0) throw new Error("質量分率の合計が 0");
  let inv = 0;
  for (const [sym, w] of Object.entries(weights)) {
    if (w <= 0) continue;
    inv += w / total / elementalLambda(sym);
  }
  return 1 / inv;
}

/** プリセット組成（質量分率・正規化前でも可） */
const PRESETS = {
  slide: {
    label: "教材スライド（O53/Si34/Ca4/Al3/H1）",
    rho: 2.3,
    weights: { O: 0.53, Si: 0.34, Ca: 0.04, Al: 0.03, H: 0.01 },
  },
  kek: {
    label: "KEK 標準（教材組成・ρ=2.35）",
    rho: 2.35,
    weights: { O: 0.53, Si: 0.34, Ca: 0.04, Al: 0.03, H: 0.01 },
  },
  nist: {
    label: "NIST Ordinary Concrete",
    rho: 2.3,
    weights: {
      H: 0.0221,
      C: 0.0025,
      O: 0.5749,
      Na: 0.0152,
      Mg: 0.0013,
      Al: 0.02,
      Si: 0.3046,
      K: 0.01,
      Ca: 0.0429,
      Fe: 0.0064,
    },
  },
};

const SOIL_COMP = {
  kanto_loam: {
    O: 0.52,
    Si: 0.22,
    Al: 0.12,
    Fe: 0.07,
    H: 0.014,
    Ca: 0.008,
    Mg: 0.01,
    Na: 0.006,
    K: 0.007,
    Ti: 0.006,
  },
  soil_slide: { O: 0.5, Si: 0.27, Al: 0.07, Fe: 0.04, H: 0.02 },
  concrete_slide: { O: 0.53, Si: 0.34, Ca: 0.04, Al: 0.03, H: 0.01 },
};

function material(name, rho, composition, note = "") {
  const lambdaG = mixLambda(composition);
  return {
    name,
    rho,
    composition,
    note,
    lambdaGcm2: lambdaG,
    lambdaCm: lambdaG / rho,
  };
}

const MATERIALS = {
  loam: material("関東ローム", 1.35, SOIL_COMP.kanto_loam, "火山灰質・筑波台地表層"),
  joso: material("常総粘土", 1.65, SOIL_COMP.kanto_loam, "凝灰質粘土"),
  shimosa: material("下総層群（砂）", 1.85, SOIL_COMP.soil_slide, "更新世砂層"),
  fill: material("埋土", 1.55, SOIL_COMP.soil_slide, "造成地浅部"),
  pavement: material("舗装", 2.2, SOIL_COMP.concrete_slide, "AS+砕石"),
};

/**
 * 土層プロファイル
 * - tsukuba: 筑波台地の自然地盤（J-Stage 火山灰質土の傾向 + 地質層序）
 * - asahi: 国総研 KuniJiban・つくば市旭 B1 ボーリング
 * - textbook: 教材の単純2層
 */
const PROFILES = {
  tsukuba: {
    id: "tsukuba",
    label: "筑波台地・自然地盤（推奨）",
    note:
      "表層〜中部は関東ローム、その下に常総粘土相当、以深は下総層群。KEK 大穂キャンパス向き。",
    sources: [
      {
        text: "地質調査所月報 52巻8号（寺島ほか, 2001）— 関東の土壌組成傾向",
        href: "https://www.jstage.jst.go.jp/article/bullgsj/52/8/52_347/_pdf/-char/ja",
      },
      {
        text: "KuniJiban（国総研）— 筑波台地の層序・密度の参照",
        href: "https://www.kunijiban.pwri.go.jp/viewer/",
      },
    ],
    layers: [
      { name: "関東ローム", thickness_m: 3.5, mat: "loam" },
      { name: "常総粘土", thickness_m: 2.0, mat: "joso" },
      { name: "下総層群", thickness_m: 1e9, mat: "shimosa" },
    ],
  },
  asahi: {
    id: "asahi",
    label: "つくば市旭 B1（KuniJiban）",
    note:
      "国総研ボーリング: 舗装〜埋土が厚い造成地モデル。自然地盤の KEK 敷地には過大評価になり得る。",
    sources: [
      {
        text: "KuniJiban ビューア（つくば市旭など）",
        href: "https://www.kunijiban.pwri.go.jp/viewer/",
      },
    ],
    layers: [
      { name: "舗装・砕石", thickness_m: 0.35, mat: "pavement" },
      { name: "埋土", thickness_m: 5.2, mat: "fill" },
      { name: "凝灰質粘土（常総相当）", thickness_m: 2.15, mat: "joso" },
      { name: "下総層群", thickness_m: 1e9, mat: "shimosa" },
    ],
  },
  textbook: {
    id: "textbook",
    label: "教材（ローム≤4 m / 以深は常総）",
    note: "夏の学校教材の単純2層モデル。",
    sources: [],
    layers: [
      { name: "関東ローム", thickness_m: 4.0, mat: "loam" },
      { name: "常総粘土", thickness_m: 1e9, mat: "joso" },
    ],
  },
};

function soilMassThickness(profileId, depth_m) {
  if (depth_m <= 0) return 0;
  const layers = PROFILES[profileId].layers;
  let x = 0;
  let rem = depth_m;
  for (const layer of layers) {
    const take = Math.min(rem, layer.thickness_m);
    if (take <= 0) break;
    x += MATERIALS[layer.mat].rho * take * 100;
    rem -= take;
  }
  if (rem > 0) {
    const last = layers[layers.length - 1];
    x += MATERIALS[last.mat].rho * rem * 100;
  }
  return x;
}

function soilOpticalDepth(profileId, depth_m) {
  if (depth_m <= 0) return 0;
  const layers = PROFILES[profileId].layers;
  let tau = 0;
  let rem = depth_m;
  for (const layer of layers) {
    const take = Math.min(rem, layer.thickness_m);
    if (take <= 0) break;
    const mat = MATERIALS[layer.mat];
    tau += (mat.rho * take * 100) / mat.lambdaGcm2;
    rem -= take;
  }
  if (rem > 0) {
    const last = layers[layers.length - 1];
    const mat = MATERIALS[last.mat];
    tau += (mat.rho * rem * 100) / mat.lambdaGcm2;
  }
  return tau;
}

function equivConcrete({ concreteCm, soilCm, profileId, rhoC, lambdaC_gcm2 }) {
  const soil_m = Math.max(soilCm, 0) / 100;
  const xC = Math.max(concreteCm, 0) * rhoC;
  const xS = soilMassThickness(profileId, soil_m);
  const tau = xC / lambdaC_gcm2 + soilOpticalDepth(profileId, soil_m);
  const tEq = (tau * lambdaC_gcm2) / rhoC;
  const tEqDens = (xC + xS) / rhoC;
  return {
    xC,
    xS,
    xTotal: xC + xS,
    tau,
    tEqCm: tEq,
    tEqM: tEq / 100,
    tEqDensCm: tEqDens,
    attenuation: Math.exp(-tau),
    lambdaCm: lambdaC_gcm2 / rhoC,
  };
}

function normalizeWeights(weights) {
  const out = {};
  let total = 0;
  for (const [k, v] of Object.entries(weights)) {
    const n = Number(v) || 0;
    if (n > 0) {
      out[k] = n;
      total += n;
    }
  }
  if (total <= 0) return {};
  for (const k of Object.keys(out)) out[k] /= total;
  return out;
}

function fmt(n, digits = 2) {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("ja-JP", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtSci(n) {
  if (!Number.isFinite(n)) return "—";
  return n.toExponential(4);
}

/* ---------------- UI ---------------- */

function $(id) {
  return document.getElementById(id);
}

function readCompositionFromForm() {
  const weights = {};
  for (const sym of ELEMENT_ORDER) {
    const el = $(`w-${sym}`);
    if (!el) continue;
    const v = parseFloat(el.value);
    if (v > 0) weights[sym] = v;
  }
  return weights;
}

function writeCompositionToForm(weights) {
  for (const sym of ELEMENT_ORDER) {
    const el = $(`w-${sym}`);
    if (!el) continue;
    el.value = weights[sym] != null ? String(weights[sym]) : "";
  }
}

function applyPreset(key) {
  const p = PRESETS[key];
  if (!p) return;
  writeCompositionToForm(p.weights);
  $("rho").value = String(p.rho);
  $("preset").value = key;
  recalculate();
}

function renderElementRows() {
  const tbody = $("comp-body");
  tbody.innerHTML = "";
  for (const sym of ELEMENT_ORDER) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><label for="w-${sym}">${sym}</label></td>
      <td class="num">${ELEMENTS[sym].toFixed(3)}</td>
      <td class="num">${fmt(elementalSigma(sym), 1)}</td>
      <td class="num">${fmt(elementalLambda(sym), 1)}</td>
      <td><input id="w-${sym}" type="number" min="0" step="any" inputmode="decimal" placeholder="0"></td>
      <td class="num muted" id="pct-${sym}">—</td>
      <td class="num muted" id="contrib-${sym}">—</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderProfileOptions() {
  const sel = $("profile");
  sel.innerHTML = "";
  for (const [id, p] of Object.entries(PROFILES)) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = p.label;
    if (id === "tsukuba") opt.selected = true;
    sel.appendChild(opt);
  }
}

function renderProfileMeta() {
  const p = PROFILES[$("profile").value];
  $("profile-note").textContent = p.note;
  const ul = $("profile-layers");
  ul.innerHTML = "";
  for (const layer of p.layers) {
    const mat = MATERIALS[layer.mat];
    const li = document.createElement("li");
    const thick =
      layer.thickness_m > 1e6 ? "（以深）" : `${layer.thickness_m.toFixed(2)} m`;
    li.textContent = `${layer.name} ${thick} — ρ=${mat.rho} g/cm³, Λ=${fmt(mat.lambdaGcm2, 1)} g/cm²`;
    ul.appendChild(li);
  }
  const src = $("profile-sources");
  src.innerHTML = "";
  for (const s of p.sources) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = s.href;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = s.text;
    li.appendChild(a);
    src.appendChild(li);
  }
}

function recalculate() {
  const raw = readCompositionFromForm();
  const norm = normalizeWeights(raw);
  const rho = parseFloat($("rho").value) || 0;
  const concreteCm = parseFloat($("concrete-cm").value) || 0;
  const soilCm = parseFloat($("soil-cm").value) || 0;
  const profileId = $("profile").value;

  const err = $("error");
  err.hidden = true;

  try {
    if (Object.keys(norm).length === 0) throw new Error("組成を入力してください");
    if (rho <= 0) throw new Error("密度 ρ は正の値にしてください");

    const lambdaG = mixLambda(norm);
    const lambdaCm = lambdaG / rho;

    // 元素寄与の表示
    let totalRaw = 0;
    for (const v of Object.values(raw)) totalRaw += Math.max(Number(v) || 0, 0);
    for (const sym of ELEMENT_ORDER) {
      const pctEl = $(`pct-${sym}`);
      const contribEl = $(`contrib-${sym}`);
      const w = norm[sym] || 0;
      if (w > 0) {
        pctEl.textContent = `${(w * 100).toFixed(1)}%`;
        contribEl.textContent = fmt(w / elementalLambda(sym), 5);
      } else {
        pctEl.textContent = "—";
        contribEl.textContent = "—";
      }
    }
    $("sum-raw").textContent = totalRaw > 0 ? fmt(totalRaw, 3) : "—";

    $("out-lambda-g").textContent = fmt(lambdaG, 2);
    $("out-lambda-cm").textContent = fmt(lambdaCm, 2);
    $("out-lambda-m").textContent = fmt(lambdaCm / 100, 4);

    const r = equivConcrete({
      concreteCm,
      soilCm,
      profileId,
      rhoC: rho,
      lambdaC_gcm2: lambdaG,
    });

    $("out-xc").textContent = fmt(r.xC, 2);
    $("out-xs").textContent = fmt(r.xS, 2);
    $("out-tau").textContent = fmt(r.tau, 4);
    $("out-teq").textContent = fmt(r.tEqCm, 1);
    $("out-teq-m").textContent = fmt(r.tEqM, 3);
    $("out-teq-dens").textContent = fmt(r.tEqDensCm, 1);
    $("out-att").textContent = fmtSci(r.attenuation);

    renderDepthTable(profileId, rho, lambdaG, concreteCm);
    drawChart(profileId, rho, lambdaG, concreteCm, soilCm);
  } catch (e) {
    err.hidden = false;
    err.textContent = e.message || String(e);
  }
}

function renderDepthTable(profileId, rho, lambdaG, concreteCm) {
  const tbody = $("depth-body");
  tbody.innerHTML = "";
  const depths = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 10];
  for (const d of depths) {
    const r = equivConcrete({
      concreteCm,
      soilCm: d * 100,
      profileId,
      rhoC: rho,
      lambdaC_gcm2: lambdaG,
    });
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="num">${d.toFixed(1)}</td>
      <td class="num">${fmt(r.xS, 1)}</td>
      <td class="num">${fmt(r.tEqCm, 1)}</td>
      <td class="num">${fmt(r.tEqM, 3)}</td>
      <td class="num">${fmtSci(r.attenuation)}</td>
    `;
    tbody.appendChild(tr);
  }
}

function drawChart(profileId, rho, lambdaG, concreteCm, soilCm) {
  const canvas = $("chart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 640;
  const cssH = 280;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const fg = dark ? "#ddd" : "#222";
  const grid = dark ? "#444" : "#ddd";
  const line = dark ? "#6cb6ff" : "#0969da";
  const mark = dark ? "#f0883e" : "#cf222e";

  ctx.clearRect(0, 0, cssW, cssH);
  const pad = { l: 52, r: 16, t: 16, b: 40 };
  const plotW = cssW - pad.l - pad.r;
  const plotH = cssH - pad.t - pad.b;

  const zMax = 10;
  const pts = [];
  for (let i = 0; i <= 100; i++) {
    const z = (zMax * i) / 100;
    const r = equivConcrete({
      concreteCm,
      soilCm: z * 100,
      profileId,
      rhoC: rho,
      lambdaC_gcm2: lambdaG,
    });
    pts.push({ z, teq: r.tEqCm });
  }
  const yMax = Math.max(50, ...pts.map((p) => p.teq)) * 1.05;

  const xOf = (z) => pad.l + (z / zMax) * plotW;
  const yOf = (teq) => pad.t + plotH - (teq / yMax) * plotH;

  // axes
  ctx.strokeStyle = grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= 5; i++) {
    const y = pad.t + (plotH * i) / 5;
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l + plotW, y);
  }
  for (let z = 0; z <= zMax; z += 2) {
    const x = xOf(z);
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, pad.t + plotH);
  }
  ctx.stroke();

  ctx.strokeStyle = fg;
  ctx.beginPath();
  ctx.moveTo(pad.l, pad.t);
  ctx.lineTo(pad.l, pad.t + plotH);
  ctx.lineTo(pad.l + plotW, pad.t + plotH);
  ctx.stroke();

  ctx.fillStyle = fg;
  ctx.font = "12px system-ui, sans-serif";
  ctx.textAlign = "center";
  for (let z = 0; z <= zMax; z += 2) {
    ctx.fillText(String(z), xOf(z), cssH - 18);
  }
  ctx.fillText("土の深さ [m]", pad.l + plotW / 2, cssH - 4);
  ctx.save();
  ctx.translate(14, pad.t + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText("等価コンクリート [cm]", 0, 0);
  ctx.restore();

  ctx.strokeStyle = line;
  ctx.lineWidth = 2;
  ctx.beginPath();
  pts.forEach((p, i) => {
    const x = xOf(p.z);
    const y = yOf(p.teq);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // current point
  const cur = equivConcrete({
    concreteCm,
    soilCm,
    profileId,
    rhoC: rho,
    lambdaC_gcm2: lambdaG,
  });
  const zx = Math.min(zMax, Math.max(0, soilCm / 100));
  ctx.fillStyle = mark;
  ctx.beginPath();
  ctx.arc(xOf(zx), yOf(cur.tEqCm), 5, 0, Math.PI * 2);
  ctx.fill();
}

function init() {
  renderElementRows();
  renderProfileOptions();
  renderProfileMeta();

  $("preset").addEventListener("change", (e) => applyPreset(e.target.value));
  $("profile").addEventListener("change", () => {
    renderProfileMeta();
    recalculate();
  });
  for (const id of ["rho", "concrete-cm", "soil-cm"]) {
    $(id).addEventListener("input", recalculate);
  }
  $("comp-body").addEventListener("input", recalculate);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", recalculate);
  window.addEventListener("resize", () => recalculate());

  applyPreset("slide");
  $("concrete-cm").value = "80";
  $("soil-cm").value = "670";
  recalculate();
}

document.addEventListener("DOMContentLoaded", init);
