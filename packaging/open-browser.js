const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const PID_FILE = path.join(
  process.env.LOCALAPPDATA || path.join(require("os").homedir(), "AppData", "Local"),
  "DR Launcher",
  "server.pid"
);

const args = process.argv.slice(2);
const shouldWait = args.includes("--wait");
const portArg = args.find((a) => /^\d+$/.test(a));

function readPort() {
  if (portArg) return parseInt(portArg, 10);
  try {
    const raw = fs.readFileSync(PID_FILE, "utf8").trim();
    if (raw.startsWith("{")) {
      return JSON.parse(raw).port;
    }
    return parseInt(raw.split(":")[1], 10);
  } catch {
    return null;
  }
}

function ping(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/ping`, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve(res.statusCode === 200));
    });
    req.on("error", () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
  });
}

async function waitForServer(port, maxMs) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (await ping(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function openBrowser(port) {
  exec(`start "" "http://127.0.0.1:${port}"`, () => {});
}

(async () => {
  const port = readPort();
  if (!port) {
    process.stderr.write("Could not determine server port\n");
    process.exit(1);
  }

  if (shouldWait) {
    const ok = await waitForServer(port, 10000);
    if (!ok) {
      process.stderr.write(`Server did not respond on port ${port} within 10s\n`);
      process.exit(2);
    }
  }

  openBrowser(port);
  setTimeout(() => process.exit(0), 500);
})();
