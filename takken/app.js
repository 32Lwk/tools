(() => {
  const STORAGE_KEY = "takken-mark-v1";
  const selectEl = document.getElementById("exam-select");
  const sheetEl = document.getElementById("sheet");
  const linksEl = document.getElementById("exam-links");
  const scoreboard = document.getElementById("scoreboard");
  const scoreSummary = document.getElementById("score-summary");
  const scoreDetail = document.getElementById("score-detail");
  const timerEl = document.getElementById("timer");
  const btnTimer = document.getElementById("btn-timer");
  const btnClear = document.getElementById("btn-clear");
  const btnGrade = document.getElementById("btn-grade");
  const btnReveal = document.getElementById("btn-reveal");

  let data = null;
  let exam = null;
  let reveal = false;
  let timerId = null;
  let timerEndsAt = 0;

  function loadState() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    } catch {
      return {};
    }
  }
  function saveState(patch) {
    const cur = loadState();
    Object.assign(cur, patch);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cur));
  }

  function currentAnswers() {
    const out = Array(50).fill("");
    for (let i = 0; i < 50; i++) {
      const checked = sheetEl.querySelector(`input[name="q${i + 1}"]:checked`);
      out[i] = checked ? checked.value : "";
    }
    return out;
  }

  function persistAnswers() {
    if (!exam) return;
    const st = loadState();
    st.examId = exam.id;
    st.answers = st.answers || {};
    st.answers[exam.id] = currentAnswers();
    saveState(st);
  }

  function isVoid(ans) {
    return ans === "void" || ans === "all" || ans === "X" || ans === "A";
  }

  function matches(user, correct) {
    if (isVoid(correct)) return user !== "" ? "void-ok" : "void";
    if (correct === "3|4" || correct === "3&4") {
      return user === "3" || user === "4";
    }
    return String(user) === String(correct);
  }

  function renderLinks() {
    if (!exam) return;
    linksEl.innerHTML = `
      <a class="btn primary" href="${exam.jobsView}" target="_blank" rel="noopener">jobs で PDF を開く</a>
      <a class="btn" href="${exam.jobsDownload}" target="_blank" rel="noopener">PDF ダウンロード</a>
      <a class="btn" href="${exam.official}" target="_blank" rel="noopener">公式 PDF</a>
      <a class="btn" href="${exam.explain}" target="_blank" rel="noopener">解説（e-takken）</a>
    `;
  }

  function renderSheet(saved) {
    const answers = exam.answers || [];
    const html = [];
    for (let i = 0; i < 50; i++) {
      const correct = answers[i];
      const voidQ = isVoid(correct) || correct === "3|4";
      const user = saved?.[i] || "";
      const choices = [1, 2, 3, 4].map((n) => {
        const id = `q${i + 1}-${n}`;
        const checked = String(user) === String(n) ? " checked" : "";
        return `<label for="${id}"><input type="radio" name="q${i + 1}" id="${id}" value="${n}"${checked}>${n}</label>`;
      }).join("");
      let ansHint = "";
      if (reveal) {
        if (correct === "void") ansHint = "正解: 問題不成立";
        else if (correct === "all") ansHint = "正解: 没問（全員正解）";
        else if (correct === "3|4") ansHint = "正解: 3 または 4";
        else ansHint = `正解: ${correct}`;
      }
      html.push(`
        <div class="q${voidQ ? " void" : ""}" data-q="${i + 1}">
          <div class="q-label"><span>問 ${i + 1}</span></div>
          <div class="choices">${choices}</div>
          <div class="q-ans">${ansHint}</div>
        </div>
      `);
    }
    sheetEl.innerHTML = html.join("");
    sheetEl.querySelectorAll("input[type=radio]").forEach((el) => {
      el.addEventListener("change", () => {
        persistAnswers();
        scoreboard.hidden = true;
        clearMarks();
      });
    });
  }

  function clearMarks() {
    sheetEl.querySelectorAll(".q").forEach((q) => q.classList.remove("ok", "bad"));
  }

  function grade(showAnswers) {
    if (!exam) return;
    reveal = !!showAnswers;
    const user = currentAnswers();
    const correct = exam.answers;
    let ok = 0;
    let ng = 0;
    let blank = 0;
    let voidCount = 0;
    const pills = [];

    sheetEl.querySelectorAll(".q").forEach((qEl, i) => {
      const c = correct[i];
      const u = user[i];
      const ansEl = qEl.querySelector(".q-ans");
      qEl.classList.remove("ok", "bad");

      if (isVoid(c)) {
        voidCount++;
        qEl.classList.add("ok");
        if (reveal) {
          ansEl.textContent = c === "all" ? "正解: 没問（全員正解）" : "正解: 問題不成立";
        }
        pills.push(`<span class="pill ok">問${i + 1} 対象外</span>`);
        return;
      }
      if (c === "3|4") {
        const good = u === "3" || u === "4";
        if (!u) blank++;
        else if (good) ok++;
        else ng++;
        qEl.classList.add(good ? "ok" : u ? "bad" : "");
        if (reveal) ansEl.textContent = `正解: 3 または 4${u ? ` / あなたの解答: ${u}` : ""}`;
        pills.push(`<span class="pill ${good ? "ok" : "bad"}">問${i + 1}${good ? " ○" : " ×"}</span>`);
        return;
      }

      if (!u) {
        blank++;
        if (reveal) ansEl.textContent = `正解: ${c} / 未解答`;
        pills.push(`<span class="pill">問${i + 1} —</span>`);
        return;
      }
      const good = matches(u, c) === true;
      if (good) {
        ok++;
        qEl.classList.add("ok");
      } else {
        ng++;
        qEl.classList.add("bad");
      }
      if (reveal) ansEl.textContent = `正解: ${c} / あなたの解答: ${u}`;
      pills.push(`<span class="pill ${good ? "ok" : "bad"}">問${i + 1}${good ? " ○" : " ×"}</span>`);
    });

    const scored = 50 - voidCount;
    const pct = scored ? Math.round((ok / scored) * 100) : 0;
    scoreboard.hidden = false;
    scoreSummary.textContent = `結果: ${ok} / ${scored}（${pct}%） · 不正解 ${ng} · 未解答 ${blank}` +
      (voidCount ? ` · 採点対象外 ${voidCount}` : "");
    scoreDetail.innerHTML = pills.join("");
  }

  function formatRemain(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return [h, m, sec].map((n) => String(n).padStart(2, "0")).join(":");
  }

  function tickTimer() {
    const left = timerEndsAt - Date.now();
    timerEl.textContent = formatRemain(left);
    if (left <= 0) {
      clearInterval(timerId);
      timerId = null;
      btnTimer.textContent = "時間終了 — 再スタート";
      timerEl.textContent = "00:00:00";
    }
  }

  function selectExam(id) {
    exam = data.exams.find((e) => e.id === id) || data.exams[0];
    selectEl.value = exam.id;
    reveal = false;
    scoreboard.hidden = true;
    const saved = loadState().answers?.[exam.id] || Array(50).fill("");
    renderLinks();
    renderSheet(saved);
    saveState({ examId: exam.id });
  }

  selectEl.addEventListener("change", () => selectExam(selectEl.value));
  btnClear.addEventListener("click", () => {
    if (!exam) return;
    if (!confirm("この年度の解答をクリアしますか？")) return;
    const st = loadState();
    st.answers = st.answers || {};
    st.answers[exam.id] = Array(50).fill("");
    saveState(st);
    reveal = false;
    scoreboard.hidden = true;
    renderSheet(st.answers[exam.id]);
  });
  btnGrade.addEventListener("click", () => {
    persistAnswers();
    grade(false);
  });
  btnReveal.addEventListener("click", () => {
    persistAnswers();
    grade(true);
  });
  btnTimer.addEventListener("click", () => {
    if (timerId) {
      clearInterval(timerId);
      timerId = null;
      btnTimer.textContent = "120分タイマー開始";
      timerEl.textContent = "02:00:00";
      return;
    }
    timerEndsAt = Date.now() + 120 * 60 * 1000;
    btnTimer.textContent = "タイマー停止";
    tickTimer();
    timerId = setInterval(tickTimer, 250);
  });

  fetch("./data.json")
    .then((r) => r.json())
    .then((json) => {
      data = json;
      selectEl.innerHTML = data.exams.map((e) =>
        `<option value="${e.id}">${e.label}</option>`
      ).join("");
      const prefer = loadState().examId;
      selectExam(prefer && data.exams.some((e) => e.id === prefer) ? prefer : data.exams[0].id);
    })
    .catch((err) => {
      sheetEl.innerHTML = `<p style="color:var(--error-fg)">data.json の読込に失敗しました: ${err}</p>`;
    });
})();
