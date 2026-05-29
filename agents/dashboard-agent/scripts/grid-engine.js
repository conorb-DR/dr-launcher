#!/usr/bin/env node
/**
 * grid-engine.js
 * Dashboard Agent — Grid Layout Engine
 *
 * Usage:
 *   node grid-engine.js <spec-file>             Validate + compute positions, print visual grid
 *   node grid-engine.js <spec-file> --write     Also write positions back into spec file
 *   node grid-engine.js <spec-file> --json      Output updated spec JSON to stdout (no visual)
 *   node grid-engine.js <spec-file> --commands  Print CLI commands to stdout (requires dashboard.id)
 *
 * The engine reads a dashboard-spec.json, assigns (x,y,width,height) to any
 * widgets that don't have a layout yet, validates there are no overlaps,
 * and renders a visual grid to stderr (so stdout stays clean for --json).
 */

import fs from 'fs';
import path from 'path';

const GRID_COLS = 12;

// Default sizes per widget type (content-aware defaults from dashboard-plan skill)
const DEFAULT_SIZES = {
  kpi:       { width: 3, height: 3 },  // 4 across a 12-col row
  chart:     { width: 6, height: 6 },  // half-width, tall enough for axis labels
  pie:       { width: 6, height: 6 },  // half-width, tall enough for legend
  table:     { width: 6, height: 6 },  // overridden by content-aware sizing in planner
  gauge:     { width: 6, height: 5 },  // needs room for arc, needle, labels
  waterfall: { width: 6, height: 6 },
  text:      { width: 12, height: 2 }, // full-width header, slim
};

// ─── Validation ────────────────────────────────────────────────────────────

function validateWidget(w) {
  const errors = [];
  if (!w.id_local) errors.push('missing id_local');
  if (!w.type) errors.push('missing type');
  if (!w.name) errors.push('missing name');
  if (w.type !== 'text') {
    if (!w.data?.template_id) errors.push('missing data.template_id');
    if (!w.data?.value_field) errors.push('missing data.value_field');
  }
  if (w.type === 'text' && !w.text_content) errors.push('missing text_content');
  // Validate power mode vals array — aggregator required, func is silently ignored
  if (w.data?.vals) {
    w.data.vals.forEach((v, i) => {
      if (v.func && !v.aggregator) errors.push(`vals[${i}]: use "aggregator" not "func" (func is silently ignored by the API)`);
    });
  }
  // Validate filter values — no {"data": [...]} wrapper
  if (w.data?.filters) {
    w.data.filters.forEach((f, i) => {
      if (f.values && typeof f.values === 'object' && !Array.isArray(f.values) && f.values.data) {
        errors.push(`filters[${i}] "${f.name}": values must be a flat array, not {"data": [...]} — causes HTTP 500`);
      }
    });
  }
  if (w.type === 'waterfall' && w.type_options?.waterfall_type === 'breakdown' && !w.data?.group_by?.length) {
    errors.push('waterfall breakdown requires group_by');
  }
  if (w.type === 'gauge' && w.type_options?.gauge_type === 'dynamic-goal' && !w.data?.time_by?.length) {
    errors.push('gauge dynamic-goal requires time_by');
  }
  // Pie chart: slice dimension must be in group_by (Axis/Category), never in rows (Legend/Series).
  // The CLI has a known bug: `dr widgets pie --group-by X` puts X into rows (Series),
  // but the UI renderer requires it in cols (Axis/Category). The build skill must correct
  // this via api-put-widget.js after creation.
  if (w.type === 'pie') {
    if (!w.data?.group_by?.length) {
      errors.push('pie chart: missing group_by — the slice dimension MUST go in group_by (Axis/Category). Without it the widget renders "Something went wrong" in the UI');
    }
    if (w.data?.group_by?.length && w.data?.time_by?.length) {
      errors.push('pie chart: do not set time_by — pie charts have no time axis. Use group_by only for the slice dimension');
    }
  }
  // Date range vs chart width: max 12 months at width 6, otherwise require width 12
  if ((w.type === 'chart' || w.type === 'waterfall') && w.data?.time_by?.length && w.layout) {
    const df = (w.data?.date_filters || [])[0];
    if (df) {
      const monthMatch = df.match(/(\d+)/);
      const months = monthMatch ? parseInt(monthMatch[1], 10) : 12;
      if (months > 12 && w.layout.width < 12) {
        errors.push(`chart spans ${months} months but width is ${w.layout.width} — x-axis labels will overlap. Use width 12 or cap the date range to 12 months`);
      }
    }
  }
  return errors;
}

// ─── Layout engine ─────────────────────────────────────────────────────────

