// Pure, DOM-free helpers. Safe to import in Node (unit tests) and the browser.

// Escape for safe interpolation into HTML text AND attribute values. Pure
// string replacement (no DOM) so it is testable headless and so quotes are
// escaped — the DOM textContent approach left `"`/`'` unescaped, which is
// unsafe inside attributes like value="${esc(...)}".
export function esc(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
