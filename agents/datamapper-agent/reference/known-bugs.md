# Known Datamapper Bugs (dr-cli v0.2.57)

Six confirmed bugs in the current CLI/server. The agent enforces workarounds for each. R&D has the bug report; until fixes ship, these rules are non-negotiable.

---

## Bug 1 — `datamappers update` Renderer Crash

**Severity:** High (hits every UPDATE without `--json`)

**Symptom:**
```
$ dr datamappers update 70999 --payload-file payload.json --server US2
error: Cannot read properties of undefined (reading 'length')
```

The PUT succeeds server-side. The CLI crashes rendering the response table because it expects GET-shape (with `mapped_documents_ids`) but the PUT response returns POST-shape (`number_connected_fileboxes`).

**Workaround the agent enforces:**
ALWAYS pass `--json` on `datamappers update`:
```
dr datamappers update <id> --payload-file <file> --server <SERVER> --json
```
After every update, verify the config landed with `dr datamappers get`.

---

## Bug 2 — Schema-Bootstrap Skipped on UPDATE (CRITICAL — Silent Data Loss)

**Severity:** Critical (silent data loss, no error at any step)

**Symptom:**
Updating a mapper that introduces new `map_to` field names produces a successful response, a successful preview, and a clean rescan — but the new fields don't exist in the target template and all extracted values for those fields are null.

**Root cause:**
Schema-bootstrap (auto-creating template fields for unknown `map_to` names) only runs on POST (`datamappers create`), not on PUT (`datamappers update`).

**Workaround the agent enforces:**
Before any UPDATE, diff payload `map_to` names vs the template's existing fields:
- Fetch `dr templates get <table_id> --json`
- Compare against every `header[].map_to` and `calculated_fields[].name` in the payload
- If ANY new names appear, switch to **create-new + delete-old**:
  1. `dr datamappers create from-file <table_id> --file <payload> --server <SERVER>` (POST triggers bootstrap)
  2. Run `/datamapper-verify` on the new mapper
  3. Two-step delete of the old mapper: `dr datamappers delete <old_id> --table <table_id> --server <SERVER>` to get the token, then again with `--confirm-token <token>`

**Warn the user before delete:** "Deleting the old mapper orphans any LUT/dashboard/function references to its ID. Verify no downstream dependencies first."

---

## Bug 3 — Dimension → Date Field Silent Null Coercion

**Severity:** Medium (preview masks the failure entirely)

**Symptom:**
With dimensions whose `map_to` points to a Date-type template field, dimension expansion creates the correct row count but every extracted value for that field is null. No error at any stage.

```
$ dr templates aggregate <id> --group-by "Posting Date" --metric "Account ID:COUNT"
Account ID   Posting Date
374          [null]
```

**Root cause:**
The ETL can't coerce a month-label string ("Jan 2026") into the epoch timestamp format a Date field requires. Value silently dropped. The preview endpoint doesn't enforce field type, so previews appear correct.

**Workaround the agent enforces:**
- Pre-flight check: for every `config.dimension[]`, look up the target field's type in the template
- If type is `Date`, REWRITE the dimension's `map_to` to a text field (`Period`)
- Add a calculated field to derive the date: `{"name": "Posting Date", "formula": "EOMONTH([Period])"}`

---

## Bug 4 — Mapper Update Can Crash Tenant-Wide ETL

**Severity:** Critical (affects ALL mappers on the tenant, not just the one being updated)

**Symptom:**
Updating a mapper to add a calculated field whose `name` shadows an existing `header[].map_to` name causes ETL formula-graph compilation failures. ALL documents across ALL mappers crash at exactly 50% during the next rescan.

**Root cause:**
The ETL formula-graph compiler doesn't isolate failures to the affected mapper — a name collision blows up the entire graph for the tenant.

**Workaround the agent enforces:**
- Pre-flight check: no `calculated_fields[].name` may match any `header[].map_to` in the same config
- If a collision is needed (e.g., the user wants a calc field named `Account Full` but a header already maps to `Account Full`):
  - Rename the header to a temp name (e.g., `Class Temp`, `Account Temp`)
  - Give the calc field the canonical name
- For QBO key normalization specifically (Recipe C), do NOT apply via CLI — output manual UI instructions instead. The UI has additional safeguards.

---

## Bug 5 — `filebox preview` Hardcoded Document ID

**Severity:** Low (preview wrong/broken for most fileboxes)

**Symptom:**
`dr filebox preview <filebox_id>` sends `GET /api/documents/1/versions/${versionId}/raw` — the document ID is hardcoded as `1` instead of the actual doc id.

**Workaround the agent enforces:**
If `dr filebox preview` returns wrong data or fails, fall back to direct download via the JWT in the OS keychain. Use `dr filebox get <doc_id>` to get the version_id, then `.agent/scripts/download-filebox.js` to fetch the raw file.

---

## Bug 6 — US2 HTML Entity Encoding in Formulas

**Severity:** Medium (silently produces wrong results)

**Symptom:**
Formulas containing string literals with quote characters break on US2. The stored formula has `&quot;` instead of `"`, and the ETL parser on US2 evaluates `Find(&quot; &quot;, ...)` which finds nothing and returns 0. The CLI displays the decoded formula, so the bug is invisible to the operator.

**Root cause:**
Django's `escape()` on US2 HTML-encodes quotes when storing formula strings. The ETL parser doesn't decode them at evaluation time.

**Workaround the agent enforces:**
Avoid string literals containing quote characters entirely. Use positional functions:

```
// BAD on US2:
Find(" ", [Account Full]) - 1

// GOOD everywhere:
Left([Account Full], 4)
Mid([Account Full], 6, Len([Account Full]))
```

Pre-flight: if server is US2 AND any formula contains a `"..."` literal with a space or other quote-character-sensitive content, flag it and rewrite.