// Row-band ordering: widgets are grouped by type tier, placed tier by tier.
// This ensures KPIs sit together, charts sit together, tables at the bottom.
const TYPE_TIER = {
  text:      0,  // section headers first
  kpi:       1,  // summary numbers
  gauge:     1,  // gauges sit alongside KPIs in the same tier
  chart:     2,  // visualisations
  pie:       2,
  waterfall: 2,
  table:     3,  // detail grids last
};

/**
 * Auto-assign positions to widgets that don't have a layout.
 * Strategy: row-band packing.
 *   1. Group unpositioned widgets by type tier (KPIs+gauges, charts+pies, tables).
 *   2. Within each tier, normalize heights so every widget in the same row band
 *      shares the same height (tallest in the group wins).
 *   3. Pack each tier left-to-right, top-to-bottom.
 * Widgets with explicit layout are placed first and their space is reserved.
 */
function assignLayouts(widgets) {
  const sized = widgets.map(w => ({
    ...w,
    layout: w.layout ?? {
      x: null,
      y: null,
      width: DEFAULT_SIZES[w.type]?.width ?? 6,
      height: DEFAULT_SIZES[w.type]?.height ?? 6,
    }
  }));

  // Build occupancy map: occupancy[y][x] = id_local
  const occupancy = {};

  const occupy = (w) => {
    for (let row = w.layout.y; row < w.layout.y + w.layout.height; row++) {
      if (!occupancy[row]) occupancy[row] = {};
      for (let col = w.layout.x; col < w.layout.x + w.layout.width; col++) {
        occupancy[row][col] = w.id_local;
      }
    }
  };

  const isFree = (x, y, width, height) => {
    for (let row = y; row < y + height; row++) {
      for (let col = x; col < x + width; col++) {
        if (occupancy[row]?.[col]) return false;
      }
    }
    if (x + width > GRID_COLS) return false;
    return true;
  };

  const findNextFreePosition = (width, height) => {
    let y = 0;
    while (true) {
      for (let x = 0; x <= GRID_COLS - width; x++) {
        if (isFree(x, y, width, height)) return { x, y };
      }
      y++;
      if (y > 200) throw new Error('Grid overflow — too many widgets or sizing issue');
    }
  };

  // First pass: reserve explicitly-positioned widgets
  for (const w of sized) {
    if (w.layout.x !== null && w.layout.y !== null) {
      occupy(w);
    }
  }

  // Second pass: group unpositioned widgets by type tier, then pack tier by tier
  const unpositioned = sized.filter(w => w.layout.x === null || w.layout.y === null);
  const tiers = {};
  for (const w of unpositioned) {
    const tier = TYPE_TIER[w.type] ?? 2;
    if (!tiers[tier]) tiers[tier] = [];
    tiers[tier].push(w);
  }

  // Process tiers in order (0=text, 1=kpi+gauge, 2=chart+pie, 3=table)
  for (const tierKey of Object.keys(tiers).sort((a, b) => a - b)) {
    const group = tiers[tierKey];

    // Normalize heights within this tier: all widgets get the tallest height
    const maxHeight = Math.max(...group.map(w => w.layout.height));
    for (const w of group) {
      w.layout.height = maxHeight;
    }

    // Pack left-to-right
    for (const w of group) {
      const pos = findNextFreePosition(w.layout.width, w.layout.height);
      w.layout.x = pos.x;
      w.layout.y = pos.y;
      occupy(w);
    }
  }

  return { widgets: sized, occupancy };
}

// ─── Row-height consistency check ─────────────────────────────────────────

function detectRowHeightMismatches(widgets) {
  // Group widgets by their starting y position (same row band)
  const rowBands = {};
  for (const w of widgets) {
    const y = w.layout.y;
    if (!rowBands[y]) rowBands[y] = [];
    rowBands[y].push(w);
  }

  const mismatches = [];
  for (const [y, band] of Object.entries(rowBands)) {
    if (band.length < 2) continue;
    const heights = [...new Set(band.map(w => w.layout.height))];
    if (heights.length > 1) {
      const names = band.map(w => `${w.id_local}(h=${w.layout.height})`).join(', ');
      mismatches.push(`row y=${y}: widgets have mismatched heights [${names}] — all widgets in a row must share the same height`);
    }
  }
  return mismatches;
}

// ─── Overlap detection ─────────────────────────────────────────────────────

function detectOverlaps(widgets) {
  const overlaps = [];
  for (let i = 0; i < widgets.length; i++) {
    for (let j = i + 1; j < widgets.length; j++) {
      const a = widgets[i].layout;
      const b = widgets[j].layout;
      const xOverlap = a.x < b.x + b.width && a.x + a.width > b.x;
      const yOverlap = a.y < b.y + b.height && a.y + a.height > b.y;
      if (xOverlap && yOverlap) {
        overlaps.push({ a: widgets[i].id_local, b: widgets[j].id_local });
      }
    }
  }
  return overlaps;
}

// ─── Visual grid renderer ───────────────────────────────────────────────────

