#!/usr/bin/env node
/**
 * api-put-widget.js
 * Direct API call to update a widget — bypasses CLI chart_type validation.
 * Useful for gauge-chart-enhanced, gauge-chart-dynamic-goal, and other types
 * that the CLI's power mode rejects but the API accepts.
 *
 * Usage:
 *   node api-put-widget.js <widget-id> <dashboard-id> <widget-json-file> <server>
 *
 * Server base URLs:
 *   US   → https://app.datarails.com
 *   US2  → https://us-2.datarails.com
 *   UK   → https://uk.datarails.com
 *   CA   → https://ca.datarails.com
 *   DEV  → https://dev.datarails.com
 *   DEV-1 → https://dev-1.datarails.com
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const SERVER_URLS = {
  US: 'https://app.datarails.com',
  US2: 'https://us-2.datarails.com',
  UK: 'https://uk.datarails.com',
  CA: 'https://ca.datarails.com',
  DEV: 'https://dev.datarails.com',
  'DEV-1': 'https://dev-1.datarails.com',
  TEST: 'https://test.datarails.com',
  DEMO: 'https://demo.datarails.com',
};

const DR_CLI_KEYCHAIN_SERVICE = 'dr-cli';
const DR_CLI_PATH = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', 'dr-cli');

async function getAuth(server) {
  const key = server.toUpperCase();

  // Try reading from dr-cli keychain (primary — used when CLI stores creds in OS keyring)
  try {
    const { Entry } = require(path.join(DR_CLI_PATH, 'node_modules', '@napi-rs', 'keyring'));
    // dr-cli indexes known accounts under SERVICE:"__index__:<serverKey>"
    const indexEntry = new Entry(DR_CLI_KEYCHAIN_SERVICE, `__index__:${key}`);
    const indexRaw = indexEntry.getPassword();
    if (indexRaw) {
      const accounts = JSON.parse(indexRaw); // array of {email, savedAt, lastUsedAt} objects
      if (accounts.length > 0) {
        const email = accounts[0].email || accounts[0];
        const accountKey = `${key}:${email}`;
        const sessionEntry = new Entry(DR_CLI_KEYCHAIN_SERVICE, accountKey);
        const sessionRaw = sessionEntry.getPassword();
        if (sessionRaw) {
          const parsed = JSON.parse(sessionRaw);
          if (parsed.sessionId && parsed.csrfToken) {
            return { sessionId: parsed.sessionId, csrfToken: parsed.csrfToken };
          }
        }
      }
    }
  } catch (e) {
    // keyring unavailable or no entry — fall through to credentials file
  }

  // Fallback: credentials.json file
  const credsPath = path.join(os.homedir(), '.dr', 'credentials.json');
  const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
  const entry = (creds.servers || creds)[key];
  if (!entry) throw new Error(`No credentials for server ${key}. Available: ${Object.keys(creds.servers || creds).join(', ')}`);
  return { sessionId: entry.session_id, csrfToken: entry.csrf_token };
}

/**
 * HTML-unescape filter values before PUT.
 * The API stores text like "P&L" as "P&amp;L". When dr widgets get returns it,
 * the JSON contains the encoded form. If we PUT that back as-is, the API
 * double-encodes it to "P&amp;amp;L", breaking the filter match.
 * Fix: unescape all string values in list-type filters before sending.
 */
function unescapeFilterValues(body) {
  if (!body.filters) return body;
  const unescape = (s) => String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  body.filters = body.filters.map(f => {
    if (Array.isArray(f.values)) {
      return { ...f, values: f.values.map(v => typeof v === 'string' ? unescape(v) : v) };
    }
    return f;
  });
  return body;
}

function apiPut(baseUrl, endpoint, auth, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url = new URL(endpoint, baseUrl);
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `sessionid=${auth.sessionId}; csrftoken=${auth.csrfToken}`,
        'X-CSRFToken': auth.csrfToken,
        'Referer': baseUrl,
        'Content-Length': Buffer.byteLength(payload),
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 300)}`));
        } else {
          resolve(JSON.parse(data));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  const [widgetId, dashboardId, jsonFile, server] = process.argv.slice(2);
  if (!widgetId || !dashboardId || !jsonFile || !server) {
    console.error('Usage: node api-put-widget.js <widget-id> <dashboard-id> <json-file> <server>');
    process.exit(1);
  }

  const serverKey = server.toUpperCase();
  const baseUrl = SERVER_URLS[serverKey];
  if (!baseUrl) {
    console.error(`Unknown server: ${server}. Valid: ${Object.keys(SERVER_URLS).join(', ')}`);
    process.exit(1);
  }

  const body = unescapeFilterValues(JSON.parse(fs.readFileSync(jsonFile, 'utf8')));
  const auth = await getAuth(serverKey);
  const endpoint = `/api/dashboards/${dashboardId}/widgets/${widgetId}`;

  try {
    const result = await apiPut(baseUrl, endpoint, auth, body);
    console.log(JSON.stringify({ id: result.id, chart_type: result.chart_type, filters_count: result.filters?.length }, null, 2));
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
}

main();
