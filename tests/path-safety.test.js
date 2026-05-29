const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { isInsideRoot } = require("../lib/path-safety");

describe("isInsideRoot (P2-2)", () => {
  let root;
  let inside;
  before(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pathsafe-root-")));
    inside = path.join(root, "child");
    fs.mkdirSync(inside, { recursive: true });
  });
  after(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // --- string-mode (mustExist:false) — pure containment logic ---

  it("accepts a path strictly inside the root", () => {
    assert.equal(isInsideRoot(path.join(root, "a", "b"), root), true);
  });

  it("rejects the root itself (root-equality)", () => {
    assert.equal(isInsideRoot(root, root), false);
  });

  it("rejects a sibling-prefix path (the startsWith bug)", () => {
    // "<root>-evil" string-starts-with "<root>" but is NOT inside it.
    assert.equal(isInsideRoot(root + "-evil", root), false);
  });

  it("rejects a parent-traversal path", () => {
    assert.equal(isInsideRoot(path.join(root, "..", "escape"), root), false);
  });

  it("rejects a path on a different root entirely", () => {
    const other = path.join(os.tmpdir(), "totally-different-root", "x");
    assert.equal(isInsideRoot(other, root), false);
  });

  it("rejects non-string inputs", () => {
    assert.equal(isInsideRoot(null, root), false);
    assert.equal(isInsideRoot(inside, null), false);
    assert.equal(isInsideRoot("", ""), false);
  });

  // --- mustExist mode — realpath-based, rejects non-existent ---

  it("accepts an existing child with mustExist", () => {
    assert.equal(isInsideRoot(inside, root, { mustExist: true }), true);
  });

  it("rejects a non-existent candidate with mustExist", () => {
    assert.equal(isInsideRoot(path.join(root, "nope"), root, { mustExist: true }), false);
  });

  // --- symlink escape — self-skips if the OS blocks symlink creation ---

  it("rejects a symlink inside root that points outside (realpath escape)", (t) => {
    const outsideTarget = fs.mkdtempSync(path.join(os.tmpdir(), "pathsafe-outside-"));
    const link = path.join(root, "escape-link");
    try {
      fs.symlinkSync(outsideTarget, link, "junction");
    } catch {
      try { fs.rmSync(outsideTarget, { recursive: true, force: true }); } catch { /* ignore */ }
      t.skip("symlink/junction creation not permitted on this host");
      return;
    }
    try {
      // String containment would accept (link path is literally under root),
      // but realpath resolution exposes the escape.
      assert.equal(isInsideRoot(link, root, { mustExist: true }), false);
    } finally {
      try { fs.unlinkSync(link); } catch { /* ignore */ }
      try { fs.rmSync(outsideTarget, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
