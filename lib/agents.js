const fs = require("fs");
const path = require("path");

const AGENTS_DIR = path.join(__dirname, "..", "agents");
const AGENT_MARKER_BEGIN = "<!-- DR-LAUNCHER-AGENT:BEGIN -->";
const AGENT_MARKER_END = "<!-- DR-LAUNCHER-AGENT:END -->";
const AGENT_OWNED_FILE = ".agent-owned";

// --- Catalog ---

function loadCatalog() {
  if (!fs.existsSync(AGENTS_DIR)) return [];
  const entries = [];
  for (const name of fs.readdirSync(AGENTS_DIR)) {
    const dir = path.join(AGENTS_DIR, name);
    const manifestPath = path.join(dir, "manifest.json");
    if (!fs.statSync(dir).isDirectory()) continue;
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      entries.push({
        id: manifest.id,
        name: manifest.name,
        description: manifest.description,
        version: manifest.version,
        inputs: manifest.inputs || [],
      });
    } catch {
      // skip invalid manifests
    }
  }
  return entries;
}

function getAgent(agentId) {
  if (!agentId) return null;
  const dir = path.join(AGENTS_DIR, agentId);
  const manifestPath = path.join(dir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

function resolveAgentSource(manifest) {
  const agentDir = path.join(AGENTS_DIR, manifest.id);
  if (manifest.sourceType === "absolute") {
    return manifest.source;
  }
  return path.resolve(agentDir, manifest.source || ".");
}

// --- Validation ---

function validateAgentRequest(agentId, agentInputs) {
  const manifest = getAgent(agentId);
  if (!manifest) return { ok: false, error: `Unknown agent: ${agentId}` };

  const sourceDir = resolveAgentSource(manifest);
  if (!fs.existsSync(sourceDir)) {
    return { ok: false, error: `Agent source directory not found: ${sourceDir}` };
  }

  // Reject path traversal
  const agentDir = path.join(AGENTS_DIR, manifest.id);
  const resolved = path.resolve(agentDir, manifest.source || ".");
  if (!resolved.startsWith(path.resolve(AGENTS_DIR))) {
    return { ok: false, error: "Agent source path traversal rejected" };
  }

  // Check copyDirs exist
  if (manifest.copyDirs) {
    for (const srcRel of Object.keys(manifest.copyDirs)) {
      const srcPath = path.join(sourceDir, srcRel);
      if (!fs.existsSync(srcPath)) {
        return { ok: false, error: `Agent source subdirectory missing: ${srcRel}` };
      }
    }
  }

  // Check skills dir exists
  if (manifest.skills) {
    const skillsDir = path.join(sourceDir, manifest.skills);
    if (!fs.existsSync(skillsDir)) {
      return { ok: false, error: `Agent skills directory missing: ${manifest.skills}` };
    }
  }

  // Check prompt template exists
  if (manifest.promptTemplate) {
    const tmplPath = path.join(sourceDir, manifest.promptTemplate);
    if (!fs.existsSync(tmplPath)) {
      return { ok: false, error: `Prompt template missing: ${manifest.promptTemplate}` };
    }
  }

  // Check agent instructions file exists
  if (manifest.agentInstructions) {
    const instrPath = path.join(sourceDir, manifest.agentInstructions);
    if (!fs.existsSync(instrPath)) {
      return { ok: false, error: `Agent instructions missing: ${manifest.agentInstructions}` };
    }
  }

  // Validate initialPrompt if present
  if (manifest.initialPrompt && typeof manifest.initialPrompt !== "string") {
    return { ok: false, error: "initialPrompt must be a string" };
  }

  // Validate required inputs
  const inputs = manifest.inputs || [];
  const missing = [];
  for (const input of inputs) {
    if (input.required && (!agentInputs[input.key] || !String(agentInputs[input.key]).trim())) {
      missing.push(input.label || input.key);
    }
  }
  if (missing.length) {
    return { ok: false, error: `Missing required inputs: ${missing.join(", ")}` };
  }

  return { ok: true, agent: manifest };
}

// --- Template rendering ---

function renderTemplate(templateStr, inputs) {
  let result = templateStr.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, key, content) => {
    return inputs[key] && String(inputs[key]).trim() ? content : "";
  });
  result = result.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return inputs[key] != null ? String(inputs[key]) : "";
  });
  return result;
}

