const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const sync = require("../lib/sync");

// P3-7: pure merge helpers.

describe("mergePreferences", () => {
  it("pushes when there is no remote", () => {
    const local = { theme: "warm", updatedAt: "2026-01-01" };
    assert.deepEqual(sync.mergePreferences(local, null), { action: "push", result: local });
  });

  it("pulls when there is no local", () => {
    const remote = { theme: "cool", updatedAt: "2026-01-01" };
    assert.deepEqual(sync.mergePreferences(null, remote), { action: "pull", result: remote });
  });

  it("pushes a dirty local that is newer", () => {
    const local = { dirty: true, updatedAt: "2026-02-02" };
    const remote = { updatedAt: "2026-01-01" };
    assert.equal(sync.mergePreferences(local, remote).action, "push");
  });

  it("pulls when remote is strictly newer", () => {
    const local = { updatedAt: "2026-01-01" };
    const remote = { updatedAt: "2026-03-03" };
    assert.equal(sync.mergePreferences(local, remote).action, "pull");
  });

  it("does nothing when timestamps are equal and local is clean", () => {
    const local = { updatedAt: "2026-01-01" };
    const remote = { updatedAt: "2026-01-01" };
    assert.equal(sync.mergePreferences(local, remote).action, "none");
  });
});

describe("mergeHistory", () => {
  it("returns local when remote is empty", () => {
    const local = [{ launchId: "a", launchedAt: "2026-01-01" }];
    assert.deepEqual(sync.mergeHistory(local, []), local);
  });

  it("returns remote when local is empty", () => {
    const remote = [{ launchId: "b", launchedAt: "2026-01-01" }];
    assert.deepEqual(sync.mergeHistory([], remote), remote);
  });

  it("dedupes by launchId and sorts newest-first", () => {
    const local = [{ launchId: "a", launchedAt: "2026-01-01" }];
    const remote = [
      { launchId: "a", launchedAt: "2026-01-01" }, // dup
      { launchId: "b", launchedAt: "2026-05-05" },
    ];
    const merged = sync.mergeHistory(local, remote);
    assert.equal(merged.length, 2, "duplicate launchId removed");
    assert.equal(merged[0].launchId, "b", "newest first");
  });
});
