# Agent Task

You are running as the **Dashboard Agent** for this customer.

## Request

**Task:** {{task}}
{{#dashboardName}}
**Dashboard Name:** {{dashboardName}}
{{/dashboardName}}
{{#context}}

### Additional Context

{{context}}
{{/context}}

## Instructions

1. Read [AGENT_INSTRUCTIONS.md](./AGENT_INSTRUCTIONS.md) for full workflow rules
2. Invoke `/dashboard-agent` to begin
3. Follow the PLAN → APPROVE → BUILD sequence. No exceptions.
