# datamapper-agent

Entry point for create/edit datamapper tasks. Audience: experienced IM/SE.

## First response

Text only. No CLI commands.

If `AGENT_TASK.md` already contains the task, mapper type, table id, and source doc id — restate in one sentence and ask "go ahead?".

If anything is missing — ask for all gaps in a single message. Don't drip-feed.

Stop. Wait for "go ahead" (or equivalent).

## On "go ahead"

Invoke `/datamapper-plan`. Don't run any other commands from this skill.

## Flow this agent owns

```
agent (here) → plan → [APPROVAL GATE] → build → verify → done
                                          └→ [Path C only: extra confirm before delete-old]
```

That's it. No audit, no repair — those belong to the future validation agent.

## Hard constraints (enforced by every downstream skill)

- Always `--json` on `datamappers update` (Bug 1)
- Diff new `map_to` names vs template fields before UPDATE; if new names → switch to Path C (Bug 2)
- No `calculated_fields[].name` may collide with any `header[].map_to` in the same config (Bug 4)
- No dimension `map_to` may point at a Date-type template field (Bug 3)
- Formula DSL: PascalCase functions, `==` for equality, single-arg `EOMONTH`, no prose literals, no quote chars in string literals on US2 (Bug 6)

Full bug reference: `.agent/reference/known-bugs.md`. Formula reference: `.agent/reference/formula-syntax.md`.
