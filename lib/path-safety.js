const fs = require("fs");
const path = require("path");

// Path containment check used to gate destructive filesystem operations.
//
// `isInsideRoot(candidate, root, { mustExist })` returns true only when
// `candidate` resolves to a location strictly inside `root`.
//
// Defends against:
//   - sibling-prefix bypass: "C:\Root-evil" is NOT inside "C:\Root"
//     (string startsWith would wrongly accept it; path.relative gives "..\Root-evil")
//   - traversal: ".." segments
//   - root-equality: candidate === root is rejected (you can't purge the root itself)
//   - symlink/junction escape (mustExist:true): both sides are resolved with
//     fs.realpathSync.native, so a link inside root pointing outside is rejected
//
// With mustExist:true a non-existent candidate is rejected (can't realpath it),
// which is the safe default for delete/move callers.

function realpathNativeOrNull(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

function isInsideRoot(candidate, root, opts = {}) {
  const mustExist = !!opts.mustExist;
  if (typeof candidate !== "string" || typeof root !== "string") return false;
  if (!candidate || !root) return false;

  let resolvedCandidate;
  let resolvedRoot;

  if (mustExist) {
    resolvedCandidate = realpathNativeOrNull(candidate);
    if (!resolvedCandidate) return false; // non-existent → reject
    // Resolve the root too so a symlinked root compares correctly; fall back
    // to a plain resolve if the root itself can't be realpath'd.
    resolvedRoot = realpathNativeOrNull(root) || path.resolve(root);
  } else {
    resolvedCandidate = path.resolve(candidate);
    resolvedRoot = path.resolve(root);
  }

  const rel = path.relative(resolvedRoot, resolvedCandidate);

  // Root-equality → rel === "" → reject.
  if (rel === "") return false;
  // Escape (traversal or different drive) → reject.
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return false;
  return true;
}

module.exports = { isInsideRoot };
