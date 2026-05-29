# Overnight Remediation — Change Summary

Branch: `fix/overnight-findings` (off `master`; **master untouched**).
Executed per `OVERNIGHT_PLAN.md`. Every batch was gated with
`node --test tests/**/*.test.js` + `node scripts/lint-agent-paths.js` (both
green) and committed individually. Final state: **138 tests pass, 0 fail**,
lint clean, `node --check server.js` OK.

## Finding → commit map

| Finding | Commit | What changed |
|---|---|---|
| — (Phase 0) | `ef2c9d6` | `package.json` test script → full `tests/` suite |
| P1-1 | `f4cd7c7` | `build.ps1` stages `agents/`; prod SSO from `packaging/auth-config.prod.json`; `.gitignore`; `tests/package-contents.test.js` |
| P3-3 | `8d833ec` | `esc()` escapes quotes (pure fn); fallback `serverList` `host` fields; `.host` for URLs; `app.js` require-able; `tests/esc.test.js` |
| P1-3 + P2-1 | `925c760` | agent script canonical hosts; ESM→CJS (`grid-engine`, `api-put-widget`); `require.main` guards; `SERVER_URLS` exports; grid hook exit-code; `tests/server-registry.test.js` |
| P2-3 | `69ad782` | leak scan scopes to `_owner:"dr-agent"` hook matchers; `tests/agents.test.js` extended |
| P2-2 | `a7dc2b4` | `lib/path-safety.js` `isInsideRoot`; `cleanup.js` uses it; `tests/path-safety.test.js` |
| P1-2 | `ffba5bd` | `lib/launch-identity.js` `resolveLaunchIdentity`; `tests/launch-identity.test.js` |
| P3-2 | `7586984` | `lib/run-command.js` (no-shell `dr`); `dr-cli.js`/`auth.js` wired; `tests/run-command.test.js` + `tests/dr-cli.test.js` |
| P3-4 + P3-6 | `27fdd6e` | atomic `artifacts.js` write; README drift; `tests/sync.test.js` + `tests/auth-health.test.js` |
| P2-4 + P2-5 | `72492ca` | `lib/session-store.js` (sync, standalone); `sessions.js` refactor; `settings.js` migration; `reconcilePreviousRunSessions`; `tests/session-store.test.js` |
| P1-2/P2-2/P3-1/P3-5/P2-5 | `032e37e` | **server.js** (Phase C): identity wiring; `requireAuthenticated` on mutating routes + `Cache-Control: no-store`; open-folder pathsafe + `execFile`; busy-spin removed; reconcile at startup; `auth.isUserAuthorized`; `tests/auth.test.js` |

## New / changed files

- New libs: `lib/path-safety.js`, `lib/launch-identity.js`, `lib/run-command.js`, `lib/session-store.js`
- New tests: `package-contents`, `esc`, `server-registry`, `path-safety`, `launch-identity`, `run-command`, `dr-cli`, `sync`, `auth-health`, `session-store`, `auth` (+ `agents.test.js` extended)
- Changed: `server.js`, `lib/{auth,dr-cli,sessions,settings,cleanup,artifacts,agents}.js`, `public/app.js`, `packaging/build.ps1`, `agents/**/{api-put-widget,grid-engine,download-filebox}.js`, `agents/dashboard-agent/hooks/run-grid-engine.ps1`, `README.md`, `.gitignore`, `package.json`

## Notes / deviations (none skip a guardrail)

1. **Gate command.** The plan named `node --test tests/`, but a bare directory
   arg is **not** auto-expanded on the installed Node (v24.14.0) — it tries to
   load the dir as a module and fails. Used the equivalent scoped glob
   `node --test tests/**/*.test.js` (also set as `package.json` `"test"`),
   which works in every shell. Verified green before every commit.
2. **Datamapper validate hook** (`validate-mapper-spec.ps1`) already used
   `& node @args; exit $LASTEXITCODE` (no trailing pipeline), so it was already
   compliant with the P2-1 exit-code requirement — left unchanged. Only
   `run-grid-engine.ps1` needed the pipeline fix.
3. **`dr` resolves to no-shell node mode** on this machine
   (`…/dr-cli/dist/cli.js`); `runDr` verified end-to-end (`dr --version` →
   `0.2.57`). The `.cmd` shell fallback path exists but wasn't exercised here.
4. **Deferred (by design, per plan):** full frontend modular refactor +
   browser smoke; token→HttpOnly cookie; build-time agent map generation;
   aligning the MSAL redirect host to `127.0.0.1` (documented only).

## Morning smoke checklist (OS integration — can't be auto-verified)

Start the app (`node server.js`) and verify:

1. Launch a customer → Chrome + terminal + (optional) virtual desktop;
   `CLAUDE.md` shows the **correct server/host** (now canonical, not client-sent).
2. Restart the server with a live session → prior session **re-adopted** and
   still closable (reconcile, not cleared).
3. `/api/open-folder` opens a workspace; a `..`/sibling/symlink path is rejected.
4. Dashboard agent → grid hook renders (CJS runs on dev Node) and uses the
   **correct host for a UK/CA tenant**.
5. `npm.cmd run build -- -SkipInstaller -SkipCSharp` → `dist/app/agents/`
   present; prod SSO config is not the placeholder.
6. Frontend: all views/modals work; account-derived strings render escaped;
   mutating actions while signed out return 401.

> The network installer build (downloads Node) and a live server boot were
> **not** run overnight; `tests/package-contents.test.js` statically guards
> P1-1 and `node --check server.js` confirms server syntax.
