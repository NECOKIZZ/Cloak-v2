// Sets the theme before first paint (kept as a file so the CSP needs no inline scripts).
try {
  var t = localStorage.getItem("cloak.theme") || "auto";
  var d = t === "dark" || (t === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = d ? "dark" : "light";
} catch (e) { document.documentElement.dataset.theme = "light"; }
