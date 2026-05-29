// Diagnostics view. A pure view module: it owns its markup + wiring, but its
// data and side-effects are injected from the composition root (main.mjs) via a
// small `ctx` — so there's no circular import and no shared mutable state here.
//
//   ctx = {
//     buildHealthRows(): string,   // system-health rows HTML (from health state)
//     recheckHealth(): Promise,    // re-run the health probe + refresh state
//     showToast(msg, level?),      // toast helper
//     headers: object,             // fetch headers
//     goHome(): void,              // return to the default view
//   }
import { ICON } from "./icons.mjs";

export function renderDiagnostics(main, ctx) {
  main.innerHTML = `
    <div class="page-header">
      <div class="page-header__breadcrumb st-mono">tools / diagnostics</div>
      <div class="page-header__title-row">
        <h1 class="page-header__title">Diagnostics</h1>
        <span class="page-header__meta">System health and environment info</span>
      </div>
      <div class="page-header__actions">
        <button class="st-btn st-btn--ghost" id="diag-recheck">${ICON.refresh} Re-check</button>
        <button class="st-btn st-btn--primary" id="diag-copy">${ICON.copy} Copy support bundle</button>
      </div>
    </div>
    <div class="diag-grid">
      <div class="diag-card">
        <div class="diag-card__head"><span class="diag-card__title">System health</span></div>
        <div class="diag-card__body">${ctx.buildHealthRows()}</div>
      </div>
    </div>
  `;

  main.querySelector("#diag-recheck")?.addEventListener("click", async () => {
    await ctx.recheckHealth();
    renderDiagnostics(main, ctx);
    ctx.showToast("Health check complete.");
  });
  main.querySelector("#diag-copy")?.addEventListener("click", async () => {
    try {
      const res = await fetch("/api/diagnostics", { headers: ctx.headers });
      const data = await res.json();
      await navigator.clipboard.writeText(data.text || "No diagnostics available");
      ctx.showToast("Support bundle copied to clipboard.");
    } catch (err) {
      ctx.showToast("Failed to copy diagnostics: " + err.message, "error");
    }
  });
  main.querySelector(".crumb-home")?.addEventListener("click", (e) => {
    e.preventDefault();
    ctx.goHome();
  });
}