// --- Path rewriting ---

function rewritePaths(content, rewrites) {
  let result = content;
  for (const { from, to } of rewrites) {
    // Replace all slash variants of the source path with the target path
    const fromFwd = from.replace(/\\/g, "/");
    const fromBack = from.replace(/\//g, "\\");
    const toFwd = to.replace(/\\/g, "/");
    const toBack = to.replace(/\//g, "\\");
    result = result.split(fromFwd).join(toFwd);
    result = result.split(fromBack).join(toBack);
    // Original form (in case it mixes slashes)
    if (from !== fromFwd && from !== fromBack) {
      result = result.split(from).join(to);
    }
  }
  return result;
}

function rewriteObjectPaths(obj, rewrites) {
  if (typeof obj === "string") return rewritePaths(obj, rewrites);
  if (Array.isArray(obj)) return obj.map((v) => rewriteObjectPaths(v, rewrites));
  if (obj && typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = rewriteObjectPaths(v, rewrites);
    }
    return out;
  }
  return obj;
}

// Same as rewritePaths, but reports whether any replacement actually occurred.
// Used by scaffold internals to surface lingering legacy-rewrite activity
// (informational only — never blocks a launch). rewritePaths stays unchanged
// for backward compatibility with existing callers.
function rewritePathsVerbose(content, rewrites) {
  const result = rewritePaths(content, rewrites);
  return { content: result, matched: result !== content };
}

// --- Token expansion (preferred over pathRewrites) ---
//
// Agent source files use [[TOKEN]] placeholders (e.g. [[SCRIPTS_DIR]]) that are
// expanded to relative workspace paths at scaffold time. Tokens are derived from
// the manifest's copyDirs/createDirs so they are portable across machines and
// authors. The [[...]] delimiter is deliberately distinct from renderTemplate's
// {{...}} syntax (whose \w class would otherwise swallow {{SCRIPTS_DIR}}).

// Convert a manifest destination (e.g. ".agent/scripts") into a POSIX path with a
// trailing slash, rejecting anything that isn't a safe in-workspace relative path.
function normalizeTokenDest(name, dest) {
  if (/^[A-Za-z]:/.test(dest)) {
    throw new Error(`Token ${name} destination is a drive-letter path: ${dest}`);
  }
  if (/^\\\\/.test(dest)) {
    throw new Error(`Token ${name} destination is a UNC path: ${dest}`);
  }
  if (dest.startsWith("/")) {
    throw new Error(`Token ${name} destination must be relative: ${dest}`);
  }
  if (dest.split(/[\\/]/).includes("..")) {
    throw new Error(`Token ${name} destination must not contain '..': ${dest}`);
  }
  // Normalize to POSIX separators, strip trailing slashes, then add exactly one.
  return dest.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
}

function dirNameToToken(segment) {
  const cleaned = segment.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `${cleaned}_DIR`;
}

function buildTokenMap(manifest) {
  const map = {};

  const addToken = (name, dest) => {
    const token = `[[${name}]]`;
    const posix = normalizeTokenDest(name, dest);
    if (map[token] !== undefined && map[token] !== posix) {
      throw new Error(
        `Duplicate token ${token} maps to conflicting destinations: ${map[token]} vs ${posix}`
      );
    }
    map[token] = posix;
  };

  // Standard tokens — always present, regardless of manifest contents.
  addToken("AGENT_DIR", ".agent");
  addToken("CLAUDE_DIR", ".claude");
  addToken("SKILLS_DIR", ".claude/skills");

  // copyDirs: key (e.g. "scripts") → [[SCRIPTS_DIR]] → ".agent/scripts/"
  if (manifest.copyDirs) {
    for (const [key, dest] of Object.entries(manifest.copyDirs)) {
      addToken(dirNameToToken(key), dest);
    }
  }

  // createDirs: last segment (e.g. ".agent/specs") → [[SPECS_DIR]] → ".agent/specs/"
  if (manifest.createDirs) {
    for (const dir of manifest.createDirs) {
      const base = path.basename(dir.replace(/[\\/]+$/, ""));
      addToken(dirNameToToken(base), dir);
    }
  }

  return map;
}

function expandTokens(content, tokenMap) {
  if (!tokenMap) return content;
  return content.replace(/\[\[([A-Z][A-Z0-9_]*_DIR)\]\]/g, (match, name) => {
    const token = `[[${name}]]`;
    return Object.prototype.hasOwnProperty.call(tokenMap, token) ? tokenMap[token] : match;
  });
}

function expandObjectTokens(obj, tokenMap) {
  if (typeof obj === "string") return expandTokens(obj, tokenMap);
  if (Array.isArray(obj)) return obj.map((v) => expandObjectTokens(v, tokenMap));
  if (obj && typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = expandObjectTokens(v, tokenMap);
    }
    return out;
  }
  return obj;
}

