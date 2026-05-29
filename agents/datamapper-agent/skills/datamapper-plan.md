# datamapper-plan

Discover, build the spec, validate, present the plan. This is the **only** approval gate in the workflow.

## Phase 1 — Discover (read-only)

Run all of these. `--json` everywhere. No prompts to the user mid-discovery — just gather and save.

```
dr whoami --server <SERVER>                                          # only if /datamapper-agent hasn't already established this session
dr templates list --server <SERVER> --json
dr templates get <table_id> --server <SERVER> --json                  → .agent/tmp/template-<table_id>.json
dr datamappers list --table <table_id> --server <SERVER> --json
dr datamappers get <mapper_id> --table <table_id> --server <SERVER> --json    # only if editing → .agent/tmp/mapper-<id>.json
dr filebox get <doc_id> --server <SERVER> --json                      # top-level `id` IS the version_id
dr filebox preview <version_id> --rows 5 --server <SERVER> --json     # if fails (Bug 5), use .agent/scripts/download-filebox.js
dr datamappers custom-functions --server <SERVER> --json              → .agent/tmp/formula-functions.json
```

Write the server to `.agent/tmp/server.txt` so the hook can pick it up.

## Phase 2 — Build the spec

Spec goes to `.agent/specs/<mapper-name>-<YYYYMMDD>.json`. Required body fields: `name`, `document_version_id`, `selected_document_ids`, `config`, `sheet_name`.

Use the matching recipe from `.agent/reference/mapper-recipes.md`:
- Flat GL → Recipe A
- Pivoted TB with month columns → Recipe B
- QBO key mismatch → Recipe C (Path D / manual UI — not executable here)

## Phase 3 — Validate

Run the validator (the PostToolUse hook fires this automatically on spec write, but invoke explicitly too so you have stdout):

```
node .agent/scripts/validate-spec.js .agent/specs/<spec>.json .agent/tmp/template-<table_id>.json .agent/tmp/formula-functions.json --server <SERVER>
```

The validator covers all six bugs. If exit code != 0, fix the spec and re-run before showing the plan. Do not present a spec with ❌ findings to the user.

## Phase 4 — Determine write path

| Condition | Path | Skill action |
|---|---|---|
| New mapper | A — create | Standard |
| Edit, no new `map_to` names introduced | B — update | Standard, with `--json` |
| Edit, new `map_to` names introduced | C — create-new + delete-old | Plan must call out orphan-reference risk |
| QBO key normalization OR unresolvable calc/header collision | D — manual UI instructions | Plan presents UI steps, no CLI write |

## Phase 5 — Present the plan

This message MUST include:

> ⚠️ Nothing has been written to Datarails yet. Approve to proceed.

Structure:

```
## Plan
Server: <SERVER>  |  Table: <id> (<name>)  |  Source: doc <id> v<version_id> / sheet "<sheet>"
Path: <A | B | C | D>
Spec: .agent/specs/<filename>.json

## Headers
| Coord | Source | map_to |
| ... | ... | ... |

## Dimensions (if any)
| Coord | Value | map_to | match_type |

## Calculated fields
| Name | Formula |

## Validation
✅ All six checks passed
[OR list any ⚠️ from the validator]

## Risks
- (Path C only) Deleting mapper <old_id> orphans any LUT/dashboard/function references to its ID.
- (Path D only) CLI cannot safely apply this — manual UI steps follow.
```

## Phase 6 — Wait

Wait for explicit approval ("build it", "go ahead", "ship it", "approved"). On approval, invoke `/datamapper-build` with the spec path and path letter.

Don't invoke `/datamapper-build` for Path D — output the manual UI steps and stop.

Don't loop back into discovery on edits the user requests — just patch the spec, re-run the validator, and re-present.
