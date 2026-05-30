// Settings modal. Pure view module: builds the modal + wires its controls, with
// all data + side-effects injected from the composition root (main.mjs). No
// shared mutable state lives here.
//
//   ctx = {
//     getSettings(): object,        // live userSettings
//     getSyncStatus(): object,      // live syncStatus
//     getVdAvailable(): bool|null,  // virtual-desktop availability
//     applyTheme(theme), saveSettings(patch): Promise, saveSettingsQuiet(patch),
//     fetchAccounts(force): Promise, render(), showToast(msg, level?),
//     triggerSync(): Promise, fetchSyncStatus(): Promise, recheckHealth(): Promise,
//     buildHealthRows(): string, headers: object, wireModalClose(overlay),
//   }
import { ICON } from "./icons.mjs";
import { esc } from "./util.mjs";
import { wireCleanup } from "./cleanup.mjs";

export function showSettingsModal(ctx) {
  const settings = ctx.getSettings();
  const sync = ctx.getSyncStatus();
  const vdOn = settings.useVirtualDesktops;
  const showAllOn = settings.showAllAccounts === true;
  const vdDisabled = ctx.getVdAvailable() === false;
  const currentTheme = document.documentElement.getAttribute("data-theme") || "warm";
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" style="width:520px">
      <div class="modal__head">
        <div>
          <h2>Settings</h2>
          <p>Preferences sync across your devices. Advanced launch settings stay on this machine.</p>
        </div>
        <button class="modal__close" aria-label="Close">${ICON.x}</button>
      </div>
      <div class="modal__body">
        <div class="settings-group">
          <div>
            <div class="settings-group__title">Appearance</div>
            <div class="settings-card">
              <div class="settings-row">
                <div class="settings-row__main">
                  <div class="settings-row__label">Theme</div>
                  <div class="settings-row__hint">Choose your preferred palette</div>
                </div>
                <div class="palette-picker">
                  ${["warm", "zinc", "dark", "cream"].map((t) => `
                    <button class="palette-swatch${t === currentTheme ? " is-active" : ""}" data-palette="${t}" title="${t}">
                      <span class="palette-swatch__stripe" style="background:${t === "warm" ? "#FAFAF9" : t === "zinc" ? "#F8FAFC" : t === "dark" ? "#16181D" : "#F4EEE0"}"></span>
                      <span class="palette-swatch__stripe" style="background:${t === "warm" ? "#0A0A0B" : t === "zinc" ? "#0F172A" : t === "dark" ? "#ECEEF4" : "#1A1714"}"></span>
                      <span class="palette-swatch__stripe" style="background:#4646CE"></span>
                    </button>
                  `).join("")}
                </div>
              </div>
            </div>
          </div>

          <div>
            <div class="settings-group__title">Launch behavior</div>
            <div class="settings-card">
              <div class="settings-row">
                <div class="settings-row__main">
                  <div class="settings-row__label">Virtual desktops <span class="beta-badge">Beta</span></div>
                  <div class="settings-row__hint">${vdDisabled
                    ? `Virtual desktop support is not available on this system.`
                    : `Each launch creates a separate Windows virtual desktop. Existing desktops are reused.`
                  }</div>
                </div>
                <button class="toggle ${vdOn ? "is-on" : ""} ${vdDisabled ? "is-disabled" : ""}" id="set-vd" ${vdDisabled ? "disabled" : ""}></button>
              </div>
              <div class="settings-row">
                <div class="settings-row__main">
                  <div class="settings-row__label">Show all accounts <span class="beta-badge">Advanced</span></div>
                  <div class="settings-row__hint">Reveal customer-user accounts, not just Datarails support accounts. Launching as a customer user runs with that user's permissions and audit identity — use only to reproduce a user-specific issue. Stays on this machine.</div>
                </div>
                <button class="toggle ${showAllOn ? "is-on" : ""}" id="set-show-all-accounts"></button>
              </div>
            </div>
          </div>

          <div>
            <div class="settings-group__title">System health</div>
            <div class="settings-card" id="settings-health-card">
              ${ctx.buildHealthRows()}
              <div style="padding:8px 16px 12px;text-align:right">
                <button class="st-btn st-btn--sm" id="settings-health-recheck">${ICON.refresh} Run health check</button>
              </div>
            </div>
          </div>

          <div>
            <div class="settings-group__title">Cloud sync</div>
            <div class="settings-card">
              <div class="settings-row">
                <div class="settings-row__main">
                  <div class="settings-row__hint" id="sync-status-text">${
                    sync.lastSyncedAt
                      ? `Last synced: ${new Date(sync.lastSyncedAt).toLocaleString()}${sync.dirty ? " (local changes pending)" : ""}`
                      : "Not yet synced"
                  }${sync.error ? ` — Error: ${esc(sync.error)}` : ""}</div>
                </div>
                <button class="st-btn st-btn--sm" id="settings-sync-btn">${ICON.refresh} Sync now</button>
              </div>
            </div>
          </div>

          <div>
            <div class="settings-group__title">Storage</div>
            <div class="settings-card">
              <div class="settings-row">
                <div class="settings-row__main">
                  <div class="settings-row__label">Cleanup unused data</div>
                  <div class="settings-row__hint">Scan for orphaned Chrome profiles and workspaces from old launches</div>
                </div>
                <button class="st-btn st-btn--sm" id="settings-cleanup-scan">Scan</button>
              </div>
              <div id="cleanup-results" style="display:none"></div>
            </div>
          </div>

          <div>
            <div class="settings-group__title">About</div>
            <div class="settings-card">
              <div class="settings-row">
                <div class="settings-row__main" style="font-size:12px;color:var(--st-ink-muted);line-height:1.6">
                  <div>DR Launcher — local-first customer launcher</div>
                  <div>Auth: HttpOnly session cookie (token not exposed to the page)</div>
                </div>
                <button class="st-btn st-btn--sm" id="settings-copy-diag">Copy diagnostics</button>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="modal__foot">
        <span></span>
        <button class="st-btn st-btn--primary" data-modal-close>Done</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  // Palette switching
  overlay.querySelectorAll("[data-palette]").forEach((btn) => {
    btn.addEventListener("click", () => {
      overlay.querySelectorAll(".palette-swatch").forEach((s) => s.classList.remove("is-active"));
      btn.classList.add("is-active");
      ctx.applyTheme(btn.dataset.palette);
      ctx.saveSettingsQuiet({ theme: btn.dataset.palette });
    });
  });

  const tog = overlay.querySelector("#set-vd");
  if (tog && !vdDisabled) {
    tog.addEventListener("click", () => {
      const on = !tog.classList.contains("is-on");
      tog.classList.toggle("is-on", on);
      ctx.saveSettings({ useVirtualDesktops: on });
      ctx.showToast(on ? "Virtual desktops enabled." : "Virtual desktops disabled.");
    });
  }
  const showAllTog = overlay.querySelector("#set-show-all-accounts");
  if (showAllTog) {
    showAllTog.addEventListener("click", async () => {
      const on = !showAllTog.classList.contains("is-on");
      showAllTog.classList.toggle("is-on", on);
      await ctx.saveSettings({ showAllAccounts: on });
      await ctx.fetchAccounts(true); // re-filter; fetchAccounts also prunes stale selections
      ctx.render();
      ctx.showToast(on ? "Showing all accounts (incl. customer users)." : "Showing support accounts only.");
    });
  }
  const syncBtn = overlay.querySelector("#settings-sync-btn");
  if (syncBtn) {
    syncBtn.addEventListener("click", async () => {
      syncBtn.disabled = true;
      syncBtn.textContent = "Syncing…";
      await ctx.triggerSync();
      await ctx.fetchSyncStatus();
      const s = ctx.getSyncStatus();
      const statusEl = overlay.querySelector("#sync-status-text");
      if (statusEl) {
        statusEl.textContent = s.lastSyncedAt
          ? `Last synced: ${new Date(s.lastSyncedAt).toLocaleString()}${s.dirty ? " (local changes pending)" : ""}`
          : "Not yet synced";
      }
      syncBtn.disabled = false;
      syncBtn.innerHTML = `${ICON.refresh} Sync now`;
    });
  }
  const diagBtn = overlay.querySelector("#settings-copy-diag");
  if (diagBtn) {
    diagBtn.addEventListener("click", async () => {
      diagBtn.disabled = true;
      diagBtn.textContent = "Copying…";
      try {
        const res = await fetch("/api/diagnostics", { headers: ctx.headers });
        const data = await res.json();
        await navigator.clipboard.writeText(data.text || "No diagnostics available");
        ctx.showToast("Diagnostics copied to clipboard.");
      } catch (err) {
        ctx.showToast("Failed to copy diagnostics: " + err.message, "error");
      }
      diagBtn.disabled = false;
      diagBtn.textContent = "Copy diagnostics";
    });
  }
  overlay.addEventListener("click", async (e) => {
    const recheckBtn = e.target.closest("#settings-health-recheck");
    if (recheckBtn) {
      recheckBtn.disabled = true;
      recheckBtn.textContent = "Checking…";
      await ctx.recheckHealth();
      const card = overlay.querySelector("#settings-health-card");
      if (card) {
        card.innerHTML = ctx.buildHealthRows()
          + `<div style="padding:8px 16px 12px;text-align:right"><button class="st-btn st-btn--sm" id="settings-health-recheck">${ICON.refresh} Run health check</button></div>`;
      }
      ctx.showToast("Health check complete.");
      return;
    }
    const installBtn = e.target.closest("#settings-cli-install");
    if (installBtn) {
      const statusEl = overlay.querySelector("#cli-install-status");
      if (statusEl) runCliInstall(statusEl, installBtn, ctx);
    }
  });
  wireCleanup(overlay, { headers: ctx.headers, showToast: ctx.showToast });
  ctx.wireModalClose(overlay);
}