// Apply the full text transform used everywhere in the scaffold pipeline:
// expand [[TOKEN]] placeholders first, then run any legacy pathRewrites.
// rewriteStats (optional) accumulates how often legacy rewrites still fire.
function transformText(content, rewrites, tokenMap, rewriteStats) {
  let out = expandTokens(content, tokenMap);
  if (rewrites && rewrites.length) {
    const { content: rewritten, matched } = rewritePathsVerbose(out, rewrites);
    out = rewritten;
    if (matched && rewriteStats) rewriteStats.matched++;
  }
  return out;
}

function isTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return [".md", ".json", ".ps1", ".js", ".txt", ".yaml", ".yml"].includes(ext);
}

// --- File copy helpers ---

function copyDirRecursive(src, dst, rewrites, tokenMap, rewriteStats) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, dstPath, rewrites, tokenMap, rewriteStats);
    } else {
      if (isTextFile(srcPath)) {
        const content = fs.readFileSync(srcPath, "utf8");
        fs.writeFileSync(dstPath, transformText(content, rewrites, tokenMap, rewriteStats), "utf8");
      } else {
        fs.copyFileSync(srcPath, dstPath);
      }
    }
  }
}

// --- Skill conversion ---

function convertSkills(sourceDir, manifest, workspacePath, rewrites, tokenMap, rewriteStats) {
  const skillsSourceDir = path.join(sourceDir, manifest.skills);
  const skillsTargetDir = path.join(workspacePath, ".claude", "skills");
  const descriptions = manifest.skillDescriptions || {};
  const converted = [];

  for (const file of fs.readdirSync(skillsSourceDir)) {
    if (!file.endsWith(".md")) continue;
    const skillName = file.replace(/\.md$/, "");
    const skillDir = path.join(skillsTargetDir, skillName);
    fs.mkdirSync(skillDir, { recursive: true });

    let content = fs.readFileSync(path.join(skillsSourceDir, file), "utf8");
    content = transformText(content, rewrites, tokenMap, rewriteStats);

    const description = descriptions[skillName] || extractFirstLine(content);
    const skillMd = `---\ndescription: "${description.replace(/"/g, '\\"')}"\n---\n\n${content}`;

    fs.writeFileSync(path.join(skillDir, "SKILL.md"), skillMd, "utf8");
    fs.writeFileSync(path.join(skillDir, AGENT_OWNED_FILE), "", "utf8");
    converted.push(skillName);
  }

  return converted;
}

function extractFirstLine(content) {
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.replace(/^#+\s*/, "").trim();
    if (trimmed && !trimmed.startsWith("---")) return trimmed;
  }
  return "Agent skill";
}

// --- Hook merging ---

