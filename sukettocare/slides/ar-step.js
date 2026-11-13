// 15枚目の段階表示: 原稿の1文ごとに、その文で話すサービスと、その層を強調する。最後の段で全体とまとめ。
(function () {
  const STEPS = [
    ['armor', 'alb', 'run', 'hosting'],     // WAF、ALB、Cloud Run で動かし、Firebase Hosting で配信
    ['run'],                               // Cloud Run 上の最適化ソルバー
    ['gemini', 'sdp'],                     // Gemini（Vertex AI）、Sensitive Data Protection
    ['pubsub', 'bq', 'pipe'],              // Pub/Sub → BigQuery → 学習
    'all',                                 // AI は提案。正しさはソルバー。決めるのは、人。
  ];
  function step(n) {
    const s = STEPS[Math.max(0, Math.min(STEPS.length - 1, n))];
    const all = s === 'all';
    document.body.classList.toggle('st', !all); document.body.classList.toggle('all', all);
    document.querySelectorAll('.svc').forEach((e) => e.classList.toggle('hi', !all && s.includes(e.dataset.s)));
    document.querySelectorAll('.layer').forEach((L) => {
      const ids = (L.dataset.has || '').split(' ');
      L.classList.toggle('hi', !all && ids.some((x) => s.includes(x)));
    });
    const m = document.querySelector('.msg'); if (m) m.classList.toggle('on', all);
  }
  addEventListener('message', (e) => { const m = e.data || {}; if (m.type === 'step') step(m.n); });
  const q = new URLSearchParams(location.search).get('step');
  step(q === null ? 0 : +q);
})();
