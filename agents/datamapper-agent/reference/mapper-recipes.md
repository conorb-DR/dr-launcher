# Datamapper Recipes

Three canonical mapper shapes, with full spec examples. Use these as templates — never copy values literally.

## Required top-level body fields (every mapper)

- `name` — mapper display name
- `document_version_id` — from `dr filebox get <doc_id>` (the top-level `id` IS the version_id, not the doc_id)
- `selected_document_ids` — array containing the doc_id(s) the mapper covers
- `sheet_name` — the worksheet inside the source file
- `config` — { header, dimension, calculated_fields, ignore_zeros }

---

## Recipe A — Flat GL (one row per transaction)

**Source shape:** flat CSV/Excel where each row is one journal entry.

**Columns example:** Date | Account | Description | Debit | Credit

```json
{
  "name": "GL_Financials",
  "document_version_id": "<version_id>",
  "selected_document_ids": ["<doc_id>"],
  "sheet_name": "<sheet_name>",
  "config": {
    "header": [
      {"coordinate": "A1", "value": "Date",        "map_to": "Posting Date",       "match_type": "value"},
      {"coordinate": "B1", "value": "Account",     "map_to": "Account Full",       "match_type": "value"},
      {"coordinate": "C1", "value": "Description", "map_to": "Account Name Temp",  "match_type": "value"},
      {"coordinate": "D1", "value": "Debit",       "map_to": "Debit",              "match_type": "value"},
      {"coordinate": "E1", "value": "Credit",      "map_to": "Credit",             "match_type": "value"}
    ],
    "calculated_fields": [
      {"name": "Account ID",          "formula": "Left([Account Full], 4)"},
      {"name": "Account Name",        "formula": "Mid([Account Full], 6, Len([Account Full]))"},
      {"name": "Posting Amount",      "formula": "[Debit] - [Credit]"},
      {"name": "Amount",              "formula": "[Posting Amount]"},
      {"name": "Reporting Month",     "formula": "EOMONTH([Posting Date])"},
      {"name": "Reporting Year",      "formula": "FY_Year([Reporting Month])"},
      {"name": "Data Type",           "formula": "\"Activity\""},
      {"name": "USER_TO_DR_ACC_KEY",  "formula": "[Account Full]"},
      {"name": "USER_TO_DR_KPI_KEY",  "formula": "[Account Full]"},
      {"name": "Report_Field",        "formula": "[Account Full]"}
    ],
    "ignore_zeros": true
  }
}
```

**Notes:**
- `Account Full` is the canonical key. `Account ID` and `Account Name` are derived via `Left`/`Mid`. (Choose this pattern when the source `Account` column is `XXXX Account Description` — Left 4 = ID, Mid 6 to end = Name.)
- If the source `Account` column is already just the ID, simplify: `"Account ID": "[Account]"` and `"Account Name": "[Description]"`.

---

## Recipe B — Pivoted Trial Balance (months as column groups)

**Source shape:** month labels in row 1 (e.g., "Jan 2026" at E1, "Feb 2026" at G1), Debit/Credit sub-headers repeat in row 3 under each month.

```
       E1: Jan 2026         G1: Feb 2026
A3:    E3: Debit  F3: Credit  G3: Debit  H3: Credit
Code   ...
```

**Key pattern:**
- Each month's Debit and Credit get unique `map_to` names: `Jan_Debit`, `Jan_Credit`, `Feb_Debit`, `Feb_Credit`...
- Headers use `groups` to tie sub-headers to their parent month label.
- Dimensions match month labels and assign them to a TEXT field (`Period`), NOT a Date field (Bug 3).
- `repetitive_structure: false` because each month occupies a fixed coordinate.
- Calc fields use nested `If` against `[Period]` to pick the right month's column.
- `Posting Date` is derived from `[Period]` via `EOMONTH([Period])`.

