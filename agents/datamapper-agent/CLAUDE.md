# Datamapper Agent — Project Instructions

This workspace is the **Datarails Datamapper Agent**. Audience: experienced IM/SE.

## Always route through `/datamapper-agent`

Any create-or-edit datamapper request → invoke `/datamapper-agent` immediately. Don't start running `dr` commands ad-hoc. Don't open the JSON spec by hand.

Diagnosis-only requests ("is this mapper healthy?", "why are the numbers wrong?") are out of scope — that's the future validation agent.

## Flow

```
/datamapper-agent  →  /datamapper-plan  →  [APPROVAL]  →  /datamapper-build  →  /datamapper-verify
                                                              └─ Path C only: extra confirm before delete-old
```

Single approval gate after the plan. Path C (create-new + delete-old) gets a second confirmation before the delete because deletion orphans LUT/dashboard/function references.

## Constraints (load-bearing — enforced by every skill)

| # | Rule | Why |
|---|---|---|
| 1 | `--json` on every `datamappers update` | CLI renderer crashes without it |
| 2 | Diff new `map_to` names vs template before UPDATE; new names → Path C | Schema-bootstrap only fires on CREATE — UPDATE silently drops new fields |
| 3 | No dimension `map_to` pointed at a Date-type field | Silent null coercion |
| 4 | No `calculated_fields[].name` may match any `header[].map_to` in the same config | Tenant-wide ETL crash at 50% |
| 6 | No quote characters in string literals on US2; use positional `Left/Mid/Right` | US2 HTML-encodes quotes; ETL parser doesn't decode |

Formula DSL: PascalCase functions (`If`, `Left`, `Mid`, `Len`, `Split`, `Date`, `Int`, `EOMONTH`, `TEXTJOIN`, `FY_Year`), `==` for equality, single-arg `EOMONTH`, no prose-like string literals.

## Skills

| Skill | Job |
|---|---|
| `/datamapper-agent` | Entry. Ack + ask gaps + route to plan. |
| `/datamapper-plan` | Discover + build spec + validate + present. Single approval gate. |
| `/datamapper-build` | Execute. Path A/B/C/D. Extra confirm before Path C delete. |
| `/datamapper-verify` | Confirm the build landed. Read-only. Terminal skill. |

## Scripts

- `.agent/scripts/validate-spec.js` — six-bug pre-flight; PostToolUse hook re-runs it whenever a spec is written
- `.agent/scripts/download-filebox.js` — Bug 5 fallback when `dr filebox preview` returns wrong data

## Reference

- `.agent/reference/formula-syntax.md` — full DSL + UDM calc patterns
- `.agent/reference/mapper-recipes.md` — Recipe A (Flat GL), B (Pivoted TB), C (QBO key normalization — Path D / manual UI only)
- `.agent/reference/known-bugs.md` — Bugs 1–6 with symptoms and workarounds
- `.agent/schemas/mapper-spec.json` — JSON schema for `.agent/specs/*.json`
