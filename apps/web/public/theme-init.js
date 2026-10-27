(function () {
  try {
    var stored = localStorage.getItem("opspilot.theme");
    document.documentElement.dataset.theme =
      stored === "light" || stored === "dark"
        ? stored
        : window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
  } catch (error) {
    document.documentElement.dataset.theme = "light";
  }
})();
