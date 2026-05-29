# DR Launcher

A local desktop tool that gives Datarails Implementation Managers and Solution Engineers a single control panel for managing isolated customer workspaces.

Instead of juggling Chrome profiles, terminal windows, and CLI sessions manually, DR Launcher handles it all from one UI.

## What it does

- **Isolated Chrome profiles** per customer — separate cookies, sessions, and cache. No cross-contamination between tenants.
- **Claude Code terminals** pre-configured with customer context (server, account, org domain, CLI flags via auto-generated CLAUDE.md)
- **Session management** — see what's running, switch between customers, close sessions cleanly
- **DR CLI integration** — auto-discovers accounts you have access to via `dr` CLI
- **Launch history and artifacts** — tracks what you opened and when
- **Virtual desktops** (optional) — separate customer workspaces onto their own Windows virtual desktops

Runs as a local Node.js/Express server with a web UI at `http://localhost:3456`.

## Requirements

- **Windows 10 or 11**
- **Node.js 18+**
- **Chrome** installed in a standard location (or set `CHROME_PATH` env var)
- **DR CLI** installed and authenticated — `dr whoami` should return your account

## Quick start

```bash
git clone <repo-url>
cd dr-launcher
npm install
npm start
```

The app opens in your browser at `http://localhost:3456`.

### Dev login

Azure AD SSO is not configured for dev use. You'll see the **Dev Login** screen on first launch. Enter the dev password `DR1234` and your display name to get in.

You do **not** need to create an `auth-config.json` file — the app detects that Azure AD is unconfigured and automatically presents the dev login flow.

## Project structure

```
dr-launcher/
├── server.js              # Express server — main entry point
├── lib/
│   ├── auth.js            # Authentication (Azure AD + dev mode)
│   ├── chrome.js          # Isolated Chrome profile launcher
│   ├── workspace.js       # Customer workspace + CLAUDE.md generation
│   ├── sessions.js        # Active session tracking
│   ├── dr-cli.js          # DR CLI integration (account discovery)
│   ├── virtual-desktop.js # Windows virtual desktop management
│   ├── settings.js        # Local settings persistence
│   ├── preferences.js     # User preferences (syncable)
│   ├── history.js         # Launch history tracking
│   ├── artifacts.js       # Session artifact metadata
│   ├── cloud.js           # Cloud sync interface
│   ├── cloud-mock.js      # Mock cloud backend (dev)
│   ├── sync.js            # Preference + history sync engine
│   ├── servers.js         # Datarails server registry
│   ├── clipboard.js       # CLI instruction builder
│   ├── cleanup.js         # Session + profile cleanup
│   ├── log.js             # Logging (file + console)
│   └── tray.js            # System tray integration
├── public/
│   ├── index.html         # Main UI shell
│   ├── app.js             # Frontend application
│   └── style.css          # Styles
└── packaging/
    ├── build.ps1          # Windows installer build script
    ├── build-config.json  # Build configuration
    ├── installer.iss      # Inno Setup installer definition
    └── Launcher.cs        # Native C# launcher stub
```

## Configuration

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DR_LAUNCHER_WORKSPACE_ROOT` | `~/Documents/DR-Customers` | Where customer workspace folders are created |
| `CHROME_PATH` | Auto-detected | Path to Chrome executable |

### Local data

All runtime data is stored in `%LOCALAPPDATA%/DR Launcher/`:

| File | Purpose |
|------|---------|
| `settings.json` | Local settings (virtual desktops toggle, etc.) |
| `preferences.json` | User preferences |
| `launch-history.json` | Launch history log |
| `dr-launcher.log` | Application log |
| `auth-cache.json` | Azure AD token cache (only when SSO is configured) |
| `dev-session.json` | Dev mode session (only when using dev login) |
| `ChromeProfiles/` | Isolated Chrome user data directories per customer |

### Azure AD (production)

For production SSO, create `auth-config.json` in the project root:

```json
{
  "clientId": "your-azure-ad-client-id",
  "tenantId": "your-azure-ad-tenant-id"
}
```

This file is gitignored and will never be committed.

## Building the installer

The packaging pipeline produces a Windows installer using Inno Setup:

```powershell
npm run build
```

Requires [Inno Setup 6](https://jrsoftware.org/isinfo.php) installed. The build script downloads a portable Node.js runtime, bundles the app, and produces a standalone `.exe` installer.

## Troubleshooting

**App won't start / port conflict:** DR Launcher tries ports 3456-3458. If all are in use, check for orphaned `node server.js` processes.

**No accounts showing up:** Make sure `dr whoami` works in your terminal. The launcher uses the DR CLI to discover your accounts.

**Chrome won't launch:** Verify Chrome is installed, or set `CHROME_PATH` to your Chrome executable.

**Logs:** Check `%LOCALAPPDATA%/DR Launcher/dr-launcher.log` for detailed error output.

## License

Internal use only — Datarails.
