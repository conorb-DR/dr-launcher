const fs = require("fs");
const path = require("path");
const os = require("os");

// Standalone persistence for the active/stale session registry.
//
// Owns sessions.json. Requires neither ./settings nor ./sessions, so it can be
// imported from either without a circular dependency.
//
// The path is resolved LAZILY (at each call), not captured at module load, so
// tests can point LOCALAPPDATA/USERPROFILE at a temp dir before the first call.
//
// update(fn) is a FULLY SYNCHRONOUS read-modify-write. Synchronous adjacency is
// what makes it interleave-free without a mutex: nothing can run between the
// read and the write. (The old lost-update bug existed only because session
// health probing awaited between reading and writing the registry.)

function storeDir() {
  return path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
    "DR Launcher"
  );
}

function storePath() {
  return path.join(storeDir(), "sessions.json");
}

function read() {
  const p = storePath();
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    return []; // missing/unreadable → empty registry
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Corrupt JSON → back it up, then start fresh.
    try { fs.renameSync(p, p + ".corrupt." + Date.now()); } catch { /* ignore */ }
    return [];
  }
}

function writeAll(sessions) {
  const dir = storeDir();
  fs.mkdirSync(dir, { recursive: true });
  const p = storePath();
  const tmp = p + ".tmp." + process.pid + "." + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(sessions, null, 2), "utf8");
  fs.renameSync(tmp, p); // atomic
}

// Synchronous read-modify-write. `fn` receives the current array; the returned
// array (or the mutated-in-place array) is persisted.
function update(fn) {
  const current = read();
  const next = fn(current);
  const result = Array.isArray(next) ? next : current;
  writeAll(result);
  return result;
}

module.exports = { read, update, writeAll, storePath };
