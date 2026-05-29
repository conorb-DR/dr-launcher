# DR Launcher — Overnight Remediation Plan (rev. 3)

## Context

Two principal-level reviews plus a 7-claim verification pass produced a centralized findings register (3×P1, 5×P2, 7×P3). This plan addresses them in one supervised-but-unattended overnight run. Two themes drive the work: **server identity has no single source of truth** (P1-2, P1-3) and **the agent subsystem is the least production-hardened** (P1-1, P1-3, P2-1, P2-3).

**Scope (reviewer-directed):** the **full frontend modular refactor is deferred to a separate daytime PR** with browser smoke coverage; overnight does only an in-place **XSS/`esc()` hardening pass**. Auth hardening = **gate every mutating route** (P3-1).

**Rev. 3 folds in a reviewer pass:** tested Windows command escaping (no overclaim), full mutating-route gating, `require.main` guards on *all* converted scripts, circular-dependency-safe + dedup-by-`sessionId` session migration, `host` added to the frontend fallback, symlink test that self-skips without privilege, and exit-code capture without a pipeline.

---

## Guardrails & conventions

- **Branch:** `fix/overnight-findings` off `master`. **Commit immediately after each batch's gate passes** (one rule — no end-of-run batching).
- **Test runner:** `package.json` `"test"` → `node --test tests/`. Run checks as `node --test tests/` and `node scripts/lint-agent-paths.js` — **never bare `npm`** (PowerShell execution-policy blocks the shim; use `npm.cmd`/`node`).
- **No new network/lockfile deps overnight.** No jsdom, no `npm install`.
- **`server.js` is single-owner**, edited only in Phase C, sequentially.
- **Atomic-write idiom** for all persistence (temp + `fs.renameSync`).
- **Test isolation:** FS-touching tests set `process.env.LOCALAPPDATA`/`USERPROFILE` to a temp dir **at the top of the file, before `require`** (paths captured at module load). `session-store` resolves its path **lazily at call time**. Most new tests are pure functions (no FS).

---

## Verification strategy

**Automated gate (green before every commit):** `node --test tests/` + `node scripts/lint-agent-paths.js`.

**New automated tests (mostly pure → satisfies P3-7):**
| Test file | Covers | FS? |
|---|---|---|
| `tests/launch-identity.test.js` | `resolveLaunchIdentity()` canonical host/id, throws on bad server, **flags** (not overrides) domain mismatch (P1-2) | no |
| `tests/server-registry.test.js` | `require`d `SERVER_URLS` from both scripts + `app.js` fallback **`.host`** == `BUNDLED_DEFAULTS`; spawns `node grid-engine.js <tmpspec> --json` → exit 0 (P1-3, P2-1) | tmp spec |
| `tests/run-command.test.js` | round-trips adversarial values (`& \| < > " % !`, spaces, `^`) through the **exact spawn form** (node-echo stand-in) → escaping holds on the running Node (P3-2) | spawns echo |
| `tests/path-safety.test.js` | `isInsideRoot()` rejects sibling-prefix, `..`, root-equality; symlink-escape case **self-skips if Windows blocks symlink creation** (P2-2) | tmp dir |
| `tests/session-store.test.js` | sync `update()` interleave-free; atomic write; `classifyReconcile()` (P2-4/P2-5) | tmp (lazy path) |
| `tests/auth.test.js` | `isUserAuthorized()` (P3-1) | no |
| `tests/sync.test.js`, `tests/auth-health.test.js`, `tests/dr-cli.test.js` | merge/classify/parse pure fns (P3-7) | no |
| `tests/esc.test.js` | `esc()` escapes `< > & " '` (P3-3) | no |
| `tests/package-contents.test.js` | `build.ps1 $dirsToCopy` includes `agents`,`lib`,`public` (P1-1 guard) | reads ps1 |
| `tests/agents.test.js` (extend) | leak scan ignores user-owned hook w/ abs path; still flags `_owner:"dr-agent"` (P2-3) | tmp |

