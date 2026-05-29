const { execFile, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// Safe command execution for the `dr` CLI.
//
// `dr` installs as an npm-global shim. On Windows that means `dr.cmd` (+ a
// `dr` shell script and `dr.ps1`). You cannot execFile("dr", ...) directly
// (no executable bit / extension resolution without a shell), and routing
// through `cmd /c dr ...` re-introduces shell metacharacter parsing of the
// arguments. So we resolve, once, the *real* entry point and prefer running
// it with NO shell:
//   - JS bin entry  -> execFile(node, [entry, ...args])   (no shell — safest)
//   - .exe          -> execFile(exe, args)                (no shell)
//   - .cmd only     -> execFile(cmd, args, { shell:true }) (relies on Node's
//                       post-CVE-2024-27980 Windows argument escaping)
//
// `dr` inputs are already validated upstream (whitelisted server keys, regex
// emails), so this is defense-in-depth. Injection safety of the no-shell form
// is proven empirically by tests/run-command.test.js, which round-trips
// adversarial argv through runNoShell on the running Node.

function settle(resolve, err, stdout, stderr) {
  resolve({
    stdout: (stdout || "").trim(),
    stderr: (stderr || (err && err.stderr) || "").trim(),
    exitCode: err ? (err.code || 1) : 0,
    timedOut: !!(err && err.killed),
    signal: (err && err.signal) || null,
  });
}

// execFile with NO shell — arguments are passed verbatim as argv entries, so
// shell metacharacters in values have no special meaning.
function runNoShell(command, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { encoding: "utf8", timeout: opts.timeout || 15000, windowsHide: true },
      (err, stdout, stderr) => settle(resolve, err, stdout, stderr)
    );
  });
}

// .cmd fallback — shell:true lets Node spawn the batch shim AND apply its
// hardened Windows argument escaping (added in the CVE-2024-27980 fix).
function runShell(command, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { encoding: "utf8", timeout: opts.timeout || 15000, windowsHide: true, shell: true },
      (err, stdout, stderr) => settle(resolve, err, stdout, stderr)
    );
  });
}

function findDrJsEntry(npmDir) {
  try {
    const pkgDir = path.join(npmDir, "node_modules", "dr-cli");
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    let bin = pkg.bin;
    if (bin && typeof bin === "object") bin = bin.dr || Object.values(bin)[0];
    if (typeof bin === "string") {
      const entry = path.resolve(pkgDir, bin);
      if (fs.existsSync(entry)) return entry;
    }
  } catch {
    /* fall through */
  }
  return null;
}

let _drResolution; // undefined = not yet resolved; null = not found

function resolveDr() {
  if (_drResolution !== undefined) return _drResolution;
  _drResolution = null;
  try {
    const out = execSync("where dr", { encoding: "utf8" });
    const candidates = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

    // Prefer a real .exe if one exists.
    const exe = candidates.find((c) => path.extname(c).toLowerCase() === ".exe");
    if (exe) {
      _drResolution = { mode: "execfile", target: exe };
      return _drResolution;
    }

    // Otherwise resolve the JS bin entry next to the .cmd shim and run it via node.
    const cmd = candidates.find((c) => path.extname(c).toLowerCase() === ".cmd") || candidates[0];
    if (cmd) {
      const jsEntry = findDrJsEntry(path.dirname(cmd));
      if (jsEntry) {
        _drResolution = { mode: "node", target: jsEntry };
        return _drResolution;
      }
      _drResolution = { mode: "shell", target: cmd };
    }
  } catch {
    _drResolution = null;
  }
  return _drResolution;
}

function runDr(args, opts = {}) {
  const r = resolveDr();
  if (!r) {
    // dr not found via `where` — last resort, let the shell try to resolve it.
    return runShell("dr", args, opts);
  }
  if (r.mode === "node") return runNoShell(process.execPath, [r.target, ...args], opts);
  if (r.mode === "execfile") return runNoShell(r.target, args, opts);
  return runShell(r.target, args, opts);
}

function _resetCache() {
  _drResolution = undefined;
}

module.exports = { runDr, runNoShell, runShell, resolveDr, _resetCache };