function mergeHooks(workspacePath, sourceDir, manifest, rewrites, tokenMap, rewriteStats) {
  if (!manifest.hooks) return { merged: false };

  const settingsPath = path.join(workspacePath, ".claude", "settings.json");
  fs.mkdirSync(path.join(workspacePath, ".claude"), { recursive: true });

  // Read existing settings (or start fresh)
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    } catch {
      // Corrupt JSON — back up and start fresh
      const backupPath = settingsPath + `.corrupt.${Date.now()}`;
      fs.copyFileSync(settingsPath, backupPath);
      settings = {};
    }
  }

  // Remove existing dr-agent-owned hooks (idempotent cleanup)
  if (settings.hooks) {
    for (const event of Object.keys(settings.hooks)) {
      if (Array.isArray(settings.hooks[event])) {
        settings.hooks[event] = settings.hooks[event].filter((h) => h._owner !== "dr-agent");
      }
    }
  }

  // Read agent hook config
  const hookConfigPath = path.join(sourceDir, manifest.hooks.configFile);
  if (!fs.existsSync(hookConfigPath)) return { merged: false, error: "hook config not found" };

  let hookConfig = JSON.parse(fs.readFileSync(hookConfigPath, "utf8"));
  // Expand tokens then rewrite paths in the hook config (walk the object directly —
  // JSON.stringify double-escapes backslashes, breaking path matching)
  hookConfig = expandObjectTokens(hookConfig, tokenMap);
  if (rewrites && rewrites.length) {
    hookConfig = rewriteObjectPaths(hookConfig, rewrites);
  }

  // Merge agent hooks with _owner tag
  if (!settings.hooks) settings.hooks = {};
  for (const event of Object.keys(hookConfig.hooks || {})) {
    if (!settings.hooks[event]) settings.hooks[event] = [];
    for (const matcher of hookConfig.hooks[event]) {
      settings.hooks[event].push({ ...matcher, _owner: "dr-agent" });
    }
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");

  // Copy hook scripts with path rewriting
  if (manifest.hooks.scripts) {
    for (const scriptRel of manifest.hooks.scripts) {
      const scriptSrc = path.join(sourceDir, scriptRel);
      const scriptDst = path.join(workspacePath, ".claude", path.basename(scriptRel));
      if (fs.existsSync(scriptSrc)) {
        let content = fs.readFileSync(scriptSrc, "utf8");
        content = transformText(content, rewrites, tokenMap, rewriteStats);
        fs.writeFileSync(scriptDst, content, "utf8");
      }
    }
  }

  return { merged: true };
}

// --- CLAUDE.md agent block ---

function appendAgentBlock(workspacePath, manifest, skills) {
  const claudeMdPath = path.join(workspacePath, "CLAUDE.md");
  if (!fs.existsSync(claudeMdPath)) return;

  const skillList = skills.map((s) => `\`/${s}\``).join(", ");
  const block = [
    AGENT_MARKER_BEGIN,
    `## Agent Task`,
    ``,
    `This workspace has the **${manifest.name}** loaded.`,
    ``,
    `**Read these files before doing anything else:**`,
    `1. [AGENT_INSTRUCTIONS.md](./AGENT_INSTRUCTIONS.md) — agent workflow rules`,
    `2. [AGENT_TASK.md](./AGENT_TASK.md) — your specific task`,
    ``,
    `Skills are available as slash commands: ${skillList}`,
    `Reference docs: \`.agent/reference/\` | Scripts: \`.agent/scripts/\``,
    AGENT_MARKER_END,
  ].join("\n");

  let content = fs.readFileSync(claudeMdPath, "utf8");
  // Remove any existing agent block first
  content = removeAgentBlock(content);
  content = content.trimEnd() + "\n\n" + block + "\n";
  fs.writeFileSync(claudeMdPath, content, "utf8");
}

