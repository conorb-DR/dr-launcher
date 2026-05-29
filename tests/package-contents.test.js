const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

// P1-1 guard: the packaging build must stage the agents/, lib/, and public/
// directories. This is a static check against build.ps1 — the full network
// installer build (which downloads Node) is not run in CI/overnight.
const BUILD_PS1 = path.join(__dirname, "..", "packaging", "build.ps1");

function extractArrayLiteral(content, varName) {
  // Matches:  $dirsToCopy = @("a", "b", "c")
  const re = new RegExp(`\\$${varName}\\s*=\\s*@\\(([^)]*)\\)`);
  const m = content.match(re);
  if (!m) return null;
  return m[1]
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

describe("packaging/build.ps1 contents (P1-1)", () => {
  const content = fs.readFileSync(BUILD_PS1, "utf8");

  it("$dirsToCopy includes agents, lib, and public", () => {
    const dirs = extractArrayLiteral(content, "dirsToCopy");
    assert.ok(dirs, "could not find $dirsToCopy in build.ps1");
    for (const required of ["agents", "lib", "public"]) {
      assert.ok(dirs.includes(required), `$dirsToCopy must include "${required}" (found: ${dirs.join(", ")})`);
    }
  });

  it("$filesToCopy does NOT ship the placeholder auth-config.json", () => {
    const files = extractArrayLiteral(content, "filesToCopy");
    assert.ok(files, "could not find $filesToCopy in build.ps1");
    assert.ok(
      !files.includes("auth-config.json"),
      "auth-config.json must not be in $filesToCopy — shipping the dev placeholder disables prod SSO"
    );
  });

  it("prod SSO config is sourced from packaging/auth-config.prod.json", () => {
    assert.ok(
      content.includes("auth-config.prod.json"),
      "build.ps1 should reference packaging/auth-config.prod.json for prod SSO"
    );
  });
});
