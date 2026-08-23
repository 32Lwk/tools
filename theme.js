(function () {
  var KEY = "tools-theme-v2";
  var ORDER = ["auto", "light", "dark"];
  var LABELS = {
    auto: "システム",
    light: "ライト",
    dark: "ダーク",
  };

  function stored() {
    try {
      return localStorage.getItem(KEY) || "auto";
    } catch (e) {
      return "auto";
    }
  }

  function systemDark() {
    return (
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
    );
  }

  function apply(mode) {
    var root = document.documentElement;
    if (mode === "light" || mode === "dark") {
      root.setAttribute("data-theme", mode);
    } else {
      root.removeAttribute("data-theme");
      mode = "auto";
    }
    try {
      localStorage.setItem(KEY, mode);
      // drop legacy key so old forced light/dark does not linger
      localStorage.removeItem("tools-theme");
    } catch (e) {}

    var btn = document.getElementById("theme-toggle");
    if (btn) {
      var shown = LABELS[mode];
      if (mode === "auto") {
        shown += systemDark() ? "（ダーク）" : "（ライト）";
      }
      btn.textContent = "表示: " + shown;
      btn.setAttribute(
        "aria-label",
        "カラーテーマを切り替え（現在: " + shown + "）"
      );
    }
  }

  function next(mode) {
    var i = ORDER.indexOf(mode);
    return ORDER[(i + 1) % ORDER.length];
  }

  function init() {
    apply(stored());
    if (document.getElementById("theme-toggle")) return;

    var btn = document.createElement("button");
    btn.type = "button";
    btn.id = "theme-toggle";
    btn.className = "theme-toggle";
    btn.addEventListener("click", function () {
      apply(next(stored()));
    });
    document.body.appendChild(btn);
    apply(stored());

    if (window.matchMedia) {
      var mq = window.matchMedia("(prefers-color-scheme: dark)");
      var onChange = function () {
        if (stored() === "auto") apply("auto");
      };
      if (mq.addEventListener) mq.addEventListener("change", onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
