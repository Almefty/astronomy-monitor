// Apply a saved light/dark choice before first paint (avoids a theme flash).
try {
  var t = JSON.parse(localStorage.getItem("astronomy-monitor:v1:theme") || "null");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch (e) {}
