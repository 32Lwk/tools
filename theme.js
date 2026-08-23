(function () {
  var KEY = "tools-theme";
  var ORDER = ["auto", "light", "dark"];
  var LABELS = { auto: "自動", light: "ライト", dark: "ダーク" };

  function stored() {
    try {
      return localStorage.getItem(KEY) || "auto";
    } catch (e) {
      return "auto";
    }
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
    } catch (e) {}
    var btn = document.getElementById("theme-toggle");
    if (btn) {
      btn.textContent = "表示: " + LABELS[mode];
      btn.setAttribute("aria-label", "カラーテーマを切り替え（現在: " + LABELS[mode] + "）");
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
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
