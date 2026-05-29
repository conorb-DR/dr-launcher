#!/usr/bin/env node
/**
 * Datamapper spec pre-flight validation
 *
 * Usage:
 *   node validate-spec.js <spec.json> [<template.json>] [<formula-functions.json>] [--server US2]
 *
 * Returns exit code 0 if all checks pass, 1 if any ❌ finding, 2 if missing inputs.
 *
 * Checks performed (mirrors /datamapper-plan):
 *   1. Schema-bootstrap diff (Bug 2) — new map_to names vs template fields
 *   2. Calc-name vs header-map_to collision (Bug 4)
 *   3. Dimension → Date type check (Bug 3)
 *   4. Formula syntax sweep (PascalCase, ==, resolved [refs], single-arg EOMONTH, no prose literals)
 *   5. Required body fields
 *   6. US2 quote-char in string literal (Bug 6) — warn only when --server US2
 */

const fs = require("fs");

const args = process.argv.slice(2);
const specPath = args[0];
const templatePath = args[1];
const functionsPath = args[2];
const serverIdx = args.indexOf("--server");
const server = serverIdx >= 0 ? args[serverIdx + 1] : null;

if (!specPath) {
  console.error("Usage: validate-spec.js <spec.json> [<template.json>] [<formula-functions.json>] [--server US2]");
  process.exit(2);
}

if (!fs.existsSync(specPath)) {
  console.error(`Spec file not found: ${specPath}`);
  process.exit(2);
}

const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
const template = templatePath && fs.existsSync(templatePath) ? JSON.parse(fs.readFileSync(templatePath, "utf8")) : null;
const functions = functionsPath && fs.existsSync(functionsPath) ? JSON.parse(fs.readFileSync(functionsPath, "utf8")) : null;

const findings = [];
const ok = (msg) => findings.push({ status: "✅", msg });
const warn = (msg) => findings.push({ status: "⚠️", msg });
const fail = (msg) => findings.push({ status: "❌", msg });

// --- Check 5 — Required body fields (run first; if missing, other checks are unreliable) ---
const requiredBody = ["name", "document_version_id", "selected_document_ids", "config", "sheet_name"];
const missing = requiredBody.filter((k) => !(k in spec));
if (missing.length) {
  fail(`Required body fields missing: ${missing.join(", ")}`);
} else {
  ok("Required body fields present");
}

const config = spec.config || {};
const headers = config.header || [];
const dimensions = config.dimension || [];
const calcs = config.calculated_fields || [];

// --- Check 2 — Calc-name vs header-map_to collision (Bug 4) ---
const headerNames = new Set(headers.map((h) => h.map_to));
const collisions = calcs.filter((c) => headerNames.has(c.name));
if (collisions.length) {
  fail(
    `Bug 4 — calc-name vs header-map_to collision (tenant-wide ETL crash): ${collisions
      .map((c) => c.name)
      .join(", ")}. Rename the header to a temp name (e.g., 'Class Temp') so the calc field can own the canonical name.`
  );
} else {
  ok("Calc-name vs header-map_to collision check (Bug 4)");
}

// --- Check 1 — Schema-bootstrap diff (Bug 2) ---
// Only meaningful when we have a template to diff against.
if (template) {
  const templateFieldNames = new Set(
    (template.fields || template.template_fields || []).map((f) => f.name || f.field_name).filter(Boolean)
  );
  const payloadNames = new Set([...headers.map((h) => h.map_to), ...calcs.map((c) => c.name)]);
  const newNames = [...payloadNames].filter((n) => !templateFieldNames.has(n));
  if (newNames.length) {
    warn(
      `Bug 2 — ${newNames.length} new map_to/calc names not in template: ${newNames.join(", ")}. ` +
        `If this is an UPDATE, schema-bootstrap will NOT fire and these fields will be silently null. ` +
        `Switch to create-new + delete-old (Path C in /datamapper-build).`
    );
  } else {
    ok("Schema-bootstrap diff (Bug 2) — no new field names");
  }
} else {
  warn("Schema-bootstrap diff (Bug 2) — SKIPPED (no template provided)");
}

// --- Check 3 — Dimension → Date type check (Bug 3) ---
if (template) {
  const templateFieldTypes = {};
  for (const f of template.fields || template.template_fields || []) {
    const name = f.name || f.field_name;
    const type = (f.type || f.field_type || "").toLowerCase();
    if (name) templateFieldTypes[name] = type;
  }
  const dateDimensions = dimensions.filter((d) => {
    const t = templateFieldTypes[d.map_to];
    return t && (t === "date" || t.includes("date"));
  });
  if (dateDimensions.length) {
    fail(
      `Bug 3 — dimension(s) point at Date field (silent null coercion): ${dateDimensions
        .map((d) => `${d.map_to}`)
        .join(", ")}. Map dimension to a text field (e.g., 'Period') and derive the date via EOMONTH([Period]).`
    );
  } else {
    ok("Dimension → Date type check (Bug 3)");
  }
} else {
  warn("Dimension → Date type check (Bug 3) — SKIPPED (no template provided)");
}

