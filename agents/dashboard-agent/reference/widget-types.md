# Datarails Widget Type Reference

> Foundation document for the Dashboard Agent. Source of truth: `dr widgets <type> --help` (May 2026).

## Grid System

- **12-column grid** — x ranges from 0–11, width from 1–12
- **Rows are unbounded** — y can be any non-negative integer, height is flexible
- Widgets are positioned by `(x, y, width, height)` — top-left corner + dimensions
- **No overlap detection** — the API accepts overlapping positions silently; the UI renders them stacked/broken

## Power Mode chart_type Strings (verified from CLI source)

These are the ONLY strings accepted by `widgets create --file` and `widgets update --file`.
The flag-driven commands bypass this validation but power mode enforces it strictly.

| Widget | chart_type string | Power mode? |
|---|---|---|
| KPI | `kpi-widget` | ✅ |
| Column chart | `column-chart` | ✅ |
| Column stacked | `column-chart-stacked` | ✅ |
| Column stacked % | `column-chart-stacked-percent` | ✅ |
| Bar chart | `bar-chart` | ✅ |
| Bar stacked | `bar-chart-stacked` | ✅ |
| Bar stacked % | `bar-chart-stacked-percent` | ✅ |
| Line chart | `line-chart` | ✅ |
| Line smooth | `line-chart-smooth` | ✅ |
| Area chart | `area-chart` | ✅ |
| Area stacked | `area-chart-stacked` | ✅ |
| Pie | `pie-chart` | ✅ |
| Pie drilldown | `pie-chart-drilldown` | ✅ |
| Scatter | `scatter-chart` | ✅ |
| Waterfall breakdown | `waterfall-chart-breakdown` | ✅ |
| Smart KPI (metric) | `smart-kpi` | ✅ |
| Text/header | `rich_text` | ✅ |
| Table | `table_only` | ✅ |
| Gauge enhanced | `gauge-chart-enhanced` | ❌ CLI only |
| Gauge dynamic-goal | `gauge-chart-dynamic-goal` | ❌ CLI only |
| Waterfall walkthrough | `waterfall-chart-walkthrough` | ❌ CLI only |

**For ❌ types:** create via flag command → update via `api-put-widget.js` (direct API call).

## rows vs cols in widget JSON

Critical distinction — these behave differently from what you'd expect:

| Field | In charts | In tables |
|---|---|---|
| `rows` | **Series / legend** — each unique value becomes a separate line/bar colour | Row dimension (Y-axis of pivot) |
| `cols` | **X-axis** — values plotted along the horizontal axis | Column dimension (X-axis of pivot) |

**Common patterns:**
- Line chart over time → `cols: [Reporting Month]`, `rows: []` (single line) or `rows: [Dimension]` (one line per dimension value)
- Column chart by category with time series → `rows: [Category]`, `cols: [Reporting Month]`
- Pie chart with drilldown → `rows: [primary slice dimension]`, `cols: [drilldown dimension]`
- Pivot table → `rows: [row dims]`, `cols: [Reporting Month]`

## Date Field Rule

**Always use "Reporting Month" for any date dimension** — `time_by`, `date_filters`, and date picker binding. Never use system-generated date fields (e.g. "Created Date", "Modified Date", "System Month"). System dates track when data was loaded into Datarails, not when the financial activity occurred, and will produce wrong results.

## Date Picker Binding

All widgets should be bound to the dashboard date picker using the **"Reporting Month"** field. Add this filter to every data widget:

```json
{
  "field": <Reporting_Month_field_id>,
  "name": "Reporting Month",
  "values": {
    "datetype": "frame",
    "val": {
      "timeframe": "xmonth",
      "delta_absolute": 12,
      "delta_direction": "last",
      "inclusive": true,
      "use_dashboard_date_picker": true
    }
  },
  "is_excluded": false,
  "show_in_graph": false,
  "type": "Date",
  "override_global_filter": false
}
```