function removeAgentBlock(content) {
  const beginIdx = content.indexOf(AGENT_MARKER_BEGIN);
  const endIdx = content.indexOf(AGENT_MARKER_END);
  if (beginIdx === -1 || endIdx === -1) return content;
  const before = content.slice(0, beginIdx).trimEnd();
  const after = content.slice(endIdx + AGENT_MARKER_END.length);
  return before + after;
}

// --- Scaffold ---

function scaffoldAgent(agentId, workspacePath, agentInputs) {
  const manifest = getAgent(agentId);
  if (!manifest) throw new Error(`Agent not found: ${agentId}`);

  const sourceDir = resolveAgentSource(manifest);
  const rewrites = manifest.pathRewrites || [];
  const tokenMap = buildTokenMap(manifest);
  const rewriteStats = { matched: 0 };

  // 1. Copy directories (scripts, reference, schemas → .agent/)
  if (manifest.copyDirs) {
    for (const [srcRel, dstRel] of Object.entries(manifest.copyDirs)) {
      const srcPath = path.join(sourceDir, srcRel);
      const dstPath = path.join(workspacePath, dstRel);
      copyDirRecursive(srcPath, dstPath, rewrites, tokenMap, rewriteStats);
    }
  }

  // 2. Create empty output directories
  if (manifest.createDirs) {
    for (const dir of manifest.createDirs) {
      fs.mkdirSync(path.join(workspacePath, dir), { recursive: true });
    }
  }

  // 3. Convert skills to Claude Code format
  let convertedSkills = [];
  if (manifest.skills) {
    convertedSkills = convertSkills(sourceDir, manifest, workspacePath, rewrites, tokenMap, rewriteStats);
  }

  // 4. Copy agent instructions → AGENT_INSTRUCTIONS.md
  if (manifest.agentInstructions) {
    let instrContent = fs.readFileSync(path.join(sourceDir, manifest.agentInstructions), "utf8");
    instrContent = transformText(instrContent, rewrites, tokenMap, rewriteStats);
    fs.writeFileSync(path.join(workspacePath, "AGENT_INSTRUCTIONS.md"), instrContent, "utf8");
  }

  // 5. Merge hooks
  const hookResult = mergeHooks(workspacePath, sourceDir, manifest, rewrites, tokenMap, rewriteStats);

  // 6. Render prompt template → AGENT_TASK.md (render inputs first, then expand tokens)
  if (manifest.promptTemplate) {
    const templateStr = fs.readFileSync(path.join(sourceDir, manifest.promptTemplate), "utf8");
    let rendered = renderTemplate(templateStr, agentInputs || {});
    rendered = transformText(rendered, rewrites, tokenMap, rewriteStats);
    fs.writeFileSync(path.join(workspacePath, "AGENT_TASK.md"), rendered, "utf8");
  }

  // 7. Append agent pointer to CLAUDE.md
  appendAgentBlock(workspacePath, manifest, convertedSkills);

  // 8. Post-scaffold safety net — fail loudly (and clean up) if any agent-owned
  // output still contains an unexpanded token or a personal absolute path.
  const leaks = checkScaffoldLeaks(workspacePath);
  if (leaks.length) {
    clearAgentScaffold(workspacePath);
    const details = leaks.map((l) => `  ${l.file}:${l.line} [${l.pattern}] ${l.snippet}`).join("\n");
    throw new Error(`Scaffold contains leaked paths (${leaks.length}):\n${details}`);
  }

  return {
    skills: convertedSkills,
    hooks: hookResult,
    agentId: manifest.id,
    agentName: manifest.name,
    legacyRewrites: rewriteStats.matched,
    initialPrompt: manifest.initialPrompt
      ? expandTokens(manifest.initialPrompt, tokenMap)
      : undefined,
  };
}

// --- Cleanup ---

