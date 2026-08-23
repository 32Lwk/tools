(function () {
  try {
    // v2: default is system preference; ignore older forced values unless explicit
    var t = localStorage.getItem("tools-theme-v2");
    if (t === "light" || t === "dark") {
      document.documentElement.setAttribute("data-theme", t);
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  } catch (e) {}
})();