**Timeframe options:**
- `"month"` — current month (delta_direction: "current")
- `"xmonth"` — last N months (delta_absolute: N, delta_direction: "last")
- `"quarter"` — current quarter
- `"xquarter"` — last N quarters
- `"year"` — current year

## Power Mode — Critical Format Rules

These mistakes cause HTTP 500 or silent data failures with no obvious error message:

### vals array — use `aggregator`, not `func`
```json
"vals": [{ "field": 109772, "name": "Amount", "aggregator": "SUM", "type": "Float" }]
```
`"func": "SUM"` is silently ignored by the API — aggregation becomes null and the data endpoint errors.

### Text filter values — flat array only
```json
{ "field": 109788, "name": "Scenario", "values": ["Actuals"], "type": "Text" }
```
Never use `"values": {"data": ["Actuals"]}` — the `data` wrapper causes HTTP 500 on the data endpoint even though widget creation returns 200.

### Filter values — always raw strings
Write `"P&L"` in spec files, never `"P&amp;L"`. The `api-put-widget.js` script automatically unescapes HTML entities before PUT to prevent double-encoding.

## Authentication for direct API calls

The CLI uses Django session cookies, NOT Bearer JWT:
- `Cookie: sessionid=<session_id>; csrftoken=<csrf_token>`
- `X-CSRFToken: <csrf_token>`
- Credentials stored in OS keychain via `@napi-rs/keyring` (service: `dr-cli`, account: `<SERVER>:<email>`)
- Fallback: `~/.dr/credentials.json` → `servers.<SERVER>.session_id` / `.csrf_token`
- Use `scripts/api-put-widget.js` for widgets blocked from power mode.

## KPI Formatting

Add `"values_format": "$#,###"` to the widget JSON for dollar formatting.
Other formats: `"#,###"` (plain number), `"#,###[kilo]k"` (abbreviated), `"0.00%"` (percentage).

## Widget Types

### 1. KPI (`widgets kpi`)
Single-tile headline number.

| Property | Required | Default | Notes |
|---|---|---|---|
| `--dashboard` | yes | — | dashboard id |
| `--template` | yes | — | template (table) id |
| `--name` | yes | — | display name |
| `--title` | no | `--name` | chart title |
| `--value-field` | yes | — | field name to aggregate |
| `--agg` | no | SUM | SUM, COUNT, COUNT_UNIQUE, UNIQUE_VALUES, AVG, MIN, MAX |
| `--format` | no | money | money, integer, percent, ... |
| `--filter` | no | — | repeatable `"Field=V1,V2"` |
| `--exclude` | no | — | repeatable exclude filter |
| `--contains` | no | — | substring filter |
| `--date-filter` | no | — | date frame filter |
| `--x` | no | 0 | grid column |
| `--y` | no | 0 | grid row |
| `--width` | no | **2** | KPI default is narrow |
| `--height` | no | **3** | KPI default is tall-ish |

### 2. Chart (`widgets chart`)
Column, bar, line, or area chart with modifier flags.

| Property | Required | Default | Notes |
|---|---|---|---|
| `--dashboard` | yes | — | |
| `--template` | yes | — | |
| `--name` | yes | — | |
| `--title` | no | `--name` | |
| `--type` | no | column | column, bar, line, area (or composite presets) |
| `--stacked` | no | false | column/bar/area only |
| `--percent` | no | false | requires `--stacked` |
| `--smooth` | no | false | line only |
| `--group-by` | no | — | row dimension(s), repeatable |
| `--time-by` | no | — | column dimension(s), repeatable |
| `--value-field` | yes | — | |
| `--agg` | no | SUM | SUM, COUNT, COUNT_UNIQUE, AVG, MIN, MAX |
| `--format` | no | money | |
| Filters | no | — | `--filter`, `--exclude`, `--contains`, `--date-filter` |
| `--x` | no | 0 | |
| `--y` | no | 0 | |
| `--width` | no | **6** | half-width default |
| `--height` | no | **4** | |

