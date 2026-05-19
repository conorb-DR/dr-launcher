const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const logger = require("./log");

const SCRIPT_PATH = path.join(__dirname, "scripts", "tray.ps1");
const SIGNAL_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(require("os").homedir(), "AppData", "Local"),
  "DR Launcher"
);

let trayProcess = null;
let signalWatcher = null;

function initTray({ port, iconPath, onQuit }) {
  const signalFile = path.join(SIGNAL_DIR, `tray-signal-${process.pid}.tmp`);

  try { fs.mkdirSync(SIGNAL_DIR, { recursive: true }); } catch {}
  try { fs.writeFileSync(signalFile, "", "utf8"); } catch {}

  const icoArg = (iconPath && fs.existsSync(iconPath))
    ? ` -IconPath '${iconPath.replace(/'/g, "''")}'`
    : "";
  const cmd = `& '${SCRIPT_PATH.replace(/'/g, "''")}' -Port ${port} -SignalFile '${signalFile.replace(/'/g, "''")}' -NodePid ${process.pid}${icoArg}`;

  const args = [
    "-NoProfile",
    "-STA",
    "-WindowStyle", "Hidden",
    "-ExecutionPolicy", "Bypass",
    "-Command", cmd,
  ];

  trayProcess = spawn("powershell.exe", args, {
    stdio: "ignore",
    windowsHide: true,
  });

  trayProcess.on("error", (err) => {
    logger.log("warn", "tray", `Failed to start tray: ${err.message}`);
  });

  trayProcess.on("exit", (code) => {
    logger.log("info", "tray", `Tray process exited (code ${code})`);
    trayProcess = null;
    cleanupSignalFile(signalFile);
  });

  trayProcess.unref();

  signalWatcher = fs.watchFile(signalFile, { interval: 1000 }, () => {
    try {
      const content = fs.readFileSync(signalFile, "utf8").trim();
      if (content === "quit") {
        logger.log("info", "tray", "Quit signal received from tray");
        cleanupSignalFile(signalFile);
        if (onQuit) onQuit();
      }
    } catch {}
  });

  process.on("exit", () => {
    cleanupSignalFile(signalFile);
    if (trayProcess) {
      try { process.kill(trayProcess.pid); } catch {}
    }
  });

  logger.log("info", "tray", `System tray started (PID ${trayProcess.pid})`);
}

function cleanupSignalFile(filePath) {
  if (signalWatcher) {
    fs.unwatchFile(filePath);
    signalWatcher = null;
  }
  try { fs.unlinkSync(filePath); } catch {}
}

function destroyTray() {
  if (trayProcess) {
    try { process.kill(trayProcess.pid); } catch {}
    trayProcess = null;
  }
}

module.exports = { initTray, destroyTray };