function renderGrid(widgets, dashboardName) {
  if (!widgets.length) return '(no widgets)';

  const maxRow = Math.max(...widgets.map(w => w.layout.y + w.layout.height));

  // CELL_W chars per grid column. Inner content width = GRID_COLS * CELL_W.
  // Border chars sit outside that: one │ on each side = total line = INNER + 2.
  const CELL_W = 7;
  const INNER = GRID_COLS * CELL_W; // 84
  const sep   = '─'.repeat(INNER);  // reused for all horizontal rules

  // Build a lookup: widgetAt[row][col] = widget (or undefined)
  const widgetAt = {};
  for (const w of widgets) {
    for (let r = w.layout.y; r < w.layout.y + w.layout.height; r++) {
      if (!widgetAt[r]) widgetAt[r] = {};
      for (let c = w.layout.x; c < w.layout.x + w.layout.width; c++) {
        widgetAt[r][c] = w;
      }
    }
  }

  const pad = (s, n) => {
    const str = String(s ?? '');
    return str.length >= n ? str.slice(0, n) : str + ' '.repeat(n - str.length);
  };

  const lines = [];

  // ── Header ──
  lines.push(`┌${sep}┐`);
  lines.push(`│ ${pad(`Dashboard: ${dashboardName}`, INNER - 2)} │`);
  lines.push(`│ ${pad(`${GRID_COLS}-col grid   ${maxRow} rows   ${widgets.length} widgets`, INNER - 2)} │`);
  lines.push(`├${sep}┤`);

  // ── Column numbers ──
  let colNums = '│';
  for (let c = 0; c < GRID_COLS; c++) {
    colNums += pad(c, CELL_W);
  }
  colNums += '│';
  lines.push(colNums);
  lines.push(`├${sep}┤`);

  // ── Grid rows ──
  for (let row = 0; row < maxRow; row++) {
    // For each grid row we render CELL_H sub-lines per widget height unit,
    // but since heights are in grid units we just render 1 text line per row.
    // We show: top border, name line (mid), type+dims line (mid+1), bottom border.
    // With CELL_W=7 we just pick the most informative single line per row.

    let line = '│';
    let col = 0;
    while (col < GRID_COLS) {
      const w = widgetAt[row]?.[col];
      if (!w) {
        line += ' '.repeat(CELL_W);
        col++;
        continue;
      }

      // This widget spans from w.layout.x to w.layout.x + w.layout.width
      // We're at the leftmost col of this widget in this row.
      const wCols  = w.layout.width;
      const wRows  = w.layout.height;
      const cellW  = wCols * CELL_W;   // total chars for this widget
      const isTop  = row === w.layout.y;
      const isBot  = row === w.layout.y + wRows - 1;
      const midRow = w.layout.y + Math.floor(wRows / 2);
      const dimRow = midRow + 1;

      let content;
      if (isTop && isBot) {
        // Single-row widget — show name + type squeezed together
        content = `┤ ${w.name} [${w.type}] ${w.layout.width}×${w.layout.height} ├`;
      } else if (isTop) {
        const label = `┤ ${w.name} ├`;
        content = pad(label, cellW);
      } else if (isBot) {
        content = `└${'─'.repeat(cellW - 2)}┘`;
      } else if (row === midRow) {
        const label = `  [${w.type}]`;
        content = pad(label, cellW);
      } else if (row === dimRow) {
        const label = `  ${w.layout.width}×${w.layout.height}`;
        content = pad(label, cellW);
      } else {
        content = ' '.repeat(cellW);
      }

      // Clamp to cellW exactly
      if (content.length < cellW) content = content + ' '.repeat(cellW - content.length);
      if (content.length > cellW) content = content.slice(0, cellW);

      line += content;
      col += wCols;
    }
    line += '│';
    lines.push(line);
  }

  lines.push(`└${sep}┘`);

  // ── Widget legend ──
  lines.push('');
  lines.push('Widgets:');
  for (const w of widgets) {
    const status = w.status ? ` [${w.status}]` : '';
    const data   = w.type !== 'text'
      ? ` │ template:${w.data?.template_id}  field:${w.data?.value_field}`
      : '';
    lines.push(
      `  ${pad(w.id_local, 4)} ${pad(w.name, 28)} ${pad(w.type, 10)}` +
      ` @ x${w.layout.x},y${w.layout.y}  ${w.layout.width}×${w.layout.height}${data}${status}`
    );
  }

  return lines.join('\n');
}

// ─── CLI command builder ────────────────────────────────────────────────────

