const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const agents = require("../lib/agents");

let tmpDir;

function makeTmpDir() {
  const dir = path.join(os.tmpdir(), `dr-agent-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanDir(dir) {
  if (dir && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeMinimalInputs(manifest) {
  const inputs = {};
  for (const inp of manifest.inputs || []) {
    if (inp.required) {
      inputs[inp.key] = inp.options ? inp.options[0] : "test-value";
    }
  }
  return inputs;
}

describe("agents module", () => {
  describe("loadCatalog", () => {
    it("returns valid agents from agents/ directory", () => {
      const catalog = agents.loadCatalog();
      assert.ok(Array.isArray(catalog));
      assert.ok(catalog.length >= 2, "should have at least dashboard-agent and datamapper-agent");
      for (const entry of catalog) {
        assert.ok(entry.id, `agent must have id`);
        assert.ok(entry.name, `${entry.id} must have name`);
        assert.ok(Array.isArray(entry.inputs), `${entry.id} must have inputs array`);
      }
    });

    it("includes both dashboard-agent and datamapper-agent", () => {
      const catalog = agents.loadCatalog();
      const ids = catalog.map((a) => a.id);
      assert.ok(ids.includes("dashboard-agent"), "catalog should contain dashboard-agent");
      assert.ok(ids.includes("datamapper-agent"), "catalog should contain datamapper-agent");
    });
  });

  describe("getAgent", () => {
    it("returns manifest for each cataloged agent", () => {
      const catalog = agents.loadCatalog();
      for (const entry of catalog) {
        const m = agents.getAgent(entry.id);
        assert.ok(m, `getAgent should return manifest for ${entry.id}`);
        assert.equal(m.id, entry.id);
        assert.ok(m.copyDirs, `${entry.id} should have copyDirs`);
        assert.ok(m.skills, `${entry.id} should have skills`);
      }
    });

    it("returns null for unknown agent", () => {
      assert.equal(agents.getAgent("nonexistent-agent"), null);
    });

    it("returns null for null/undefined", () => {
      assert.equal(agents.getAgent(null), null);
      assert.equal(agents.getAgent(undefined), null);
    });
  });

  describe("validateAgentRequest (all agents)", () => {
    it("validates valid request for each agent", () => {
      const catalog = agents.loadCatalog();
      for (const entry of catalog) {
        const manifest = agents.getAgent(entry.id);
        const inputs = makeMinimalInputs(manifest);
        const result = agents.validateAgentRequest(entry.id, inputs);
        assert.ok(result.ok, `validateAgentRequest should pass for ${entry.id}: ${result.error || ""}`);
        assert.ok(result.agent, `should return agent manifest for ${entry.id}`);
      }
    });

    it("rejects unknown agent", () => {
      const result = agents.validateAgentRequest("fake-agent", {});
      assert.equal(result.ok, false);
      assert.match(result.error, /Unknown agent/);
    });

    it("rejects missing required inputs for each agent", () => {
      const catalog = agents.loadCatalog();
      for (const entry of catalog) {
        const manifest = agents.getAgent(entry.id);
        const hasRequired = (manifest.inputs || []).some((i) => i.required);
        if (!hasRequired) continue;
        const result = agents.validateAgentRequest(entry.id, {});
        assert.equal(result.ok, false, `${entry.id} should reject empty inputs when it has required fields`);
        assert.match(result.error, /Missing required/);
      }
    });

    it("accepts when only optional inputs are missing", () => {
      const catalog = agents.loadCatalog();
      for (const entry of catalog) {
        const manifest = agents.getAgent(entry.id);
        const inputs = makeMinimalInputs(manifest);
        const result = agents.validateAgentRequest(entry.id, inputs);
        assert.ok(result.ok, `${entry.id} should accept with only required inputs filled`);
      }
    });

    it("validates initialPrompt field in manifests", () => {
      const catalog = agents.loadCatalog();
      for (const entry of catalog) {
        const manifest = agents.getAgent(entry.id);
        if (manifest.initialPrompt !== undefined) {
          assert.equal(typeof manifest.initialPrompt, "string", `${entry.id} initialPrompt must be a string`);
          assert.ok(manifest.initialPrompt.length > 0, `${entry.id} initialPrompt must not be empty`);
        }
      }
    });
  });

  describe("renderTemplate", () => {
    it("replaces simple placeholders", () => {
      const result = agents.renderTemplate("Hello {{name}}, task: {{task}}", {
        name: "Alice",
        task: "Build",
      });
      assert.equal(result, "Hello Alice, task: Build");
    });

    it("handles conditional blocks", () => {
      const tmpl = "Start{{#extra}}\nExtra: {{extra}}{{/extra}}\nEnd";
      assert.equal(
        agents.renderTemplate(tmpl, { extra: "yes" }),
        "Start\nExtra: yes\nEnd"
      );
      assert.equal(agents.renderTemplate(tmpl, {}), "Start\nEnd");
      assert.equal(agents.renderTemplate(tmpl, { extra: "" }), "Start\nEnd");
    });

    it("replaces missing keys with empty string", () => {
      assert.equal(agents.renderTemplate("{{missing}}", {}), "");
    });
  });

  describe("rewritePaths", () => {
    it("replaces forward-slash paths with relative ones", () => {
      const content = 'node "C:/Users/ConorBarnett/AI Project/Dashboard-Agent/scripts/grid-engine.js"';
      const rewrites = [
        { from: "C:\\Users\\ConorBarnett\\AI Project\\Dashboard-Agent\\scripts\\", to: ".agent/scripts/" },
      ];
      const result = agents.rewritePaths(content, rewrites);
      assert.ok(result.includes(".agent/scripts/grid-engine.js"), "Expected relative path in result");
    });

    it("replaces backslash paths read from real files", () => {
      const content = JSON.parse('"node \\"C:\\\\Users\\\\Test\\\\scripts\\\\grid-engine.js\\""');
      const rewrites = JSON.parse('[{"from":"C:\\\\Users\\\\Test\\\\scripts\\\\","to":".agent/scripts/"}]');
      const result = agents.rewritePaths(content, rewrites);
      assert.ok(
        result.includes(".agent\\scripts\\grid-engine.js") || result.includes(".agent/scripts/grid-engine.js"),
        "Expected relative path (either slash style) in result"
      );
      assert.ok(!result.includes("C:\\Users\\Test"), "Should not contain original path");
    });
  });

  describe("rewriteObjectPaths", () => {
    it("rewrites backslash paths inside a parsed object (JSON double-escape bug)", () => {
      const hookConfig = {
        hooks: {
          PostToolUse: [
            {
              matcher: "Write|Edit",
              command: 'powershell -File "C:\\Users\\ConorBarnett\\AI Project\\Dashboard-Agent\\.claude\\validate.ps1"',
            },
          ],
        },
      };
      const rewrites = [
        { from: "C:\\Users\\ConorBarnett\\AI Project\\Dashboard-Agent\\", to: "" },
      ];
      const result = agents.rewriteObjectPaths(hookConfig, rewrites);
      const cmd = result.hooks.PostToolUse[0].command;
      assert.ok(!cmd.includes("C:\\Users"), `Should not contain absolute path, got: ${cmd}`);
      assert.ok(cmd.includes(".claude\\validate.ps1") || cmd.includes(".claude/validate.ps1"));
    });

    it("preserves non-string values", () => {
      const obj = { count: 42, flag: true, nested: { n: null, arr: [1, "hello"] } };
      const result = agents.rewriteObjectPaths(obj, [{ from: "x", to: "y" }]);
      assert.equal(result.count, 42);
      assert.equal(result.flag, true);
      assert.equal(result.nested.n, null);
      assert.deepEqual(result.nested.arr, [1, "hello"]);
    });
  });

  describe("rewritePathsVerbose", () => {
    it("returns matched:true when a replacement occurs", () => {
      const rewrites = [{ from: "C:\\Users\\Test\\", to: ".agent/" }];
      const r = agents.rewritePathsVerbose("node C:\\Users\\Test\\x.js", rewrites);
      assert.equal(r.matched, true);
      assert.ok(!r.content.includes("C:\\Users\\Test"));
    });

    it("returns matched:false when content is unchanged", () => {
      const r = agents.rewritePathsVerbose("nothing to rewrite here", [{ from: "X:\\", to: "y/" }]);
      assert.equal(r.matched, false);
      assert.equal(r.content, "nothing to rewrite here");
    });

    it("rewritePaths (original) still returns a plain string (backward compat)", () => {
      const out = agents.rewritePaths("hello", [{ from: "a", to: "b" }]);
      assert.equal(typeof out, "string");
    });
  });

  describe("buildTokenMap", () => {
    it("produces standard AGENT_DIR, CLAUDE_DIR, and SKILLS_DIR", () => {
      const map = agents.buildTokenMap({});
      assert.equal(map["[[AGENT_DIR]]"], ".agent/");
      assert.equal(map["[[CLAUDE_DIR]]"], ".claude/");
      assert.equal(map["[[SKILLS_DIR]]"], ".claude/skills/");
    });

    it("returns standard tokens even for a minimal manifest", () => {
      const map = agents.buildTokenMap({ id: "x", name: "X" });
      assert.ok(map["[[AGENT_DIR]]"]);
      assert.ok(map["[[CLAUDE_DIR]]"]);
      assert.ok(map["[[SKILLS_DIR]]"]);
    });

    it("derives tokens from copyDirs keys (POSIX-normalized, trailing slash)", () => {
      const map = agents.buildTokenMap({ copyDirs: { scripts: ".agent\\scripts", reference: ".agent/reference" } });
      assert.equal(map["[[SCRIPTS_DIR]]"], ".agent/scripts/");
      assert.equal(map["[[REFERENCE_DIR]]"], ".agent/reference/");
    });

    it("derives tokens from createDirs path basenames", () => {
      const map = agents.buildTokenMap({ createDirs: [".agent/specs", ".agent/tmp"] });
      assert.equal(map["[[SPECS_DIR]]"], ".agent/specs/");
      assert.equal(map["[[TMP_DIR]]"], ".agent/tmp/");
    });

    it("ensures every value ends in a single trailing slash", () => {
      const map = agents.buildTokenMap({ copyDirs: { scripts: ".agent/scripts//" } });
      assert.equal(map["[[SCRIPTS_DIR]]"], ".agent/scripts/");
    });

    it("throws on a drive-letter (absolute) destination", () => {
      assert.throws(() => agents.buildTokenMap({ copyDirs: { scripts: "C:\\Users\\x\\scripts" } }));
    });

    it("throws on a destination containing ..", () => {
      assert.throws(() => agents.buildTokenMap({ copyDirs: { scripts: "../escape/scripts" } }));
    });

    it("throws on a leading-slash (absolute) destination", () => {
      assert.throws(() => agents.buildTokenMap({ createDirs: ["/etc/specs"] }));
    });

    it("throws when two destinations produce the same token name", () => {
      assert.throws(() => agents.buildTokenMap({ createDirs: [".agent/specs", ".other/specs"] }));
    });
  });

  describe("expandTokens", () => {
    const map = { "[[SCRIPTS_DIR]]": ".agent/scripts/", "[[CLAUDE_DIR]]": ".claude/" };

    it("replaces known tokens", () => {
      assert.equal(agents.expandTokens("node [[SCRIPTS_DIR]]x.js", map), "node .agent/scripts/x.js");
    });

    it("leaves unknown tokens unchanged", () => {
      assert.equal(agents.expandTokens("[[UNKNOWN_DIR]]y", map), "[[UNKNOWN_DIR]]y");
    });

    it("handles multiple and adjacent tokens", () => {
      assert.equal(agents.expandTokens("[[CLAUDE_DIR]][[SCRIPTS_DIR]]", map), ".claude/.agent/scripts/");
    });

    it("does not interfere with {{template}} syntax", () => {
      assert.equal(agents.expandTokens("{{SCRIPTS_DIR}} stays", map), "{{SCRIPTS_DIR}} stays");
    });

    it("handles content with no tokens", () => {
      assert.equal(agents.expandTokens("plain text", map), "plain text");
    });
  });

  describe("expandObjectTokens", () => {
    const map = { "[[CLAUDE_DIR]]": ".claude/" };

    it("expands tokens in nested object string values", () => {
      const out = agents.expandObjectTokens({ a: { cmd: "run [[CLAUDE_DIR]]h.ps1" } }, map);
      assert.equal(out.a.cmd, "run .claude/h.ps1");
    });

    it("preserves non-string values", () => {
      const out = agents.expandObjectTokens({ n: 1, b: true, z: null }, map);
      assert.equal(out.n, 1);
      assert.equal(out.b, true);
      assert.equal(out.z, null);
    });

    it("expands tokens in arrays", () => {
      const out = agents.expandObjectTokens(["[[CLAUDE_DIR]]a", "[[CLAUDE_DIR]]b"], map);
      assert.deepEqual(out, [".claude/a", ".claude/b"]);
    });
  });

  describe("checkScaffoldLeaks (patterns via temp workspace)", () => {
    const tmpDirs = [];
    after(() => tmpDirs.forEach(cleanDir));

    function workspaceWith(agentFileContent) {
      const dir = makeTmpDir();
      tmpDirs.push(dir);
      fs.mkdirSync(path.join(dir, ".agent", "scripts"), { recursive: true });
      fs.writeFileSync(path.join(dir, ".agent", "scripts", "probe.md"), agentFileContent, "utf8");
      return dir;
    }

    it("detects a Windows personal path", () => {
      const leaks = agents.checkScaffoldLeaks(workspaceWith("see C:\\Users\\ConorBarnett\\x"));
      assert.ok(leaks.some((l) => l.pattern === "windows-user-path"));
    });

    it("detects a Windows personal path case-insensitively", () => {
      const leaks = agents.checkScaffoldLeaks(workspaceWith("c:\\users\\test\\y"));
      assert.ok(leaks.some((l) => l.pattern === "windows-user-path"));
    });

    it("detects a macOS personal path", () => {
      const leaks = agents.checkScaffoldLeaks(workspaceWith("/Users/conor/path"));
      assert.ok(leaks.some((l) => l.pattern === "unix-user-path"));
    });

    it("detects a Linux personal path", () => {
      const leaks = agents.checkScaffoldLeaks(workspaceWith("/home/conor/path"));
      assert.ok(leaks.some((l) => l.pattern === "unix-user-path"));
    });

    it("detects an unexpanded token", () => {
      const leaks = agents.checkScaffoldLeaks(workspaceWith("node [[SCRIPTS_DIR]]x.js"));
      assert.ok(leaks.some((l) => l.pattern === "unexpanded-token"));
    });

    it("does NOT flag legitimate relative paths", () => {
      const leaks = agents.checkScaffoldLeaks(workspaceWith("node .agent/scripts/x.js and .claude/ and Users/guide.md"));
      assert.deepEqual(leaks, []);
    });

    function workspaceWithSettings(settingsObj) {
      const dir = makeTmpDir();
      tmpDirs.push(dir);
      fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, ".claude", "settings.json"),
        JSON.stringify(settingsObj, null, 2),
        "utf8"
      );
      return dir;
    }

    it("does NOT flag a user-owned hook with an absolute path (P2-3)", () => {
      // A teammate's own hook legitimately carries an absolute path. It has no
      // _owner tag, so the leak scan must leave it alone.
      const dir = workspaceWithSettings({
        hooks: {
          PostToolUse: [
            { matcher: "Write", hooks: [{ type: "command", command: "node C:\\Users\\someone\\my-hook.js" }] },
          ],
        },
      });
      const leaks = agents.checkScaffoldLeaks(dir);
      assert.deepEqual(leaks, [], "user-owned hook with abs path must not be flagged");
    });

    it("still flags a dr-agent-owned hook leak (P2-3)", () => {
      const dir = workspaceWithSettings({
        hooks: {
          PostToolUse: [
            { matcher: "Write", _owner: "dr-agent", hooks: [{ type: "command", command: "node C:\\Users\\someone\\leaked.js" }] },
          ],
        },
      });
      const leaks = agents.checkScaffoldLeaks(dir);
      assert.ok(
        leaks.some((l) => l.pattern === "windows-user-path"),
        "dr-agent-owned hook leak should still be flagged"
      );
    });

    it("flags an unexpanded token in a dr-agent hook but not in a sibling user hook (P2-3)", () => {
      const dir = workspaceWithSettings({
        hooks: {
          PostToolUse: [
            { matcher: "Write", hooks: [{ type: "command", command: "node /Users/someone/user.js" }] },
            { matcher: "Edit", _owner: "dr-agent", hooks: [{ type: "command", command: "node [[SCRIPTS_DIR]]x.js" }] },
          ],
        },
      });
      const leaks = agents.checkScaffoldLeaks(dir);
      assert.ok(leaks.some((l) => l.pattern === "unexpanded-token"), "agent token leak flagged");
      assert.ok(!leaks.some((l) => l.pattern === "unix-user-path"), "user hook path not flagged");
    });

    it("scans agent-owned hook scripts under .claude/", () => {
      // Plant a leaked token in a known declared hook script basename.
      const dir = makeTmpDir();
      tmpDirs.push(dir);
      const scripts = agents
        .loadCatalog()
        .map((a) => agents.getAgent(a.id))
        .flatMap((m) => m.hooks?.scripts || []);
      assert.ok(scripts.length > 0, "expected at least one declared hook script");
      const basename = require("path").basename(scripts[0]);
      fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(dir, ".claude", basename), "node [[SCRIPTS_DIR]]x.js", "utf8");
      const leaks = agents.checkScaffoldLeaks(dir);
      assert.ok(
        leaks.some((l) => l.pattern === "unexpanded-token"),
        "should flag an unexpanded token in a hook script"
      );
    });
  });

  describe("scaffoldAgent + clearAgentScaffold (all agents)", () => {
    const catalog = agents.loadCatalog();
    const tmpDirs = [];

    after(() => tmpDirs.forEach(cleanDir));

    for (const entry of catalog) {
      const manifest = agents.getAgent(entry.id);
      const minInputs = makeMinimalInputs(manifest);

      describe(`[${entry.id}]`, () => {
        let dir;
        beforeEach(() => {
          dir = makeTmpDir();
          tmpDirs.push(dir);
          fs.writeFileSync(
            path.join(dir, "CLAUDE.md"),
            "<!-- DR-LAUNCHER:BEGIN -->\n# Customer\n<!-- DR-LAUNCHER:END -->\n\n## Custom Instructions\n",
            "utf8"
          );
        });

        it("creates full workspace structure", () => {
          const result = agents.scaffoldAgent(entry.id, dir, minInputs);

          assert.ok(result.skills.length > 0, "should convert skills");
          assert.ok(result.skills.includes(entry.id), `should include entry-point skill ${entry.id}`);

          // Check .agent directories exist for each copyDir target
          for (const dstRel of Object.values(manifest.copyDirs || {})) {
            assert.ok(fs.existsSync(path.join(dir, dstRel)), `${dstRel} should exist`);
          }

          // Check createDirs
          for (const d of manifest.createDirs || []) {
            assert.ok(fs.existsSync(path.join(dir, d)), `created dir ${d} should exist`);
          }

          // Check AGENT_TASK.md rendered
          assert.ok(fs.existsSync(path.join(dir, "AGENT_TASK.md")), "AGENT_TASK.md should exist");

          // Check AGENT_INSTRUCTIONS.md
          assert.ok(fs.existsSync(path.join(dir, "AGENT_INSTRUCTIONS.md")), "AGENT_INSTRUCTIONS.md should exist");

          // Check skills converted to SKILL.md format
          const skillPath = path.join(dir, ".claude", "skills", entry.id, "SKILL.md");
          assert.ok(fs.existsSync(skillPath), `entry-point skill SKILL.md should exist at ${skillPath}`);
          const skillContent = fs.readFileSync(skillPath, "utf8");
          assert.ok(skillContent.startsWith("---\n"), "should have YAML frontmatter");
          assert.ok(skillContent.includes("description:"));

          // Check .agent-owned markers
          assert.ok(fs.existsSync(path.join(dir, ".claude", "skills", entry.id, ".agent-owned")));

          // Check CLAUDE.md has agent block
          const claudeMd = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
          assert.ok(claudeMd.includes("DR-LAUNCHER-AGENT:BEGIN"));
          assert.ok(claudeMd.includes(manifest.name));
        });

        it("hook merge is idempotent", () => {
          agents.scaffoldAgent(entry.id, dir, minInputs);
          agents.scaffoldAgent(entry.id, dir, minInputs);

          const settings = JSON.parse(
            fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8")
          );
          const postToolUse = settings.hooks?.PostToolUse || [];
          const agentHooks = postToolUse.filter((h) => h._owner === "dr-agent");
          assert.equal(agentHooks.length, 1, "should not duplicate hooks");
        });

        it("clearAgentScaffold removes all agent state", () => {
          agents.scaffoldAgent(entry.id, dir, minInputs);

          assert.ok(fs.existsSync(path.join(dir, ".agent")));
          assert.ok(fs.existsSync(path.join(dir, "AGENT_TASK.md")));

          agents.clearAgentScaffold(dir);

          assert.ok(!fs.existsSync(path.join(dir, ".agent")), ".agent/ should be removed");
          assert.ok(!fs.existsSync(path.join(dir, "AGENT_TASK.md")), "AGENT_TASK.md should be removed");
          assert.ok(!fs.existsSync(path.join(dir, "AGENT_INSTRUCTIONS.md")), "AGENT_INSTRUCTIONS.md should be removed");

          // All agent-owned skills removed
          for (const skillName of (agents.scaffoldAgent(entry.id, makeTmpDir(), minInputs).skills)) {
            // (We can't check skills from the cleaned workspace since they're gone, but verify no .agent-owned dirs remain)
          }
          const skillsDir = path.join(dir, ".claude", "skills");
          if (fs.existsSync(skillsDir)) {
            for (const name of fs.readdirSync(skillsDir)) {
              const sd = path.join(skillsDir, name);
              if (fs.statSync(sd).isDirectory()) {
                assert.ok(
                  !fs.existsSync(path.join(sd, ".agent-owned")),
                  `skill ${name} should not have .agent-owned marker after cleanup`
                );
              }
            }
          }

          const claudeMd = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
          assert.ok(!claudeMd.includes("DR-LAUNCHER-AGENT:BEGIN"), "agent block should be removed from CLAUDE.md");

          // Hook scripts should be removed
          if (manifest.hooks?.scripts) {
            for (const scriptRel of manifest.hooks.scripts) {
              const scriptPath = path.join(dir, ".claude", path.basename(scriptRel));
              assert.ok(!fs.existsSync(scriptPath), `hook script ${path.basename(scriptRel)} should be removed`);
            }
          }
        });

        it("clearAgentScaffold preserves user files", () => {
          fs.writeFileSync(path.join(dir, "notes.txt"), "user notes", "utf8");
          fs.mkdirSync(path.join(dir, ".claude", "skills", "my-custom-skill"), { recursive: true });
          fs.writeFileSync(
            path.join(dir, ".claude", "skills", "my-custom-skill", "SKILL.md"),
            "my skill",
            "utf8"
          );

          agents.scaffoldAgent(entry.id, dir, minInputs);
          agents.clearAgentScaffold(dir);

          assert.ok(fs.existsSync(path.join(dir, "notes.txt")), "user files preserved");
          assert.ok(
            fs.existsSync(path.join(dir, ".claude", "skills", "my-custom-skill", "SKILL.md")),
            "user skills preserved"
          );
        });

        const TOKEN_RE = /\[\[[A-Z][A-Z0-9_]*_DIR\]\]/;
        const PERSONAL_RE = /[A-Za-z]:\\Users\\|\/Users\/[^/\s]+\/|\/home\/[^/\s]+\//;

        it("scaffolded output contains no leaked paths", () => {
          // scaffoldAgent throws on leaks; an explicit check documents the contract.
          const result = agents.scaffoldAgent(entry.id, dir, minInputs);
          assert.deepEqual(agents.checkScaffoldLeaks(dir), [], "no leaked paths expected");
          assert.equal(result.legacyRewrites, 0, "no legacy pathRewrites should fire after migration");
        });

        it("AGENT_TASK.md has no unexpanded tokens", () => {
          agents.scaffoldAgent(entry.id, dir, minInputs);
          const taskMd = fs.readFileSync(path.join(dir, "AGENT_TASK.md"), "utf8");
          assert.ok(!TOKEN_RE.test(taskMd), "AGENT_TASK.md should not contain unexpanded tokens");
        });

        it("AGENT_INSTRUCTIONS.md has no unexpanded tokens or personal paths", () => {
          agents.scaffoldAgent(entry.id, dir, minInputs);
          const instr = fs.readFileSync(path.join(dir, "AGENT_INSTRUCTIONS.md"), "utf8");
          assert.ok(!TOKEN_RE.test(instr), "no unexpanded tokens");
          assert.ok(!PERSONAL_RE.test(instr), "no personal absolute paths");
        });

        it("converted skills have no unexpanded tokens or personal paths", () => {
          agents.scaffoldAgent(entry.id, dir, minInputs);
          const skillsDir = path.join(dir, ".claude", "skills");
          for (const name of fs.readdirSync(skillsDir)) {
            const skillMd = path.join(skillsDir, name, "SKILL.md");
            if (!fs.existsSync(skillMd)) continue;
            const content = fs.readFileSync(skillMd, "utf8");
            assert.ok(!TOKEN_RE.test(content), `skill ${name} should have no unexpanded tokens`);
            assert.ok(!PERSONAL_RE.test(content), `skill ${name} should have no personal paths`);
          }
        });

        it("hook command paths are relative (no personal paths)", () => {
          agents.scaffoldAgent(entry.id, dir, minInputs);
          const settingsPath = path.join(dir, ".claude", "settings.json");
          if (!fs.existsSync(settingsPath)) return;
          const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
          const hooks = settings.hooks?.PostToolUse || [];
          for (const matcher of hooks) {
            for (const h of matcher.hooks || []) {
              if (!h.command) continue;
              assert.ok(!TOKEN_RE.test(h.command), `hook command should have no unexpanded tokens: ${h.command}`);
              assert.ok(!PERSONAL_RE.test(h.command), `hook command should be relative: ${h.command}`);
            }
          }
        });

        it("returned initialPrompt has tokens expanded", () => {
          const result = agents.scaffoldAgent(entry.id, dir, minInputs);
          if (result.initialPrompt) {
            assert.ok(!TOKEN_RE.test(result.initialPrompt), "initialPrompt should not contain unexpanded tokens");
          }
        });
      });
    }

    it("clearAgentScaffold is safe on clean workspace", () => {
      const dir = makeTmpDir();
      tmpDirs.push(dir);
      fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# Test\n", "utf8");
      agents.clearAgentScaffold(dir);
    });
  });
});