// --- Check 4 — Formula syntax sweep ---
const knownFunctions = functions
  ? new Set((functions.functions || functions || []).map((f) => f.name || f).filter(Boolean))
  : new Set(["If", "Left", "Right", "Mid", "Len", "Split", "Date", "Int", "EOMONTH", "TEXTJOIN", "FY_Year", "Find", "Replace", "Concat", "Year", "Month", "Day"]);

const allFieldRefs = new Set([...headers.map((h) => h.map_to), ...calcs.map((c) => c.name)]);

const formulaProblems = [];
for (const calc of calcs) {
  const f = calc.formula || "";
  const problems = [];

  // Function casing — find all CamelCase-or-UPPER function-shaped tokens
  const callRe = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let m;
  while ((m = callRe.exec(f)) !== null) {
    const fnName = m[1];
    if (!knownFunctions.has(fnName)) {
      // Find a case-insensitive match in known functions
      const lower = fnName.toLowerCase();
      const sameLowerHit = [...knownFunctions].find((k) => k.toLowerCase() === lower);
      if (sameLowerHit && sameLowerHit !== fnName) {
        problems.push(`function '${fnName}' wrong casing — should be '${sameLowerHit}'`);
      } else {
        problems.push(`function '${fnName}' not in known function list`);
      }
    }
  }

  // Bare = vs ==
  // Strip out ==, !=, >=, <= first, then look for any remaining =
  const stripped = f.replace(/==|!=|>=|<=/g, "");
  if (/[^=!<>]=[^=]/.test(stripped)) {
    problems.push("bare '=' used (should be '==' for equality)");
  }

  // Two-arg EOMONTH
  if (/EOMONTH\s*\([^)]*,/.test(f)) {
    problems.push("EOMONTH used with 2 args — Datarails is single-arg: EOMONTH([Date])");
  }

  // Resolved [field] references
  const refRe = /\[([^\]]+)\]/g;
  let r;
  while ((r = refRe.exec(f)) !== null) {
    const refName = r[1];
    if (!allFieldRefs.has(refName)) {
      problems.push(`unresolved field reference [${refName}]`);
    }
  }

  // Prose-like string literal — heuristic: literal containing >=2 words AND any lowercase letters
  const strLitRe = /"([^"]*)"/g;
  let s;
  while ((s = strLitRe.exec(f)) !== null) {
    const lit = s[1];
    if (/\s/.test(lit) && /[a-z]/.test(lit) && lit.length > 12 && lit.split(/\s+/).length >= 2) {
      // Skip if it looks like a normalized account string (mostly digits + 1 space)
      const isNormalizedAccount = /^\d[\d\s]+$/.test(lit);
      if (!isNormalizedAccount) {
        problems.push(`prose-like string literal "${lit}" — compiler rejects these even though syntax looks valid`);
      }
    }
  }

  // Bug 6 — US2 quote chars in string literals
  if (server && server.toUpperCase() === "US2") {
    // Look for literals that contain just a quote-able single char like " " or any "x" where x is whitespace/punct
    // The risk is any string literal that the ETL parser may double-encode on US2.
    while ((s = strLitRe.exec(f)) !== null) {
      // already iterated; reset
    }
    const litRe2 = /"([^"]*)"/g;
    let s2;
    while ((s2 = litRe2.exec(f)) !== null) {
      // Flag if formula uses Find/Replace/Split with a literal containing whitespace
      if (/\b(Find|Replace|Split)\b/.test(f) && /\s/.test(s2[1])) {
        problems.push(`Bug 6 — string literal "${s2[1]}" inside Find/Replace/Split on US2 may break (HTML-entity encoding). Use positional Left/Mid/Right instead.`);
        break;
      }
    }
  }

  if (problems.length) {
    formulaProblems.push({ name: calc.name, formula: f, problems });
  }
}

if (formulaProblems.length) {
  fail(
    `Formula syntax issues in ${formulaProblems.length} calc field(s):\n` +
      formulaProblems
        .map((p) => `  • ${p.name}: ${p.formula}\n    → ${p.problems.join("; ")}`)
        .join("\n")
  );
} else {
  ok("Formula syntax sweep");
}

// --- Output ---
console.log("=== Datamapper Spec Validation ===");
console.log(`Spec: ${specPath}`);
if (templatePath) console.log(`Template: ${templatePath}`);
if (functionsPath) console.log(`Functions: ${functionsPath}`);
if (server) console.log(`Server: ${server}`);
console.log("");
for (const f of findings) {
  console.log(`${f.status} ${f.msg}`);
}
console.log("");

const failed = findings.filter((f) => f.status === "❌").length;
if (failed) {
  console.log(`❌ ${failed} blocking issue(s) — do NOT proceed to /datamapper-build.`);
  process.exit(1);
}
const warned = findings.filter((f) => f.status === "⚠️").length;
if (warned) {
  console.log(`⚠️ ${warned} warning(s) — review before approving the plan.`);
}
console.log("✅ Validation passed.");
process.exit(0);
