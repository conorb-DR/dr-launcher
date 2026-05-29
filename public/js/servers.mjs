// Frontend server registry. SERVER_FALLBACK mirrors the canonical hosts in
// lib/servers.js BUNDLED_DEFAULTS (parity enforced by
// tests/server-registry.test.js) — build URLs from `.host`, never `.label`.
//
// The live list is replaced at runtime from /api/servers via setServers().
// It is kept in module-private state (not a reassigned export) so consumers
// read the current value through getServers()/serverInfo() — ES module exports
// can't be reassigned from outside the module.
export const SERVER_FALLBACK = Object.freeze([
  { key: "US",  host: "https://app.datarails.com",   label: "app.datarails.com",   color: "#4646CE", soft: "#DFD9FF", text: "#25258C", region: "United States" },
  { key: "US2", host: "https://us-2.datarails.com",  label: "us-2.datarails.com",  color: "#7B61FF", soft: "#F0EEFF", text: "#5D45D6", region: "United States (instance 2)" },
  { key: "UK",  host: "https://ukapp.datarails.com", label: "ukapp.datarails.com", color: "#03A678", soft: "#ECFAE4", text: "#037C5A", region: "United Kingdom" },
  { key: "CA",  host: "https://caapp.datarails.com", label: "caapp.datarails.com", color: "#FFA310", soft: "#FFF4D4", text: "#9E5F00", region: "Canada" },
]);

let current = SERVER_FALLBACK.slice();

export function setServers(list) {
  current = Array.isArray(list) && list.length > 0 ? list : SERVER_FALLBACK.slice();
}

export function getServers() {
  return current;
}

export function serverInfo(key) {
  return current.find((s) => s.key === key) ||
    { key, host: "", label: "", color: "#9EA1AA", soft: "#F0F1F4", text: "#4E566C", region: key };
}
