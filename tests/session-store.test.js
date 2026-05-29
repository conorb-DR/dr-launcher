const fs = require("fs");
const os = require("os");
const path = require("path");

// FS isolation: point LOCALAPPDATA at a temp dir BEFORE requiring the store.
// (session-store resolves its path lazily, so this also covers any late read,
// but we set it up front per the test-isolation convention.)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dr-sessions-"));
process.env.LOCALAPPDATA = TMP;

const { describe, it, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");

const store = require("../lib/session-store");
const sessions = require("../lib/sessions");

const STORE_FILE = store.storePath();
const STORE_DIR = path.dirname(STORE_FILE);

function clearStore() {
  try {
    for (const f of fs.readdirSync(STORE_DIR)) {
      if (f.startsWith("sessions.json")) fs.unlinkSync(path.join(STORE_DIR, f));
    }
  } catch { /* dir may not exist yet */ }
}

describe("session-store (P2-4)", () => {
  beforeEach(clearStore);
  after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

  it("read() returns [] when there is no file", () => {
    assert.deepEqual(store.read(), []);
  });

  it("update() persists and read() returns it", () => {
    store.update((s) => { s.push({ sessionId: "a", status: "active" }); return s; });
    assert.deepEqual(store.read(), [{ sessionId: "a", status: "active" }]);
  });

  it("update() is interleave-free read-modify-write (no lost update)", () => {
    // Two synchronous updates in a row: the second MUST see the first's write.
    store.update((s) => { s.push({ sessionId: "a", status: "active" }); return s; });
    store.update((s) => { s.push({ sessionId: "b", status: "active" }); return s; });
    const all = store.read();
    assert.equal(all.length, 2, "second update saw the first's persisted state");
    assert.deepEqual(all.map((x) => x.sessionId).sort(), ["a", "b"]);
  });

  it("writes atomically — no leftover .tmp files, valid JSON", () => {
    store.update((s) => { s.push({ sessionId: "x", status: "active" }); return s; });
    const leftovers = fs.readdirSync(STORE_DIR).filter((f) => f.includes(".tmp."));
    assert.deepEqual(leftovers, [], "no temp files should remain");
    JSON.parse(fs.readFileSync(STORE_FILE, "utf8")); // throws if not valid JSON
  });

  it("backs up corrupt JSON and resets to []", () => {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, "{ this is not json", "utf8");
    assert.deepEqual(store.read(), []);
    const backups = fs.readdirSync(STORE_DIR).filter((f) => f.includes(".corrupt."));
    assert.ok(backups.length >= 1, "corrupt file should be backed up");
  });

  it("non-array JSON is treated as empty", () => {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify({ not: "an array" }), "utf8");
    assert.deepEqual(store.read(), []);
  });
});

describe("classifyReconcile (P2-5)", () => {
  it("adopts a living active or stale session", () => {
    assert.equal(sessions.classifyReconcile({ status: "active" }, true), "adopt");
    assert.equal(sessions.classifyReconcile({ status: "stale" }, true), "adopt");
  });

  it("ends a confirmed-dead active or stale session", () => {
    assert.equal(sessions.classifyReconcile({ status: "active" }, false), "end");
    assert.equal(sessions.classifyReconcile({ status: "stale" }, false), "end");
  });

  it("skips a session that is already ended (regardless of liveness)", () => {
    assert.equal(sessions.classifyReconcile({ status: "ended" }, true), "skip");
    assert.equal(sessions.classifyReconcile({ status: "ended" }, false), "skip");
  });
});

describe("session lifecycle through the store", () => {
  beforeEach(clearStore);

  it("registerSession blocks a duplicate active accountId", () => {
    const data = { sessionId: "s1", accountId: "US:a@b.com" };
    assert.equal(sessions.registerSession(data).ok, true);
    const dup = sessions.registerSession({ sessionId: "s2", accountId: "US:a@b.com" });
    assert.equal(dup.ok, false);
    assert.equal(dup.error, "active_session_exists");
  });

  it("endSession marks ended and unblocks re-registration", () => {
    sessions.registerSession({ sessionId: "s1", accountId: "US:a@b.com" });
    assert.equal(sessions.endSession("s1"), true);
    // Now a new session for the same account is allowed.
    assert.equal(sessions.registerSession({ sessionId: "s2", accountId: "US:a@b.com" }).ok, true);
  });

  it("pruneEndedSessions drops old ended sessions but keeps active", () => {
    sessions.registerSession({ sessionId: "live", accountId: "US:x@y.com" });
    store.update((s) => {
      s.push({ sessionId: "old", accountId: "US:z@y.com", status: "ended", endedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
      return s;
    });
    const kept = sessions.pruneEndedSessions();
    const ids = kept.map((s) => s.sessionId);
    assert.ok(ids.includes("live"));
    assert.ok(!ids.includes("old"));
  });
});
