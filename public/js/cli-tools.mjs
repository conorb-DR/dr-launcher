// DR CLI tools view. Pure view module: its install state is module-private
// (only this view uses it), and its data + side-effects are injected from the
// composition root (main.mjs) via a small `ctx`.
//
//   ctx = {
//     getHealth(): object|null,   // current health checks (live getter)
//     headers: object,            // fetch headers
//     showToast(msg, level?),     // toast helper
//     recheckHealth(): Promise,   // re-run the health probe + refresh state
//     goHome(): void,             // return to the default view
//   }
import { ICON } from "./icons.mjs";

// View-local install state (was top-level in main.mjs; only this view uses it).
let cliInstallES = null;
let cliInstallOutput = "";

export function renderCliTools(main, ctx) {
  const drFound = ctx.getHealth()?.dr?.found;
  const installing = !!cliInstallES;
  const versionHint = installing ? "Updating…" : (drFound ? "Checking version…" : "Not installed");
  main.innerHTML = `
    <div class="page-header">
      <div class="page-header__breadcrumb st-mono">tools / dr cli</div>
      <div class="page-header__title-row">
        <h1 class="page-header__title">DR CLI</h1>
        <span class="page-header__meta">Install, update, and manage the Datarails command-line interface</span>
      </div>
    </div>
    <div class="cli-tools-grid">
      <div class="settings-card cli-tools-card">
        <div class="cli-tools-card__head">
          <div>
            <div class="cli-tools-card__title">Install / Update</div>
            <div class="cli-tools-card__hint" id="cli-version-info">${versionHint}</div>
          </div>
          <button class="st-btn st-btn--primary" id="cli-install-btn"${installing ? " disabled" : ""}>
            ${installing ? "Installing…" : (drFound ? ICON.refresh + " Update DR CLI" : ICON.plus + " Install DR CLI")}
          </button>
        </div>
        <div id="cli-install-output" class="cli-output" style="display:${installing ? "block" : "none"}">${installing ? cliInstallOutput : ""}</div>
      </div>
      <div class="settings-card cli-tools-card">
        <div class="cli-tools-card__head">
          <div>
            <div class="cli-tools-card__title">CLI Reference</div>
            <div class="cli-tools-card__hint">Complete command documentation for the DR CLI</div>
          </div>
          <button class="st-btn st-btn--sm" id="cli-ref-open-btn">${ICON.externalLink} Open reference</button>
        </div>
      </div>
      <div class="settings-card cli-tools-card">
        <div class="cli-tools-card__head">
          <div>
            <div class="cli-tools-card__title">Install Guide</div>
            <div class="cli-tools-card__hint">Manual installation and platform-specific instructions</div>
          </div>
          <button class="st-btn st-btn--sm" id="cli-install-guide-btn">${ICON.externalLink} Open guide</button>
        </div>
      </div>
    </div>`;

  wireCliTools(main, ctx);

  // Skip the version check while installing — `dr --version` fails with the
  // package locked.
  if (!installing && drFound) {
    fetch("/api/cli/version", { headers: ctx.headers }).then((r) => r.json()).then((data) => {
      if (data.installing) return; // server-side install in progress
      const el = document.getElementById("cli-version-info");
      if (el && data.installed) el.textContent = "Installed: " + data.version;
      else if (el) { el.textContent = "Not installed"; el.style.color = "var(--st-state-failed-fg)"; }
    }).catch(() => {});
  }
}

function wireCliTools(main, ctx) {
  main.querySelector(".crumb-home")?.addEventListener("click", (e) => {
    e.preventDefault();
    ctx.goHome();
  });

  main.querySelector("#cli-install-guide-btn")?.addEventListener("click", () => {
    window.open("https://staticb73dae2b.blob.core.windows.net/static/cli/install.html", "_blank");
  });

  main.querySelector("#cli-ref-open-btn")?.addEventListener("click", () => {
    window.open("https://staticb73dae2b.blob.core.windows.net/static/cli/reference.html", "_blank");
  });

  main.querySelector("#cli-install-btn")?.addEventListener("click", () => {
    const installBtn = document.getElementById("cli-install-btn");
    const outputEl = document.getElementById("cli-install-output");
    if (!installBtn || !outputEl) return;

    installBtn.disabled = true;
    installBtn.textContent = "Installing…";
    outputEl.style.display = "block";
    outputEl.textContent = "";
    cliInstallOutput = "";

    if (cliInstallES) { try { cliInstallES.close(); } catch {} }
    let cliInstallDone = false;
    const es = new EventSource("/api/cli/install");
    cliInstallES = es;
    es.onmessage = (e) => {
      const out = document.getElementById("cli-install-output");
      const btn = document.getElementById("cli-install-btn");
      const ver = document.getElementById("cli-version-info");
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === "stdout" || msg.type === "stderr") {
        cliInstallOutput += msg.data;
        if (out) { out.textContent = cliInstallOutput; out.scrollTop = out.scrollHeight; }
      } else if (msg.type === "done") {
        cliInstallDone = true;
        cliInstallOutput += "\n✓ " + msg.data;
        if (out) out.textContent = cliInstallOutput;
        if (btn) { btn.innerHTML = ICON.refresh + " Update DR CLI"; btn.disabled = false; }
        es.close();
        if (cliInstallES === es) cliInstallES = null;
        ctx.showToast("DR CLI installed/updated successfully.");
        fetch("/api/cli/version", { headers: ctx.headers }).then((r) => r.json()).then((d) => {
          if (ver && d.installed) ver.textContent = "Installed: " + d.version;
        }).catch(() => {});
        ctx.recheckHealth();
      } else if (msg.type === "error") {
        cliInstallDone = true;
        cliInstallOutput += "\n✗ " + msg.data;
        if (out) out.textContent = cliInstallOutput;
        if (btn) { btn.textContent = "Retry"; btn.disabled = false; }
        es.close();
        if (cliInstallES === es) cliInstallES = null;
        ctx.showToast("DR CLI install failed.", "error");
        ctx.recheckHealth().then(() => {
          const verEl = document.getElementById("cli-version-info");
          if (verEl && ctx.getHealth()?.dr?.found) {
            fetch("/api/cli/version", { headers: ctx.headers }).then((r) => r.json()).then((d) => {
              if (d.installed) verEl.textContent = "Installed: " + d.version;
              else { verEl.textContent = "Not installed"; verEl.style.color = "var(--st-state-failed-fg)"; }
            }).catch(() => {});
          } else if (verEl) {
            verEl.textContent = "Not installed";
            verEl.style.color = "var(--st-state-failed-fg)";
          }
        });
      }
    };
    es.onerror = () => {
      if (cliInstallDone) return;
      setTimeout(() => {
        if (cliInstallDone) return;
        cliInstallDone = true;
        cliInstallOutput += "\nConnection to server lost. Check if the server is still running.";
        const out = document.getElementById("cli-install-output");
        const btn = document.getElementById("cli-install-btn");
        if (out) out.textContent = cliInstallOutput;
        if (btn) { btn.textContent = "Retry"; btn.disabled = false; }
        try { es.close(); } catch {}
        if (cliInstallES === es) cliInstallES = null;
      }, 500);
    };
  });
}