function clearAgentScaffold(workspacePath) {
  // 1. Remove agent block from CLAUDE.md
  const claudeMdPath = path.join(workspacePath, "CLAUDE.md");
  if (fs.existsSync(claudeMdPath)) {
    const content = fs.readFileSync(claudeMdPath, "utf8");
    const cleaned = removeAgentBlock(content);
    if (cleaned !== content) {
      fs.writeFileSync(claudeMdPath, cleaned, "utf8");
    }
  }

  // 2. Remove .agent/ directory
  const agentDir = path.join(workspacePath, ".agent");
  if (fs.existsSync(agentDir)) {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }

  // 3. Remove AGENT_TASK.md and AGENT_INSTRUCTIONS.md
  for (const file of ["AGENT_TASK.md", "AGENT_INSTRUCTIONS.md"]) {
    const filePath = path.join(workspacePath, file);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  // 4. Remove agent-owned hooks from .claude/settings.json
  const settingsPath = path.join(workspacePath, ".claude", "settings.json");
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      let changed = false;
      if (settings.hooks) {
        for (const event of Object.keys(settings.hooks)) {
          if (Array.isArray(settings.hooks[event])) {
            const before = settings.hooks[event].length;
            settings.hooks[event] = settings.hooks[event].filter((h) => h._owner !== "dr-agent");
            if (settings.hooks[event].length !== before) changed = true;
            if (settings.hooks[event].length === 0) {
              delete settings.hooks[event];
              changed = true;
            }
          }
        }
        if (Object.keys(settings.hooks).length === 0) {
          delete settings.hooks;
          changed = true;
        }
      }
      if (changed) {
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
      }
    } catch {
      // corrupt settings — leave it alone during cleanup
    }
  }

  // 5. Remove agent-owned hook scripts (check all manifests since we don't know which agent was active)
  for (const name of (fs.existsSync(AGENTS_DIR) ? fs.readdirSync(AGENTS_DIR) : [])) {
    const manifestPath = path.join(AGENTS_DIR, name, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (m.hooks?.scripts) {
        for (const scriptRel of m.hooks.scripts) {
          const scriptPath = path.join(workspacePath, ".claude", path.basename(scriptRel));
          if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);
        }
      }
    } catch { /* skip invalid manifests */ }
  }

  // 6. Remove agent-owned skills from .claude/skills/
  const skillsDir = path.join(workspacePath, ".claude", "skills");
  if (fs.existsSync(skillsDir)) {
    for (const name of fs.readdirSync(skillsDir)) {
      const skillDir = path.join(skillsDir, name);
      if (fs.statSync(skillDir).isDirectory()) {
        if (fs.existsSync(path.join(skillDir, AGENT_OWNED_FILE))) {
          fs.rmSync(skillDir, { recursive: true, force: true });
        }
      }
    }
  }
}