**Chart sub-types (composite presets):**
- `column` / `column --stacked` / `column --stacked --percent`
- `bar` / `bar --stacked` / `bar --stacked --percent`
- `line` / `line --smooth`
- `area` / `area --stacked` / `area --stacked --percent`

### 3. Pie (`widgets pie`)
Pie chart with optional drilldown.

| Property | Required | Default | Notes |
|---|---|---|---|
| `--dashboard` | yes | — | |
| `--template` | yes | — | |
| `--name` | yes | — | |
| `--title` | no | `--name` | |
| `--group-by` | yes | — | single dimension field — **this is the slice dimension (Axis/Category)** |
| `--value-field` | yes | — | |
| `--agg` | no | SUM | |
| `--format` | no | money | |
| `--drilldown` | no | false | pie-chart-drilldown variant |
| Filters | no | — | standard filter set |
| `--x/y/width/height` | no | 0/0/6/4 | |

**⚠️ Critical — pie chart field placement (CLI bug requires post-create fix):**
- The slice dimension (e.g. Department, Category) MUST end up in `cols` (Axis/Category) in the widget JSON
- **Known CLI bug:** `dr widgets pie --group-by X` places the field into `rows` (Legend/Series) instead of `cols` (Axis/Category). The widget will return data via CLI but render "Something went wrong" in the browser.
- **Mandatory fix after every pie creation:** fetch the widget JSON with `dr widgets get`, move the field from `rows` to `cols`, set `rows` to `[]`, then PUT via `api-put-widget.js`
- Do NOT leave `rows` populated on pie charts — it will break the UI renderer every time
- `rows` on a pie chart = legend grouping for drilldown only; leave empty for a standard pie

### 4. Table (`widgets table`)
Pivot table (`chart_type=table_only`).

| Property | Required | Default | Notes |
|---|---|---|---|
| `--dashboard` | yes | — | |
| `--template` | yes | — | |
| `--name` | yes | — | |
| `--title` | no | `--name` | |
| `--group-by` | no | — | row dimension(s), repeatable |
| `--time-by` | no | — | column dimension(s), repeatable |
| `--value-field` | yes | — | |
| `--agg` | no | SUM | |
| `--format` | no | money | |
| Filters | no | — | standard filter set |
| `--x/y/width/height` | no | 0/0/6/4 | |

### 5. Gauge (`widgets gauge`)
Gauge with two variants. **Cannot be created via power mode** — must use CLI flag command then `api-put-widget.js` to inject full JSON (date picker binding, filters, etc.).

| Property | Required | Default | Notes |
|---|---|---|---|
| `--dashboard` | yes | — | |
| `--template` | yes | — | |
| `--name` | yes | — | |
| `--title` | no | `--name` | |
| `--type` | no | enhanced | See below |
| `--time-by` | conditional | — | **required** for `dynamic-goal`, exactly one field |
| `--value-field` | yes | — | |
| `--agg` | no | SUM | |
| `--format` | no | money | |
| Filters | no | — | standard filter set |
| `--x/y/width/height` | no | 0/0/3/3 | See sizing notes below |

**Gauge minimum sizing:**
- `dynamic-goal` gauges: **minimum 6×4** — the arc, needle, Actuals value, Budget value, and "Current status" label all need room. At 3×3 the widget renders but is too small to read.
- `enhanced` gauges: **3×3 minimum** is acceptable when sitting alongside KPIs
- If placing a dynamic-goal gauge in a KPI row, give it the full remaining width rather than forcing it into a 3×3 slot. Prefer a dedicated row or at least 6 columns.

**When to use which gauge variant:**

| Situation | Variant | `--type` flag |
|---|---|---|
| Metric vs a **dynamic budget/goal** split over time (e.g. Revenue QTD vs Budget QTD) | `dynamic-goal` | `--type dynamic-goal --time-by "Reporting Month"` |
| Metric vs a **single fixed target** | `enhanced` | `--type enhanced` |

**Intent triggers for `dynamic-goal`:** user says "vs budget", "vs target", "vs plan", "vs forecast" + implies a time period. Always use `--time-by "Reporting Month"` and include both Actuals and Budget in the Scenario filter.

