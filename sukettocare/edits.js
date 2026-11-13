// 発表者画面で編集した原稿を、このブラウザ（localStorage）に保存して読み込む。目安の秒数も計算し直す。
(function () {
  const KEY = 'sukettocare-script-v1';
  const ORIG = JSON.parse(JSON.stringify(window.DECK));
  function load() { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; } }
  function store(o) { try { localStorage.setItem(KEY, JSON.stringify(o)); return true; } catch (e) { return false; } }
  // make_data.py と同じ計算（約 320 字/分）
  function recompute(D) {
    const K = 0.9516; let cum = 0;
    D.forEach((s) => {
      if (s.backup) { s.target = 0; s.cumEnd = Math.round(cum * 10) / 10; s.lineStart = s.lines.map(() => 0); return; }
      const n = s.lines.reduce((a, l) => a + l.length, 0) || 1;
      s.target = Math.round((n / 5.6 + 0.3 * s.lines.length + 0.5) * K * 10) / 10;
      let acc = 0; s.lineStart = s.lines.map((l) => { const t = Math.round(acc / n * s.target * 10) / 10; acc += l.length; return t; });
      cum += s.target; s.cumEnd = Math.round(cum * 10) / 10;
    });
  }
  function apply() {
    const o = load();
    window.DECK.forEach((s, k) => {
      const orig = ORIG[k].lines, ed = o[s.id];
      s.lines = orig.map((l, j) => (ed && typeof ed[j] === 'string' && ed[j].trim()) ? ed[j] : l);
    });
    recompute(window.DECK);
  }
  window.ScriptEdits = {
    apply,
    edited: () => Object.keys(load()).length > 0,
    setLine(id, j, text) {
      const o = load(), s = ORIG.find((x) => x.id === id); if (!s) return;
      const arr = o[id] || s.lines.slice(); arr[j] = text;
      if (arr.every((l, k) => l === s.lines[k])) delete o[id]; else o[id] = arr;
      store(o); apply();
    },
    reset() { try { localStorage.removeItem(KEY); } catch (e) {} apply(); },
    exportJson() {
      const out = { saved: new Date().toISOString(), slides: window.DECK.filter((s) => !s.backup).map((s) => ({ id: s.id, title: s.title, lines: s.lines })) };
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' }));
      a.download = '助っ人ケア_原稿_' + new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '') + '.json';
      document.body.appendChild(a); a.click(); a.remove();
    },
    total: () => { const m = window.DECK.filter((s) => !s.backup); return m.length ? m[m.length - 1].cumEnd : 0; },
    chars: () => window.DECK.filter((s) => !s.backup).reduce((a, s) => a + s.lines.join('').length, 0),
  };
  apply();
  addEventListener('storage', (e) => { if (e.key === KEY) { apply(); if (window.onScriptEdited) window.onScriptEdited(); } });
})();
