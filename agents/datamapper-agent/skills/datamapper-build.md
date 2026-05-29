# datamapper-build

Execute an approved spec end-to-end. No additional approval gate except before Path C delete.

## Preconditions

- Approved spec exists at `.agent/specs/<file>.json`
- Validator exited 0 against that spec
- User said "build it" (or equivalent) in the prior turn
- Path letter (A/B/C/D) is known from `/datamapper-plan`

If any precondition is missing, refuse and route back to `/datamapper-plan`.

## Path A — Create new mapper

```
dr datamappers create from-file <table_id> --file .agent/specs/<file>.json --server <SERVER>
```

Capture `mapper_id` from response.

## Path B — Update existing mapper

```
dr datamappers update <mapper_id> --payload-file .agent/specs/<file>.json --server <SERVER> --json
```

**`--json` is mandatory** (Bug 1 — renderer crashes without it). Then verify the write:

```
dr datamappers get <mapper_id> --table <table_id> --server <SERVER> --json
```

## Path C — Create new, then delete old

1. Create:
   ```
   dr datamappers create from-file <table_id> --file .agent/specs/<file>.json --server <SERVER>
   ```
   Capture new `mapper_id`.

2. Run `/datamapper-verify` against the new mapper. **Do not proceed to delete until verify passes.**

3. Extra confirmation gate — message the user:
   > Verify passed for new mapper <new_id>. Deleting old mapper <old_id> will orphan any LUT/dashboard/function references to its ID. Type "delete" to proceed.

4. On "delete":
   ```
   dr datamappers delete <old_id> --table <table_id> --server <SERVER>
   ```
   Parse `confirm-token` from response.
   ```
   dr datamappers delete <old_id> --table <table_id> --server <SERVER> --confirm-token <token>
   ```

## Path D — Manual UI

Should never reach `/datamapper-build` — `/datamapper-plan` outputs UI steps and stops. If invoked here, refuse.

## After create/update — bind and rescan

If the spec references documents not already bound:
```
dr datamappers bind <mapper_id> --doc <doc_id> --server <SERVER>
```

Trigger rescan:
```
dr rescan table <table_id> --server <SERVER>
```

Poll status once:
```
dr scans status --server <SERVER>
```

If not yet `completed`, tell the user and stop. Don't sleep-loop. The user re-engages when they want to check.

## On rescan completed

Invoke `/datamapper-verify` with `mapper_id`, `table_id`, `SERVER`.

For Path C, verify runs BEFORE the delete confirmation gate (see step 2 above). For Paths A and B, verify runs AFTER the rescan.

## Rules

- `--json` on every `datamappers update` (Bug 1).
- No CLI write without an approved spec + validator green.
- No Path C delete without verify ✅ on the new mapper.
- Never re-run `dr whoami`.
