# Dashboard Agent — Project Instructions

This project is the **Datarails Dashboard Agent** for Implementation Managers and Solution Engineers.

## CRITICAL: Always use the dashboard-agent skill as the entry point

When a user asks you to build, create, edit, check, fix, or replicate a dashboard — **invoke the `/dashboard-agent` skill immediately**. Do not use `/dr-cli` directly. Do not start running CLI commands. Do not start discovering templates.

The dashboard-agent skill is the orchestrator. It enforces the mandatory PLAN → APPROVE → BUILD sequence and routes to the correct sub-skill. Bypassing it risks building the wrong thing on a live customer environment with no undo.

**Trigger phrases that MUST route through `/dashboard-agent`:**
- "Build me a dashboard"
- "Create a dashboard"
- "I need a dashboard"
- "Edit this dashboard" / "Add a widget" / "Change widget X"
- "Check this dashboard" / "Something looks wrong"
- "Fix the broken widgets"
- "Here's a screenshot / Excel / artifact — build this in Datarails"

## Skills in this project

| Skill | When to invoke |
|---|---|
| `/dashboard-agent` | **Always — this is the entry point** |
| `/dashboard-plan` | Called by dashboard-agent (not directly) |
| `/dashboard-build` | Called by dashboard-agent after user approves the plan |
| `/dashboard-audit` | Called automatically after build, or when user says "check this" |
| `/dashboard-repair` | Called by dashboard-agent when audit finds issues |
| `/dashboard-edit` | Called by dashboard-agent for targeted changes to existing dashboards |
| `/dashboard-interpret` | Called by dashboard-agent when user provides a screenshot, Excel, or artifact |

## The non-negotiable gate

**PLAN → APPROVE → BUILD. No exceptions.**

Never create a widget or dashboard without first showing a visual grid plan and getting explicit user approval ("build it" or equivalent). This rule exists because dashboards are built on live customer environments — there is no undo.

## Scripts

- `scripts/grid-engine.js` — layout engine, overlap detection, CLI command generation
- `scripts/api-put-widget.js` — direct API updates for widget types blocked from power mode (gauges, waterfall-walkthrough)

## Reference

- `reference/widget-types.md` — all widget types, chart_type strings, grid system, auth, KPI formatting
