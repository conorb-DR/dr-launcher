// Settings "Cleanup unused data" feature. Wires the Scan button inside the
// settings overlay: scans for orphaned Chrome profiles + workspaces and offers
// purge / quarantine actions. Pure feature module — the overlay element and
// side-effects are injected.
//
//   ctx = { headers: object, showToast(msg, level?) }
import { esc } from "./util.mjs";

export function wireCleanup(overlay, ctx) {
  const cleanupBtn = overlay.querySelector("#settings-cleanup-scan");
  if (!cleanupBtn) return;

  cleanupBtn.addEventListener("click", async () => {
    cleanupBtn.disabled = true;
    cleanupBtn.textContent = "Scanning…";
    try {
      const res = await fetch("/api/cleanup/scan", { headers: ctx.headers });
      const data = await res.json();
      const resultsDiv = overlay.querySelector("#cleanup-results");
      if (!resultsDiv) return;
      const totalProfiles = data.profiles?.length || 0;
      const totalWorkspaces = data.workspaces?.length || 0;
      if (totalProfiles === 0 && totalWorkspaces === 0) {
        resultsDiv.style.display = "block";
        resultsDiv.innerHTML = `<div style="padding:12px 16px;color:var(--st-ink-muted);font-size:13px">No orphaned data found.</div>`;
        return;
      }
      let html = `<div style="padding:12px 16px;font-size:13px">`;
      if (totalProfiles > 0) {
        const totalSize = data.profiles.reduce((sum, p) => sum + p.sizeMB, 0).toFixed(1);
        html += `<div style="margin-bottom:8px"><strong>${totalProfiles} orphaned Chrome profile${totalProfiles > 1 ? "s" : ""}</strong> (${totalSize} MB)</div>`;
        html += `<div style="margin-bottom:8px">`;
        data.profiles.forEach((p) => {
          html += `<label style="display:flex;align-items:center;gap:6px;padding:2px 0;font-size:12px;color:var(--st-ink-muted)">
            <input type="checkbox" class="cleanup-profile-cb" data-path="${esc(p.path)}" checked>
            ${esc(p.slug)} (${p.sizeMB} MB)${p.lastUsed ? ` — last used ${new Date(p.lastUsed).toLocaleDateString()}` : ""}
          </label>`;
        });
        html += `</div><button class="st-btn st-btn--sm st-btn--destructive" id="cleanup-purge-profiles">Delete selected profiles</button>`;
      }
      if (totalWorkspaces > 0) {
        const totalSize = data.workspaces.reduce((sum, w) => sum + w.sizeMB, 0).toFixed(1);
        html += `<div style="margin-top:12px;margin-bottom:8px"><strong>${totalWorkspaces} orphaned workspace${totalWorkspaces > 1 ? "s" : ""}</strong> (${totalSize} MB)</div>`;
        html += `<div style="margin-bottom:8px">`;
        data.workspaces.forEach((w) => {
          html += `<label style="display:flex;align-items:center;gap:6px;padding:2px 0;font-size:12px;color:var(--st-ink-muted)">
            <input type="checkbox" class="cleanup-ws-cb" data-path="${esc(w.path)}" checked>
            ${esc(w.slug)} (${w.sizeMB} MB)${w.hasUserContent ? ` <span class="st-badge st-badge--stale">modified</span>` : ""}
          </label>`;
        });
        html += `</div><button class="st-btn st-btn--sm st-btn--stale" id="cleanup-quarantine-ws">Move selected to quarantine</button>`;
      }
      html += `</div>`;
      resultsDiv.style.display = "block";
      resultsDiv.innerHTML = html;
      const purgeBtn = resultsDiv.querySelector("#cleanup-purge-profiles");
      if (purgeBtn) {
        purgeBtn.addEventListener("click", async () => {
          const checked = [...resultsDiv.querySelectorAll(".cleanup-profile-cb:checked")].map((cb) => cb.dataset.path);
          if (checked.length === 0) return ctx.showToast("No profiles selected.", "warn");
          purgeBtn.disabled = true;
          purgeBtn.textContent = "Deleting…";
          try {
            const r = await fetch("/api/cleanup/purge", { method: "POST", headers: ctx.headers, body: JSON.stringify({ profiles: checked }) });
            const d = await r.json();
            ctx.showToast(`Deleted ${d.profiles?.deleted?.length || 0} profile(s).`);
            cleanupBtn.click();
          } catch (err) {
            ctx.showToast("Purge failed: " + err.message, "error");
          }
        });
      }
      const quarantineBtn = resultsDiv.querySelector("#cleanup-quarantine-ws");
      if (quarantineBtn) {
        quarantineBtn.addEventListener("click", async () => {
          const checked = [...resultsDiv.querySelectorAll(".cleanup-ws-cb:checked")].map((cb) => cb.dataset.path);
          if (checked.length === 0) return ctx.showToast("No workspaces selected.", "warn");
          quarantineBtn.disabled = true;
          quarantineBtn.textContent = "Moving…";
          try {
            const r = await fetch("/api/cleanup/purge", { method: "POST", headers: ctx.headers, body: JSON.stringify({ workspaces: checked }) });
            const d = await r.json();
            ctx.showToast(`Quarantined ${d.workspaces?.quarantined?.length || 0} workspace(s).`);
            cleanupBtn.click();
          } catch (err) {
            ctx.showToast("Quarantine failed: " + err.message, "error");
          }
        });
      }
    } catch (err) {
      ctx.showToast("Scan failed: " + err.message, "error");
    } finally {
      // Always restore the button — the early returns above (no orphaned data,
      // missing results container) must not leave it stuck on "Scanning…".
      cleanupBtn.disabled = false;
      cleanupBtn.textContent = "Scan";
    }
  });
}
