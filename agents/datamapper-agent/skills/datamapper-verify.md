# datamapper-verify

Confirm the build landed correctly. Read-only.

## Checks

```
dr scans status --server <SERVER>                                                                    # status: completed, errors: 0
dr templates sample <table_id> --server <SERVER> --json                                              # spot-check key fields non-null
dr templates aggregate <table_id> --group-by "Reporting Month" --metric "Amount:SUM" --server <SERVER>
dr templates aggregate <table_id> --group-by "Posting Date" --metric "Amount:COUNT" --server <SERVER># [null] group with non-zero COUNT = silent failure
dr templates aggregate <table_id> --group-by "Account Group L0" --metric "Amount:COUNT" --server <SERVER>
dr templates aggregate <table_id> --group-by "USER_TO_DR_ACC_KEY" --metric "Amount:COUNT" --server <SERVER>
dr datamappers connected-fileboxes <mapper_id> --server <SERVER>
dr datamappers processed-versions <mapper_id> --server <SERVER>
dr lut unmapped --server <SERVER> --json                                                             # surface new unmapped keys produced by this mapper
```

## Silent-failure decoder

| Symptom | Likely cause |
|---|---|
| `Posting Date` all null with non-zero rows | Bug 3 (dimension → Date) or `[Period]` not resolving |
| All `Amount` zero after UPDATE | Bug 2 (new `map_to` names dropped on UPDATE — should have been Path C) |
| `USER_TO_DR_ACC_KEY` null | Calc formula references unresolved field, or Bug 2 dropped it |
| Wrong values, no nulls | Formula chain references wrong field — review calc graph |
| Scan stuck at 50% across all mappers | Bug 4 (calc/header collision) — revert mapper |

## Report

```
## Verify — mapper <id> on <SERVER>

| Check | Status | Notes |
| Scan completed | ✅ / ❌ | <N docs, M errors> |
| Posting Date populated | ✅ / ❌ | <null count if any> |
| Amount populated | ✅ / ❌ | |
| USER_TO_DR_ACC_KEY populated | ✅ / ❌ | |
| Period coverage | ✅ / ⚠️ | <MMM YYYY – MMM YYYY, gaps?> |
| LUT unmapped keys | ✅ / ⚠️ | <list new ones> |
```

If all ✅ → done. If ❌ → report the symptom + the likely cause from the decoder. Do not auto-fix. The user decides whether to re-plan or hand off elsewhere.

## Hand-off

On clean verify, this is the terminal skill. Report results and stop.