**Creation pattern (gauge is blocked from power mode):**
```bash
# Step 1: create via CLI flag command (gets the right chart_type registered)
dr widgets gauge -d <dashboard_id> --template <id> --name "<name>" \
  --value-field "<field>" --type dynamic-goal --time-by "Reporting Month" \
  -x <x> -y <y> --width <w> --height <h> --server <SERVER>

# Step 2: update via direct API to inject date picker binding + full filters
node "[[SCRIPTS_DIR]]api-put-widget.js" \
  <widget_id> <dashboard_id> <widget-json-file> <SERVER>
```

### 6. Waterfall (`widgets waterfall`)
Waterfall chart with two variants.

| Property | Required | Default | Notes |
|---|---|---|---|
| `--dashboard` | yes | — | |
| `--template` | yes | — | |
| `--name` | yes | — | |
| `--title` | no | `--name` | |
| `--type` | no | breakdown | `breakdown` (rows × cols) or `walkthrough` (cols only) |
| `--group-by` | conditional | — | **required** for `breakdown`, exactly one field |
| `--time-by` | yes | — | the axis the waterfall walks across, exactly one |
| `--value-field` | yes | — | |
| `--agg` | no | SUM | |
| `--format` | no | money | |
| Filters | no | — | standard filter set |
| `--x/y/width/height` | no | 0/0/6/4 | |

### 7. Text (`widgets text`)
Rich-text section header / separator.

| Property | Required | Default | Notes |
|---|---|---|---|
| `--dashboard` | yes | — | |
| `--name` | no | "" | internal display name |
| `--text` | yes | — | header text (plain text or HTML) |
| `--x` | no | 0 | |
| `--y` | no | 0 | |
| `--width` | no | **12** | full-width default |
| `--height` | no | **3** | |

**No template, value-field, or filters** — this is a layout/label widget, not data-driven.

### 8. Published Item (`widgets published-item`)
References an existing published item. **NOT IMPLEMENTED** — throws on invocation. Use `widgets create --file` with `chart_type: "published_item"` as a workaround.

### 9. Power Mode (`widgets create --file`)
Bypass the flag-driven creators entirely. Pass a raw JSON file with the full widget body. Required for:
- Published items
- Any widget config not expressible via flags
- Bulk/scripted creation

## Dashboard Commands

| Command | Purpose |
|---|---|
| `dashboards list` | List all dashboards (id, name) |
| `dashboards create --name <s>` | Create empty dashboard, returns id |
| `dashboards delete <id>` | Two-step confirm delete |
| `dashboards prepare <id>` | Refresh/prepare all widgets on a dashboard |

## Common Patterns & Gotchas

### Sizing defaults by widget type
| Type | Default width | Default height | Notes |
|---|---|---|---|
| KPI | 3 | 3 | |
| Chart | 6 | 6 | Taller to prevent axis label overlap/truncation |
| Pie | 6 | 6 | Taller to fit legend without clipping |
| Table | 6 | 6 | Content-aware — see planner for row-count sizing |
| Gauge | 6 | 5 | Needs room for arc, needle, value labels |
| Waterfall | 6 | 6 | |
| Text | 12 | 2 | |

### Grid math for common layouts
- **6 KPIs across top:** each width=2, x=0/2/4/6/8/10, y=0, height=3
- **2 charts side-by-side:** each width=6, x=0 and x=6, same y
- **Full-width table:** width=12, x=0
- **3 equal columns:** each width=4, x=0/4/8

### Known issues (from Performance Tracker session)
1. **No overlap protection** — API accepts overlapping widgets; must compute grid manually
2. **"No Data Available"** — usually means wrong template id, field name mismatch, or filters too restrictive
3. **Widget sizing is unintuitive** — height units don't correspond to pixels predictably; trial-and-error required
4. **No batch create** — widgets must be created one at a time via CLI
5. **No layout read-back as grid** — `widgets list` returns individual widget data, not a visual grid representation