export function buildCliCommand(w, dashboardId, server) {
  if (!w.layout) throw new Error(`Widget ${w.id_local} has no layout`);

  const base = `dr widgets ${w.type}`;
  const pos = `-x ${w.layout.x} -y ${w.layout.y} --width ${w.layout.width} --height ${w.layout.height}`;
  const dash = `-d ${dashboardId}`;
  const srv = `-s ${server}`;
  const nameFlag = `--name "${w.name}"`;

  if (w.type === 'text') {
    return `${base} ${dash} ${nameFlag} --text "${w.text_content}" ${pos} ${srv}`;
  }

  const d = w.data;
  const tmpl = `--template ${d.template_id}`;
  const val = `--value-field "${d.value_field}"`;
  const agg = d.agg ? `--agg ${d.agg}` : '';
  const fmt = d.format ? `--format ${d.format}` : '';

  const groupBy = (d.group_by || []).map(f => `--group-by "${f}"`).join(' ');
  const timeBy = (d.time_by || []).map(f => `--time-by "${f}"`).join(' ');
  const filters = (d.filters || []).map(f => `--filter "${f}"`).join(' ');
  const excludes = (d.excludes || []).map(f => `--exclude "${f}"`).join(' ');
  const contains = (d.contains || []).map(f => `--contains "${f}"`).join(' ');
  const dateFilters = (d.date_filters || []).map(f => `--date-filter "${f}"`).join(' ');

  let typeFlags = '';
  const o = w.type_options || {};
  if (w.type === 'chart') {
    typeFlags = [
      o.chart_type ? `--type ${o.chart_type}` : '',
      o.stacked ? '--stacked' : '',
      o.percent ? '--percent' : '',
      o.smooth ? '--smooth' : '',
    ].filter(Boolean).join(' ');
  } else if (w.type === 'pie') {
    typeFlags = o.drilldown ? '--drilldown' : '';
  } else if (w.type === 'gauge') {
    typeFlags = o.gauge_type ? `--type ${o.gauge_type}` : '';
  } else if (w.type === 'waterfall') {
    typeFlags = o.waterfall_type ? `--type ${o.waterfall_type}` : '';
  }

  const parts = [base, dash, tmpl, nameFlag, val, agg, fmt, groupBy, timeBy, typeFlags, filters, excludes, contains, dateFilters, pos, srv];
  return parts.filter(Boolean).join(' ');
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const specFile = args.find(a => !a.startsWith('--'));
  const writeBack = args.includes('--write');
  const jsonOut = args.includes('--json');
  const commandsOnly = args.includes('--commands');

  if (!specFile) {
    console.error('Usage: node grid-engine.js <spec-file> [--write] [--json]');
    process.exit(1);
  }

  const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
  const widgets = spec.widgets;

  // Validate each widget
  const validationErrors = [];
  for (const w of widgets) {
    const errs = validateWidget(w);
    if (errs.length) validationErrors.push(`${w.id_local} (${w.name}): ${errs.join(', ')}`);
  }
  if (validationErrors.length) {
    console.error('Validation errors:');
    validationErrors.forEach(e => console.error('  ✗ ' + e));
    process.exit(1);
  }

  // Assign layouts
  const { widgets: laid } = assignLayouts(widgets);

  // Check overlaps
  const overlaps = detectOverlaps(laid);
  if (overlaps.length) {
    console.error('Overlap errors:');
    overlaps.forEach(o => console.error(`  ✗ ${o.a} overlaps ${o.b}`));
    process.exit(1);
  }

  // Check row-height consistency
  const heightMismatches = detectRowHeightMismatches(laid);
  if (heightMismatches.length) {
    console.error('Row-height alignment errors:');
    heightMismatches.forEach(m => console.error(`  ✗ ${m}`));
    process.exit(1);
  }

  // Update spec
  spec.widgets = laid;
  spec.meta.stage = spec.meta.stage === 'draft' ? 'planned' : spec.meta.stage;

  if (jsonOut) {
    console.log(JSON.stringify(spec, null, 2));
    return;
  }

  // Commands-only mode: print CLI commands to stdout, one per line
  if (commandsOnly) {
    if (!spec.dashboard.id) {
      console.error('--commands requires dashboard.id to be set in spec');
      process.exit(1);
    }
    for (const w of laid) {
      try {
        console.log(buildCliCommand(w, spec.dashboard.id, spec.meta.server));
      } catch (e) {
        console.error(`✗ ${w.id_local}: ${e.message}`);
      }
    }
    return;
  }

  // Visual grid to stderr
  console.error(renderGrid(laid, spec.dashboard.name));

  // CLI commands preview
  if (spec.dashboard.id) {
    console.error('\nCLI commands:');
    for (const w of laid) {
      try {
        console.error('  ' + buildCliCommand(w, spec.dashboard.id, spec.meta.server));
      } catch (e) {
        console.error(`  ✗ ${w.id_local}: ${e.message}`);
      }
    }
  }

  if (writeBack) {
    fs.writeFileSync(specFile, JSON.stringify(spec, null, 2));
    console.error(`\nSpec written back to ${specFile}`);
  }
}

main();