```json
{
  "name": "TB_Monthly",
  "document_version_id": "<version_id>",
  "selected_document_ids": ["<doc_id>"],
  "sheet_name": "Trial Balance",
  "config": {
    "header": [
      {"coordinate": "A3", "value": "Code",         "map_to": "Account ID",   "match_type": "value"},
      {"coordinate": "B3", "value": "Account Name", "map_to": "Account Name", "match_type": "value"},

      {"coordinate": "E3", "value": "Debit",  "groups": [{"coordinate": "E1", "value": "Jan 2026", "items": []}], "map_to": "Jan_Debit",  "match_type": "value"},
      {"coordinate": "F3", "value": "Credit", "groups": [{"coordinate": "E1", "value": "Jan 2026", "items": []}], "map_to": "Jan_Credit", "match_type": "value"},
      {"coordinate": "G3", "value": "Debit",  "groups": [{"coordinate": "G1", "value": "Feb 2026", "items": []}], "map_to": "Feb_Debit",  "match_type": "value"},
      {"coordinate": "H3", "value": "Credit", "groups": [{"coordinate": "G1", "value": "Feb 2026", "items": []}], "map_to": "Feb_Credit", "match_type": "value"}
    ],
    "dimension": [
      {"coordinate": "E1", "value": "Jan 2026", "match_type": "regex", "map_to": "Period", "repetitive_structure": false, "groups": []},
      {"coordinate": "G1", "value": "Feb 2026", "match_type": "regex", "map_to": "Period", "repetitive_structure": false, "groups": []}
    ],
    "calculated_fields": [
      {"name": "Account Full",     "formula": "TEXTJOIN(\" \", [Account ID], [Account Name])"},
      {"name": "Posting Date",     "formula": "EOMONTH([Period])"},
      {"name": "Debit",            "formula": "If([Period]==\"Jan 2026\", [Jan_Debit], If([Period]==\"Feb 2026\", [Feb_Debit], 0))"},
      {"name": "Credit",           "formula": "If([Period]==\"Jan 2026\", [Jan_Credit], If([Period]==\"Feb 2026\", [Feb_Credit], 0))"},
      {"name": "Posting Amount",   "formula": "[Debit] - [Credit]"},
      {"name": "Amount",           "formula": "[Posting Amount]"},
      {"name": "Reporting Month",  "formula": "EOMONTH([Posting Date])"},
      {"name": "Reporting Year",   "formula": "FY_Year([Reporting Month])"},
      {"name": "Data Type",        "formula": "\"Beginning Balance\""}
    ],
    "ignore_zeros": true
  }
}
```

**Common mistakes for Recipe B:**
- Mapping the dimension to `Posting Date` (a Date field) — silent null coercion. Always use `Period` (text).
- Forgetting the `groups` array on the Debit/Credit headers — sub-headers won't bind to the right month.
- Using `EOMONTH([Period], 0)` — single-arg only.

---

## Recipe C — QBO GL Import (account key mismatch)

**Source shape:** QBO export where account numbers are concatenated differently than the COA expects.

**Example mismatch:** source has `"200696139"` but COA expects `"20069 6139"` (with a space).

**Key pattern:**
- Map the raw Account column to a TEMP header name (`Class Temp`, not `Account Full`).
- Create a calc field named `Account Full` that normalizes the specific mismatched account(s).
- Use `If` with exact match — passthrough everything else.

```json
{
  "config": {
    "header": [
      {"coordinate": "B1", "value": "Class", "map_to": "Class Temp", "match_type": "value"}
    ],
    "calculated_fields": [
      {"name": "Account Full", "formula": "If([Class Temp] == \"200696139\", \"20069 6139\", [Class Temp])"}
    ]
  }
}
```

## ⛔ SAFETY RULE FOR RECIPE C

**NEVER auto-apply this pattern via `dr datamappers create from-file` or `dr datamappers update`.**

Reason: Bug 4. Adding a calc field that shadows a header's `map_to` (even via the temp-name workaround) can crash the tenant ETL formula graph during rescan. All mappers on the tenant will fail at 50%.

Instead, the agent outputs **manual UI instructions** for the user:

1. Open the mapper in Datarails UI under **Table Settings → Datamappers → <mapper name>**
2. Rename the existing `Account Full` header mapping to `Class Temp`
3. Add a new calc field `Account Full` with the `If` formula
4. Save and test extraction on ONE document
5. Only after that single-document test passes, trigger a full rescan

This is the only mapper change pattern the agent must REFUSE to do via CLI.

---

## When in doubt

If the source file shape doesn't match A, B, or C cleanly, ask the user:
- "Is each row a transaction (Recipe A), or a snapshot per period (Recipe B)?"
- "Do month labels repeat across columns (Recipe B), or is there a single Date column (Recipe A)?"
- "Are there any source-vs-COA key mismatches we'd need to normalize (Recipe C — manual UI only)?"
