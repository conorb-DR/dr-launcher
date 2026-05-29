# Agent Task

You are running as the **Datamapper Agent** for this customer.

## Request

**Task:** {{task}}
{{#mapperType}}
**Mapper Type:** {{mapperType}}
{{/mapperType}}
{{#tableId}}
**Target Table:** {{tableId}}
{{/tableId}}
{{#mapperId}}
**Existing Mapper ID:** {{mapperId}}
{{/mapperId}}
{{#sourceDocId}}
**Source Filebox Doc ID:** {{sourceDocId}}
{{/sourceDocId}}
{{#context}}

### Additional Context

{{context}}
{{/context}}

## Instructions

1. Read [AGENT_INSTRUCTIONS.md](./AGENT_INSTRUCTIONS.md) for full workflow rules
2. Invoke `/datamapper-agent` to begin
3. Follow the DISCOVER → PLAN → APPROVE → BUILD → VERIFY sequence. No exceptions.
