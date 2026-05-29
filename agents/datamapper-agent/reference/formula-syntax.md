# Datarails ETL Formula DSL — Syntax Reference

The Datarails ETL formula compiler (used in `config.calculated_fields[].formula`) is a custom DSL, NOT Excel. Get any rule wrong and the server returns a bare HTTP 500 with no message.

The authoritative function list (with signatures) lives at:
```
dr datamappers custom-functions --server <SERVER> --json
```

Always run this before authoring formulas — it's the source of truth.

## Hard rules

| Rule | Wrong | Right |
|---|---|---|
| Function casing | `IF(...)`, `LEFT(...)` | `If(...)`, `Left(...)` — PascalCase |
| Equality | `=` | `==` |
| String literals in JSON | `&quot;...&quot;` (what GET returns) | `"..."` (raw double quotes) |
| EOMONTH arity | `EOMONTH([Date], 0)` (Excel 2-arg) | `EOMONTH([Date])` (single-arg) |
| Field refs | unresolved name | every `[field]` must resolve to a `header.map_to` or another `calculated_fields.name` |
| Prose literals | `"Customer or Client name"` | rejected by ETL — looks like a literal but compiler 500s |

## Known core functions (verify via `dr datamappers custom-functions`)

- `If(condition, then, else)`
- `Left(text, n)`, `Right(text, n)`, `Mid(text, start, length)`, `Len(text)`
- `Split(text, delimiter)` (returns array — usually used inside other functions)
- `Date(year, month, day)` — builds a date from ints
- `Int(text)` — parses int from text
- `EOMONTH(date)` — end-of-month for the given date
- `TEXTJOIN(separator, ...parts)` — concatenate with separator
- `FY_Year(date)` — fiscal year number

## US2 HTML entity encoding gotcha (Bug 6)

On US2, `dr datamappers get` returns formulas with `&quot;` in place of `"`. The CLI auto-decodes on PUT/POST, but the ETL parser on US2 doesn't always decode entities correctly at evaluation time.

**The safe rule: avoid string literals containing quote characters entirely.**

```
// BAD — breaks on US2:
Find(" ", [Account Full]) - 1

// GOOD — positional, works everywhere:
Left([Account Full], 4)
Mid([Account Full], 6, Len([Account Full]))
```

## Standard UDM calc-field patterns (verified working)

| UDM Field | Formula |
|---|---|
| Account ID | `Left([Account Full], 4)` OR `[Account]` (passthrough) |
| Account Name | `Mid([Account Full], 6, Len([Account Full]))` OR `[Description]` |
| Account Full | `TEXTJOIN(" ", [Account ID], [Account Name])` |
| Posting Amount | `[Debit] - [Credit]` OR `[DebitAmount] - [CreditAmount]` |
| Amount | `[Posting Amount]` |
| Posting Date | `EOMONTH([Period])` when Period is text like "Jan 2026" |
| Reporting Month | `EOMONTH([Posting Date])` |
| Reporting Year | `FY_Year([Reporting Month])` |
| Data Type | `"Activity"` (GL) OR `"Beginning Balance"` (TB) |
| Entity | Direct map from source OR hardcoded `"EntityCode"` |
| USER_TO_DR_ACC_KEY | `[Account]` OR `[type]` (if LUT-enriched) |
| USER_TO_DR_KPI_KEY | `[Account]` OR `[Account Full]` |
| Report_Field | Customer-specific — `[Account]`, `[type]`, or `""` if undefined |

## Patterns for combined-prefix fields

When a source field combines a type prefix and a value (e.g., `CustomerVendor` = `"C-Acme"` or `"V-Vendor1"`):

```
// Extract customers only:
If(Left([CustomerVendor], 1) == "C", [CustomerVendor], "")

// Extract vendors only:
If(Left([CustomerVendor], 1) == "V", [CustomerVendor], "")
```

## Nested If for month selection (Recipe B — Pivoted TB)

When each month's Debit/Credit are separate columns (`Jan_Debit`, `Feb_Debit`, etc.) and the dimension expands to a `Period` text:

```
Debit = If([Period] == "Jan 2026", [Jan_Debit],
        If([Period] == "Feb 2026", [Feb_Debit],
        If([Period] == "Mar 2026", [Mar_Debit], 0)))
```

Same pattern for Credit.

## Date parsing from text (when source has MMYYYY string)

```
EOMONTH(Date(Int(Right([PostPeriod], 4)), Int(Left([PostPeriod], 2)), 1))
```

This builds a date from a string like `"012026"` (Jan 2026).

## What NOT to do

- Don't use Excel function names with all-caps (`IF`, `LEFT`, `RIGHT`).
- Don't use bare `=` for equality — that's an assignment in some parsers but a syntax error here.
- Don't write prose strings as placeholder formulas (`"Customer or Client name"`). The compiler will 500.
- Don't use 2-arg `EOMONTH(date, months_offset)` — Datarails is single-arg.
- Don't reference a field that isn't a header `map_to` or another calc field name in the same config.
- Don't use `Find()` with quoted string literals on US2 — use positional `Left/Mid/Right` instead (Bug 6).
- Don't introduce a calc field whose `name` matches a header's `map_to` in the same config (Bug 4 — tenant-wide ETL crash).