// Inline "Install / Update DR CLI" action embedded in the System-health row
// (distinct from the richer cli-tools view flow). Streams /api/cli/install into
// the row's status span.
function runCliInstall(statusEl, btn, ctx) {
  btn.disabled = true;
  btn.textContent = "Installing…";
  statusEl.textContent = "Starting…";
  statusEl.style.color = "var(--st-ink-muted)";
  const es = new EventSource("/api/cli/install");
  let output = "";
  es.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "stdout" || msg.type === "stderr") {
      output += msg.data;
      statusEl.textContent = msg.data.trim().split("\n").pop();
    } else if (msg.type === "done") {
      statusEl.textContent = "Installed";
      statusEl.style.color = "var(--st-state-active-fg)";
      btn.textContent = "Update DR CLI";
      btn.disabled = false;
      es.close();
      ctx.showToast("DR CLI installed/updated successfully.");
      ctx.recheckHealth().then(() => ctx.render());
    } else if (msg.type === "error") {
      statusEl.textContent = "Failed";
      statusEl.style.color = "var(--st-state-failed-fg)";
      btn.textContent = "Retry";
      btn.disabled = false;
      es.close();
      ctx.showToast("DR CLI install failed: " + msg.data, "error");
    }
  };
  es.onerror = () => {
    statusEl.textContent = "Connection lost";
    statusEl.style.color = "var(--st-state-failed-fg)";
    btn.textContent = "Retry";
    btn.disabled = false;
    es.close();
  };
}
