const msal = require("@azure/msal-node");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { exec } = require("child_process");

const AUTH_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "DR Launcher"
);
const CACHE_PATH = path.join(AUTH_DIR, "auth-cache.json");
const DEV_SESSION_PATH = path.join(AUTH_DIR, "dev-session.json");
const CONFIG_PATH = path.join(__dirname, "..", "auth-config.json");

const DEV_PASSWORD = "DR1234";

const DEFAULT_CONFIG = {
  clientId: "YOUR_AZURE_AD_CLIENT_ID",
  tenantId: "YOUR_AZURE_AD_TENANT_ID",
};

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function isConfigured() {
  const cfg = loadConfig();
  return cfg.clientId !== DEFAULT_CONFIG.clientId && cfg.tenantId !== DEFAULT_CONFIG.tenantId;
}

const cachePlugin = {
  beforeCacheAccess: async (ctx) => {
    try {
      const data = fs.readFileSync(CACHE_PATH, "utf8");
      ctx.tokenCache.deserialize(data);
    } catch {
      // No cache file yet
    }
  },
  afterCacheAccess: async (ctx) => {
    if (ctx.cacheHasChanged) {
      fs.mkdirSync(AUTH_DIR, { recursive: true });
      fs.writeFileSync(CACHE_PATH, ctx.tokenCache.serialize(), "utf8");
    }
  },
};

let pca = null;

function getApp() {
  if (pca) return pca;
  const cfg = loadConfig();
  pca = new msal.PublicClientApplication({
    auth: {
      clientId: cfg.clientId,
      authority: `https://login.microsoftonline.com/${cfg.tenantId}`,
    },
    cache: { cachePlugin },
  });
  return pca;
}

const SCOPES = ["User.Read", "openid", "profile", "email"];

let pendingAuth = null;

function startLogin(port) {
  if (pendingAuth) return pendingAuth;

  const app = getApp();
  const redirectUri = `http://localhost:${port}/auth/callback`;

  pendingAuth = app
    .getAuthCodeUrl({
      scopes: SCOPES,
      redirectUri,
      prompt: "select_account",
    })
    .then((authUrl) => {
      exec(`start "" "${authUrl}"`);
      return { started: true, redirectUri };
    })
    .finally(() => {
      pendingAuth = null;
    });

  return pendingAuth;
}

async function handleCallback(code, port) {
  const app = getApp();
  const redirectUri = `http://localhost:${port}/auth/callback`;

  const result = await app.acquireTokenByCode({
    code,
    scopes: SCOPES,
    redirectUri,
  });

  return extractUser(result);
}

function extractUser(authResult) {
  if (!authResult || !authResult.account) return null;
  const acct = authResult.account;
  return {
    email: acct.username,
    name: acct.name || acct.username,
    id: acct.localAccountId,
    tenantId: acct.tenantId,
    cloudId: `${acct.tenantId}:${acct.localAccountId}`,
    initials: buildInitials(acct.name || acct.username),
  };
}

function buildInitials(name) {
  if (!name) return "??";
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

function getDevSession() {
  try {
    const raw = fs.readFileSync(DEV_SESSION_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function devLogin(password, displayName) {
  if (password !== DEV_PASSWORD) return null;
  const user = {
    email: "developer@local",
    name: displayName || "Developer",
    id: "dev-local",
    tenantId: "local",
    cloudId: "local:dev-local",
    initials: buildInitials(displayName || "Developer"),
    devMode: true,
  };
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.writeFileSync(DEV_SESSION_PATH, JSON.stringify(user, null, 2), "utf8");
  return user;
}

function devLogout() {
  try { fs.unlinkSync(DEV_SESSION_PATH); } catch { /* already gone */ }
}

async function getCurrentUser() {
  // Dev session takes priority when Azure AD isn't configured
  if (!isConfigured()) {
    const dev = getDevSession();
    if (dev) return dev;
    return null;
  }

  const app = getApp();
  const cache = app.getTokenCache();
  const accounts = await cache.getAllAccounts();
  if (accounts.length === 0) return null;

  try {
    const result = await app.acquireTokenSilent({
      account: accounts[0],
      scopes: SCOPES,
    });
    return extractUser(result);
  } catch {
    return {
      email: accounts[0].username,
      name: accounts[0].name || accounts[0].username,
      id: accounts[0].localAccountId,
      tenantId: accounts[0].tenantId,
      cloudId: `${accounts[0].tenantId}:${accounts[0].localAccountId}`,
      initials: buildInitials(accounts[0].name || accounts[0].username),
      tokenExpired: true,
    };
  }
}

async function isAuthenticated() {
  const user = await getCurrentUser();
  if (!user) return false;
  if (user.devMode) return true;
  return !user.tokenExpired;
}

async function getAccessToken() {
  const app = getApp();
  const cache = app.getTokenCache();
  const accounts = await cache.getAllAccounts();
  if (accounts.length === 0) return null;

  try {
    const result = await app.acquireTokenSilent({
      account: accounts[0],
      scopes: SCOPES,
    });
    return result.accessToken;
  } catch {
    return null;
  }
}

async function logout() {
  devLogout();
  if (isConfigured()) {
    const app = getApp();
    const cache = app.getTokenCache();
    const accounts = await cache.getAllAccounts();
    for (const acct of accounts) {
      await cache.removeAccount(acct);
    }
    try { fs.unlinkSync(CACHE_PATH); } catch { /* already gone */ }
  }
}

module.exports = {
  isConfigured,
  startLogin,
  handleCallback,
  getCurrentUser,
  isAuthenticated,
  getAccessToken,
  logout,
  devLogin,
  AUTH_DIR,
  CACHE_PATH,
};
