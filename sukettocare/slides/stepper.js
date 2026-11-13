// 発表スライドの段階表示。window.STEPS[n] = [[cue, 遅れ(ms)], ...]（cue は data-cue の番号か関数）
(function () {
  const st = document.createElement('style');
  st.textContent = '.noanim, .noanim * { transition: none !important; animation: none !important; }';
  document.head.appendChild(st);
  let cur = -1;
  function apply(c) {
    if (typeof c === 'function') return c();
    document.querySelectorAll('[data-cue="' + c + '"]').forEach((e) => e.classList.add('on'));
  }
  function to(n, instant) {
    if (instant) document.documentElement.classList.add('noanim');
    for (let s = cur + 1; s <= n; s++) (window.STEPS[s] || []).forEach(([c, d]) => instant ? apply(c) : setTimeout(() => apply(c), d || 0));
    cur = n;
    if (instant) requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.remove('noanim')));
  }
  addEventListener('message', (e) => {
    const m = e.data || {}; if (m.type !== 'step') return;
    if (m.n < cur) location.replace(location.pathname + '?step=' + m.n);
    else if (m.n > cur) to(m.n, false);
  });
  const q = new URLSearchParams(location.search).get('step');
  addEventListener('load', () => to(q === null ? 0 : +q, q !== null));
})();