// --- Post-scaffold leak detection ---
//
// After a scaffold, no agent-owned output should contain an unexpanded [[TOKEN]]
// or a personal absolute path. These would silently break hooks/scripts on a
// teammate's machine. We scan ONLY agent-owned outputs — a customer's own files
// elsewhere in the workspace may legitimately contain absolute paths.
const LEAK_PATTERNS = [
  { name: "unexpanded-token", re: /\[\[[A-Z][A-Z0-9_]*_DIR\]\]/ },
  { name: "windows-user-path", re: /[A-Za-z]:\\Users\\/i },
  { name: "unix-user-path", re: /\/(?:Users|home)\/[^/\s]+\// },
];

function checkScaffoldLeaks(workspacePath) {
  const leaks = [];

  const scanFile = (filePath) => {
    if (!fs.existsSync(filePath) || !isTextFile(filePath)) return;
    let content;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      return;
    }
    const lines = content.split("\n");
    lines.forEach((line, idx) => {
      for (const { name, re } of LEAK_PATTERNS) {
        const m = line.match(re);
        if (m) {
          leaks.push({
            file: path.relative(workspacePath, filePath),
            line: idx + 1,
            pattern: name,
            snippet: m[0],
          });
          break; // one finding per line is enough
        }
      }
    });
  };

  const scanDir = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) scanDir(full);
      else scanFile(full);
    }
  };

  // Scan only dr-agent-owned hook matchers in a (user-shared) settings.json.
  const scanDrAgentHooks = (settingsPath) => {
    if (!fs.existsSync(settingsPath)) return;
    let raw, settings;
    try {
      raw = fs.readFileSync(settingsPath, "utf8");
      settings = JSON.parse(raw);
    } catch {
      return; // corrupt/missing — not our concern in a leak scan
    }
    if (!settings || typeof settings.hooks !== "object" || !settings.hooks) return;
    const rawLines = raw.split("\n");
    const relFile = path.relative(workspacePath, settingsPath);

    const collectStrings = (val, out) => {
      if (typeof val === "string") out.push(val);
      else if (Array.isArray(val)) val.forEach((v) => collectStrings(v, out));
      else if (val && typeof val === "object") Object.values(val).forEach((v) => collectStrings(v, out));
    };

    for (const event of Object.keys(settings.hooks)) {
      const arr = settings.hooks[event];
      if (!Array.isArray(arr)) continue;
      for (const matcher of arr) {
        if (!matcher || matcher._owner !== "dr-agent") continue;
        const strings = [];
        collectStrings(matcher, strings);
        for (const str of strings) {
          for (const { name, re } of LEAK_PATTERNS) {
            const m = str.match(re);
            if (m) {
              const idx = rawLines.findIndex((l) => l.includes(m[0]));
              leaks.push({ file: relFile, line: idx >= 0 ? idx + 1 : 1, pattern: name, snippet: m[0] });
              break; // one finding per string is enough
            }
          }
        }
      }
    }
  };

  // .agent/ — all text files recursively
  scanDir(path.join(workspacePath, ".agent"));

  // .claude/skills/ — only agent-owned skill directories
  const skillsDir = path.join(workspacePath, ".claude", "skills");
  if (fs.existsSync(skillsDir)) {
    for (const name of fs.readdirSync(skillsDir)) {
      const skillDir = path.join(skillsDir, name);
      if (
        fs.statSync(skillDir).isDirectory() &&
        fs.existsSync(path.join(skillDir, AGENT_OWNED_FILE))
      ) {
        scanDir(skillDir);
      }
    }
  }

  // Hook config + agent-owned hook scripts. We don't know which agent scaffolded
  // this workspace, so (like clearAgentScaffold) we consult every manifest's
  // declared hook scripts and scan those specific basenames — staying within
  // agent-owned files and never touching unrelated user content in .claude/.
  //
  // settings.json is shared with the user — full-file scanning would flag a
  // teammate's own hooks that legitimately carry absolute paths. Parse it and
  // scan ONLY the matchers we own (_owner === "dr-agent"). Walk the matcher
  // object's string values directly rather than re-serializing: JSON.stringify
  // double-escapes backslashes and would mask C:\Users\ paths.
  scanDrAgentHooks(path.join(workspacePath, ".claude", "settings.json"));
  for (const name of fs.existsSync(AGENTS_DIR) ? fs.readdirSync(AGENTS_DIR) : []) {
    const manifestPath = path.join(AGENTS_DIR, name, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      for (const scriptRel of m.hooks?.scripts || []) {
        scanFile(path.join(workspacePath, ".claude", path.basename(scriptRel)));
      }
    } catch {
      /* skip invalid manifests */
    }
  }

  // Top-level agent files
  scanFile(path.join(workspacePath, "AGENT_INSTRUCTIONS.md"));
  scanFile(path.join(workspacePath, "AGENT_TASK.md"));

  return leaks;
}

module.exports = {
  AGENTS_DIR,
  AGENT_MARKER_BEGIN,
  AGENT_MARKER_END,
  loadCatalog,
  getAgent,
  validateAgentRequest,
  scaffoldAgent,
  clearAgentScaffold,
  renderTemplate,
  rewritePaths,
  rewritePathsVerbose,
  rewriteObjectPaths,
  buildTokenMap,
  expandTokens,
  expandObjectTokens,
  checkScaffoldLeaks,
};