**Manual smoke checklist (morning — OS integration can't be auto-verified):**
1. Launch a customer → Chrome + terminal + virtual desktop; CLAUDE.md shows correct server/host.
2. Restart server with a live session → prior session **re-adopted and still closable**.
3. `/api/open-folder` opens a workspace; `..`/sibling/symlink path rejected.
4. Dashboard agent → grid hook renders (CJS works on dev Node) and uses **correct host for a UK/CA tenant**.
5. `npm.cmd run build -- -SkipInstaller -SkipCSharp` → `dist/app/agents/` present; prod SSO config NOT a placeholder.
6. Frontend: all views/modals work; account-derived strings render escaped.

> Network installer build (downloads Node) is **not** run overnight; `package-contents.test.js` guards P1-1 statically.

---

## Work breakdown (every finding mapped)

### P1-1 — Packaging omits `agents/` · `BATCH PKG`
- `packaging/build.ps1`: add `"agents"` to `$dirsToCopy` (line 96).
- **auth-config:** remove from `$filesToCopy` (line 87). No placeholder (would set `isConfigured()`→false, disabling prod SSO). Copy packaging-owned `packaging/auth-config.prod.json` into `dist/app/auth-config.json` **only if it exists**; else ship none (absence → dev-login default).
- Add `packaging/auth-config.prod.json` to `.gitignore` (packaging-owned, secret-ish) + a one-line note in `build.ps1`/README that prod SSO config lives there.
- Pre-stage gate step: run `node --test tests/` + `node scripts/lint-agent-paths.js`; abort on failure.
- New `tests/package-contents.test.js`.

### P1-2 — `/api/launch` trusts client identity · `BATCH IDENTITY` (+ Phase C wiring)
- New `lib/launch-identity.js`: `resolveLaunchIdentity({ serverKey, email, orgDomain, orgId })` → validates via `servers.validateKey`; sets canonical `serverHost = servers.serverHost(key)` (**ignores client serverHost**) and `accountId = \`${key}:${email}\``; **preserves discovered `orgDomain`** and returns `domainMismatch` for logging — does **not** rewrite it. Throws on unknown server / malformed email.
- **Phase C:** `server.js /api/launch` uses its output for Chrome URL, CLAUDE.md, dup check, history, artifacts; logs a warning on `domainMismatch`.
- `tests/launch-identity.test.js`.

### P1-3 — Agent scripts hardcode wrong/divergent hosts · `BATCH AGENTS`
- Fix `SERVER_URLS` in `agents/dashboard-agent/scripts/api-put-widget.js` (line 28): `UK→ukapp`, `CA→caapp`, `TEST→testapp`, `DEMO→demoapp`.
- Fix `SERVER_URLS` in `agents/datamapper-agent/scripts/download-filebox.js` (line 19): `US→app`, `UK→ukapp`, `CA→caapp`, drop invented `EU`, add `DEV/DEV-1/TEST/DEMO`; fix false "mirrors dr-cli" comment.
- Add `module.exports = { SERVER_URLS }` to both host-map scripts, and `if (require.main === module) main()` guards to **all three converted scripts** (incl. `grid-engine.js`) so none execute on `require`.
- `tests/server-registry.test.js` enforces single-source-of-truth (scripts run as workspace copies and can't `require` the launcher `lib/` at runtime — the test is the guard).

### P2-1 — Dashboard ESM scripts fail on Node 18/20 · `BATCH AGENTS`
- Convert `grid-engine.js` + `api-put-widget.js` ESM→**CommonJS** (`import`→`require`; `export`→`module.exports`; drop `createRequire`, `require` directly at `api-put-widget.js:47`). Keep `.js` names → scaffold token-expansion + `lint:paths` still apply; **no skill/hook/manifest references change**. Add the `require.main` guard (see P1-3).
- Harden the hooks: run node **without a trailing pipeline** (`$out = node … 2>&1; $code = $LASTEXITCODE`) so `$LASTEXITCODE` reflects node (not `Out-String`), then surface non-zero instead of swallowing. Applies to `run-grid-engine.ps1` (line 10) + the datamapper validate hook.
- `server-registry.test.js` spawns the CJS script to confirm it runs.
- Note: bundled runtime is Node 22.15 (auto-detects ESM) → bug only bites dev Node 18/20; still fixed for portability.

### P2-2 — Path boundary + open-folder injection · `BATCH PATHSAFE` (+ Phase C wiring)
- New `lib/path-safety.js`: `isInsideRoot(candidate, root, { mustExist })`. Destructive callers (`mustExist:true`): resolve **both** sides with `fs.realpathSync.native` (defeats junction/symlink escape), containment via `path.relative` + segment check, **and reject `candidate === root`**; non-existent path → reject.
- `lib/cleanup.js`: replace `startsWith` in `purgeProfiles` (line 119) + `quarantineWorkspaces` (line 140) with `isInsideRoot(..., { mustExist:true })`.
- **Phase C:** `server.js /api/open-folder` (line 882) uses `isInsideRoot`; replaces `exec(\`explorer "${folderPath}"\`)` with `execFile("explorer", [folderPath])` (explorer.exe is a real exe).
- `tests/path-safety.test.js` (root-equality rejection; symlink-escape case **self-skips if Windows blocks symlink creation** — needs Developer Mode/admin).

### P2-3 — Leak scan over-scans `settings.json` · `BATCH LEAK`
- `lib/agents.js checkScaffoldLeaks` (line 684): stop full-file scanning. `JSON.parse`, walk `hooks[event]`, scan **only matchers with `_owner === "dr-agent"`**. Leave user hooks + other keys untouched. Agent-owned hook *scripts* (basename-scoped, lines 690-691) stay.
- Extend `tests/agents.test.js`: user hook w/ `C:\Users\...` not flagged; `_owner:"dr-agent"` leak still flagged.

### P2-4 + P2-5 — Sessions: separate store, concurrency, reconcile · `BATCH SESSIONS` (+ Phase C wiring)
- **Synchronous store (no async mutex).** New `lib/session-store.js` owns `sessions.json`; path resolved **lazily at call time**; requires neither `settings` nor `sessions` (standalone). API: `read()` (corrupt→backup→`[]`) and `update(fn)` — **fully synchronous** read-modify-write. Synchronous adjacency makes it interleave-free without a mutex; the lost-update bug only existed because `checkSessionHealth` awaited probes *between* read and write.
- Refactor `lib/sessions.js`: `registerSession`/`endSession`/`markSessionsEnded`/`pruneEndedSessions` route through `store.update` and **stay synchronous** → **every existing call site (`server.js:787`) unchanged**. `checkSessionHealth` stays async: probes first, then a **single sync `store.update` patching by `sessionId`** (never overwrites with a stale snapshot). All exports preserved.
- `lib/settings.js`: remove `activeSessions` from `DEFAULTS`; migration in `migrateIfNeeded` **`require`s `./session-store` only (not `./sessions` → no circular dep)** and **merges** legacy `activeSessions` into `sessions.json` **deduping by `sessionId`** (no overwrite if `sessions.json` exists), then deletes the key.
- Replace `clearPreviousRunSessions` with async `reconcilePreviousRunSessions()`: probe each persisted session, **re-adopt** living, mark confirmed-dead as ended. Pure `classifyReconcile(session, isAlive)` extracted for tests.
- **Phase C:** `server.js` startup (line 932) `await sessions.reconcilePreviousRunSessions()`.
- `tests/session-store.test.js`. Highest-risk batch → **isolated commit**.

### P3-1 — Gate every mutating route · Phase C (`server.js`) + helper
- `lib/auth.js`: add pure `isUserAuthorized(user)` → `!!user && (user.devMode || !user.tokenExpired)`; `isAuthenticated()` reuses it.
- `server.js`: `requireAuthenticated` middleware (`if (!isUserAuthorized(await auth.getCurrentUser())) → 401`); dev session satisfies it.
- **Gate all mutating endpoints:** `/api/launch`, `/api/cleanup/purge`, `/api/sessions/close`, `/api/sessions/force-close`, `/api/sessions/close-batch`, `/api/cli/install`, `/api/open-folder`, `/api/switch-desktop`, `/api/login` (dr-cli), `/api/settings` (POST), `/api/recents` (POST), `/api/sync`, `/api/sync/init`, `/api/refresh`, `/api/auth-health/check`.
- **Exempt** (pre-login / read-only): `/api/auth/login`, `/api/auth/logout`, `/api/auth/dev-login`, `GET /auth/callback`, all read-only GETs (`accounts`, `sessions`, `health`, `servers`, `logs`, `diagnostics`, `recents`, `settings`, `sync/status`, `agents`, `cli/version`), and SSE `/api/launch-stream`.
- Add `Cache-Control: no-store` to the `/` response (line 168).
- `tests/auth.test.js`.

### P3-2 — Command execution (Windows-correct, tested) · `BATCH EXEC`
- **`dr` is an npm global `.cmd` shim**, so `execFile("dr", …)` fails and `cmd /c` still parses metacharacters. New `lib/run-command.js` resolves the real `dr` path once (cached via `where dr`): prefer a `.exe`/JS entry and `execFile` it with **no shell**; fall back to the `.cmd` only when that's all there is, relying on **Node's post-CVE Windows arg escaping** (`spawn(cmd, args, { shell: true })`) rather than hand-rolled quoting. Update `lib/dr-cli.js` `execDr` (line 24) + `probeWhoami` (line 217).
- **No overclaim:** injection-safety is **proven empirically** by `tests/run-command.test.js`, which round-trips adversarial values through the *exact* spawn form (a `node -e` echo stand-in for `dr`) and asserts received argv == input on the running Node. `dr` inputs are also already validated (whitelisted keys, regex emails), so live risk is low — this is defense-in-depth.
- `lib/auth.js` browser open (line 85): `start` is a **cmd builtin** → `execFile("cmd.exe", ["/c","start","", authUrl])` (URL is MSAL-generated/trusted).
- Leave `workspace.launchTerminal` cmd-string building as-is (inherent `cmd /k`, server-controlled) with a comment.
- `tests/run-command.test.js` + `tests/dr-cli.test.js`.

### P3-3 — Frontend XSS / render-safety hardening (refactor deferred) · `BATCH FRONTEND-HARDEN`
- **In-place only.** Audit every `${…}` interpolation in `render*()`/templates in `public/app.js` for account/user-derived data; wrap unescaped values in `esc()` (line 932); harden `esc()` to also escape `'`.
- Add a `host` field to each fallback `serverList` entry (canonical hosts) and use `serverInfo(key).host` (not `.label`) wherever the browser builds a URL from the fallback — so `server-registry.test.js` compares hosts, not labels.
- `tests/esc.test.js` (pure). No jsdom, no new deps.
- **Deferred to a daytime PR:** full module split + state container + event delegation + browser smoke.

### P3-4 — `artifacts.js` non-atomic write · `BATCH MISC`
- `lib/artifacts.js saveArtifacts` (line 19) → temp + `renameSync`.

### P3-5 — Startup busy-spin · Phase C (`server.js`)
- `killPreviousServer` (line 61): drop the `while` busy-loop; return whether it killed; async startup `await`s a 1s timer only when a kill happened.

### P3-6 — Doc/registry drift · `BATCH DOCS`
- `README.md`: `launch-history.json`→`history.json`, `dr-launcher.log`→`logs/launcher.log`; add `agents.js`, `auth-health.js`, `sessions.json`; note the MSAL callback intentionally uses `localhost` while the app serves `127.0.0.1`; note `packaging/auth-config.prod.json`.

### P3-7 — Test coverage · the new test files above.

---

## Execution orchestration

> Lanes in a phase touch disjoint files. `server.js` and `package.json` are single-owner.

- **Phase 0:** branch; `package.json` `"test"` → `node --test tests/`.
- **Phase A (parallel):** `PKG`, `AGENTS` (P1-3+P2-1 scripts/hooks), `LEAK` (`agents.js`), `PATHSAFE` (`lib/path-safety.js`+`cleanup.js`), `IDENTITY` (`lib/launch-identity.js`), `EXEC` (`lib/run-command.js`+`dr-cli.js`+`auth.js`), `MISC` (`artifacts.js`), `FRONTEND-HARDEN` (`public/app.js`), `DOCS`, pure-fn tests.
- **Phase B (parallel, isolated commit):** `SESSIONS` (`lib/session-store.js`, `sessions.js`, `settings.js`).
- **Phase C (sequential, sole `server.js` editor):** IDENTITY wiring → open-folder+PATHSAFE → `requireAuthenticated` set + Cache-Control → busy-spin → `reconcilePreviousRunSessions` startup.
- **Phase D:** full gate; `CHANGES.md` + morning smoke checklist; confirm per-batch commits; optionally open a PR.

---

## Risk & rollback

- Highest risk isolated to `SESSIONS` (own commit, revertable). Frontend *rewrite* is deferred; the in-place `esc()` pass is low-risk + morning-smoke verified.
- `server.js` edits sequential and last; backend otherwise stable before they land.
- Network installer build deferred to morning; static `package-contents` test guards P1-1.
- All work on a feature branch; `master` untouched until merge.

## Deferred (not overnight, by design)

- **Full frontend modular refactor + browser smoke harness** (separate daytime PR).
- **Token → HttpOnly cookie** rework (chosen scope is route-gating).
- **Build-time generation** of agent server maps (correct-literals + consistency test instead).
- Aligning MSAL redirect host to `127.0.0.1` (needs Azure app-registration change) — documented only.
