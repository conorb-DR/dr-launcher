#!/usr/bin/env node
//
// lint-agent-paths.js — fail the build if any agent source file contains a
// personal absolute path (e.g. C:\Users\someone\..., /Users/someone/...,
// /home/someone/...). Agent sources must use portable [[TOKEN]] placeholders
// instead, which the scaffold pipeline expands to relative workspace paths.
//
// Usage: node scripts/lint-agent-paths.js [dir]   (default dir: ./agents)
// Exit code: 0 = clean, 1 = violations found.

const fs = require("fs");
const path = require("path");

const TEXT_EXTS = [".md", ".json", ".ps1", ".js", ".txt", ".yaml", ".yml"];

const PATTERNS = [
  { name: "windows-user-path", re: /[A-Za-z]:\\Users\\/i },
  { name: "macos-user-path", re: /\/Users\/[^/\s]+\// },
  { name: "linux-user-path", re: /\/home\/[^/\s]+\// },
];

function isTextFile(filePath) {
  return TEXT_EXTS.includes(path.extname(filePath).toLowerCase());
}

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (isTextFile(full)) files.push(full);
  }
  return files;
}

function main() {
  const root = process.argv[2] || path.join(__dirname, "..", "agents");
  if (!fs.existsSync(root)) {
    console.error(`lint-agent-paths: directory not found: ${root}`);
    process.exit(1);
  }

  const violations = [];
  for (const file of walk(root)) {
    let content;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    content.split("\n").forEach((line, idx) => {
      for (const { name, re } of PATTERNS) {
        const m = line.match(re);
        if (m) {
          violations.push({
            file: path.relative(process.cwd(), file),
            line: idx + 1,
            pattern: name,
            snippet: m[0],
          });
          break;
        }
      }
    });
  }

  if (violations.length) {
    console.error(`lint-agent-paths: found ${violations.length} personal path(s):`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}: [${v.pattern}] ${v.snippet}`);
    }
    process.exit(1);
  }

  console.log("lint-agent-paths: clean — no personal absolute paths found.");
  process.exit(0);
}

main();
