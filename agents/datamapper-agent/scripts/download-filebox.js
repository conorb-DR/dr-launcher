#!/usr/bin/env node
/**
 * Filebox direct download — fallback for Bug 5 (dr filebox preview hardcoded doc_id=1)
 *
 * Usage:
 *   node download-filebox.js <doc_id> <version_id> <SERVER>
 *
 * Reads JWT from the OS keychain (where dr-cli stores it) and downloads the file
 * to .agent/downloads/<doc_id>-<version_id>.<ext>.
 *
 * Server-to-base-url mapping mirrors dr-cli.
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const { execSync } = require("child_process");

const SERVER_URLS = {
  US: "https://us.datarails.com",
  US2: "https://us-2.datarails.com",
  UK: "https://uk.datarails.com",
  CA: "https://ca.datarails.com",
  EU: "https://app.datarails.com",
};

function readJwt() {
  // Windows credential manager — dr-cli stores under "datarails-cli" target.
  // This is a best-effort read. If it fails, we throw and let the caller surface to the user.
  if (process.platform === "win32") {
    try {
      const ps = `(Get-StoredCredential -Target 'datarails-cli').Password | ConvertFrom-SecureString -AsPlainText`;
      return execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: "utf8" }).trim();
    } catch (e) {
      // Fallback: read from dr-cli's session file if it exists
      const sessionPath = path.join(process.env.USERPROFILE || "", ".dr-cli", "session.json");
      if (fs.existsSync(sessionPath)) {
        const session = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
        return session.jwt || session.access_token;
      }
      throw new Error("Could not read JWT from credential manager or session file. Run `dr whoami` to refresh, then retry.");
    }
  }
  throw new Error("Non-Windows JWT read not implemented.");
}

function download(url, jwt, outPath) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { Authorization: `Bearer ${jwt}` } }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        return download(res.headers.location, jwt, outPath).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }
      const out = fs.createWriteStream(outPath);
      res.pipe(out);
      out.on("finish", () => out.close(() => resolve(outPath)));
      out.on("error", reject);
    });
    req.on("error", reject);
  });
}

async function main() {
  const [docId, versionId, server] = process.argv.slice(2);
  if (!docId || !versionId || !server) {
    console.error("Usage: download-filebox.js <doc_id> <version_id> <SERVER>");
    process.exit(2);
  }
  const base = SERVER_URLS[server.toUpperCase()];
  if (!base) {
    console.error(`Unknown server: ${server}. Valid: ${Object.keys(SERVER_URLS).join(", ")}`);
    process.exit(2);
  }

  const jwt = readJwt();
  const url = `${base}/api/documents/${docId}/versions/${versionId}/raw`;
  const outDir = path.join(process.cwd(), ".agent", "downloads");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${docId}-${versionId}.xlsx`);

  console.log(`Downloading ${url} → ${outPath}`);
  await download(url, jwt, outPath);
  console.log(`✅ Saved to ${outPath}`);
}

main().catch((e) => {
  console.error(`❌ ${e.message}`);
  process.exit(1);
});
