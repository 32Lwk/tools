(function (global) {
  var PASS_HASH = "a73060afb61efe1b7c817645d00c342df02407f65435a64c88d251d56150ff42";
  var KEY = "tools_auth_v1";
  var LEGACY = "supporterz_auth_v1";

  function sha256(s) {
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)).then(function (buf) {
      return Array.from(new Uint8Array(buf))
        .map(function (b) {
          return b.toString(16).padStart(2, "0");
        })
        .join("");
    });
  }

  function isAuthed() {
    try {
      return sessionStorage.getItem(KEY) === "1" || sessionStorage.getItem(LEGACY) === "1";
    } catch (e) {
      return false;
    }
  }

  function setAuthed() {
    try {
      sessionStorage.setItem(KEY, "1");
      sessionStorage.setItem(LEGACY, "1");
    } catch (e) {}
  }

  global.ToolsGate = {
    PASS_HASH: PASS_HASH,
    sha256: sha256,
    isAuthed: isAuthed,
    setAuthed: setAuthed,
  };
})(window);
