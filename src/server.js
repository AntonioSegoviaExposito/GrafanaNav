#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BASE, datasource, exploreUrl, listDatasources, lokiLabels, lokiRange, toNs } from './grafana.js';

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const MAX_VALUES = 500;
const pad = (n, width = 2) => String(n).padStart(width, '0');
const nsToMs = (ns) => Number(BigInt(ns) / 1_000_000n);
const pairsOf = (labels) => Object.entries(labels).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
function cut(line, max, mode = 'tail') {
  if (!max || line.length <= max) return line;
  const omitted = line.length - max;
  if (mode === 'middle') {
    const head = Math.ceil(max / 2);
    return `${line.slice(0, head)}… [+${omitted} chars] …${line.slice(line.length - (max - head))}`;
  }
  return `${line.slice(0, max)}… [+${omitted} chars]`;
}

function compileExtract(pattern) {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, 'g');
  } catch (e) {
    throw new Error(`Invalid \`extract\` regex: ${e.message}`);
  }
}

function formatLine(line, max, truncate, matcher) {
  if (!matcher) return cut(line, max, truncate);
  const hits = Array.from(line.matchAll(matcher), m => m[0]).filter(Boolean);
  return hits.length ? cut(hits.join('  ⋯  '), max, truncate) : '(no `extract` match in line)';
}

function stamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

// Log entries of every stream merged in query order. Labels shared by all streams print once; the rest go to a legend.
function streams(result, { limit, direction, maxLineLength, truncate, matcher }) {
  const entries = result.flatMap((s, i) => s.values.map(([ns, line]) => ({ ns: BigInt(ns), line, i })));
  if (!entries.length) return ['No log lines match in this range.'];
  const order = direction === 'forward' ? 1 : -1;
  entries.sort((a, b) => order * (a.ns < b.ns ? -1 : a.ns > b.ns ? 1 : 0));
  const capped = entries.length >= limit;
  if (entries.length > limit) entries.length = limit;

  const pairs = result.map(s => pairsOf(s.stream));
  const common = pairs[0].filter(p => pairs.every(list => list.includes(p)));
  const multi = result.length > 1;
  const out = [`${entries.length} lines from ${result.length} stream${multi ? 's' : ''}`];
  if (common.length) out.push(`labels: {${common.join(', ')}}`);
  if (multi) out.push(...pairs.map((list, i) => `s${i + 1}: {${list.filter(p => !common.includes(p)).join(', ')}}`));
  out.push('');
  for (const e of entries) out.push(`${stamp(nsToMs(e.ns))}  ${multi ? `s${e.i + 1}  ` : ''}${formatLine(e.line, maxLineLength, truncate, matcher).replace(/\n/g, '\n    ')}`);
  if (capped) {
    const edge = entries.at(-1).ns;
    out.push('', `Limit of ${limit} lines reached. Next page: same query with ${direction === 'forward' ? 'from' : 'to'}="${edge}" (the boundary line may repeat), or narrow the query.`);
  }
  return out;
}

function series(type, result) {
  if (type === 'scalar') return [`${stamp(result[0] * 1000)}  ${result[1]}`];
  if (!result.length) return ['No series in this range.'];
  const out = [`${result.length} series`];
  for (const s of result) {
    out.push('', `{${pairsOf(s.metric).join(', ')}}`);
    for (const [t, v] of s.values ?? [s.value]) out.push(`  ${stamp(t * 1000)}  ${v}`);
  }
  return out;
}

const server = new McpServer(
  { name: 'grafana-nav', version: '1.0.0' },
  {
    instructions: [
      'Grafana Loki logs, read with the user\'s Grafana web session taken from Firefox (or Zen, LibreWolf, Waterfox, Floorp).',
      'Typical flow: loki_datasources when unsure which Loki to read, loki_labels to discover label names and then their values, loki_query with a LogQL selector built from those labels.',
      'Start with short ranges (the default is the last hour) and widen only when needed.',
      'When a tool says the session is missing or rejected, ask the user to open Grafana in that browser and sign in, then call the tool again.',
    ].join(' '),
  },
);

function tool(name, config, run) {
  server.registerTool(name, config, async (args) => {
    try {
      return { content: [{ type: 'text', text: await run(args) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `ERR ${e.message}` }], isError: true };
    }
  });
}

const TIME = 'now, now-<n><s|m|h|d|w> (e.g. now-30m), a date such as 2026-02-11 or 11/02/2026 (start of day in `from`, end of day in `to`), an ISO timestamp such as 2026-01-31T10:00:00Z (without zone = local time), or epoch seconds, milliseconds or nanoseconds';
const DATASOURCE = z.string().optional().describe('Loki datasource name or uid, from loki_datasources. Omit to use LOKI_DATASOURCE, or the only or default Loki datasource.');
const FROM = z.string().optional().describe(`Start of the range (default now-1h): ${TIME}.`);
const TO = z.string().optional().describe(`End of the range (default now): ${TIME}.`);

tool(
  'loki_datasources',
  {
    title: 'List Loki datasources',
    description: 'List the Loki datasources of the Grafana instance (uid and name) that the signed-in user can read, marking the one the other tools use when `datasource` is omitted. Pass a name or uid as `datasource` to loki_labels or loki_query to read another one.',
    inputSchema: {},
  },
  async () => {
    const list = await listDatasources();
    const rows = list.map(d => `${d.uid}  ${d.name}${d.isDefault ? '  [Grafana default]' : ''}${d.used ? '  ← used when `datasource` is omitted' : ''}`);
    const note = list.length && !list.some(d => d.used) ? ['', 'None is used by default: pass `datasource` to loki_labels and loki_query.'] : [];
    return [`LOKI DATASOURCES  ·  ${list.length}  ·  ${BASE}`, '', ...(rows.length ? rows : ['None.']), ...note].join('\n');
  },
);

tool(
  'loki_labels',
  {
    title: 'Discover Loki labels and values',
    description: [
      'Discover what can go in a LogQL stream selector.',
      '- Without `label`: the label names seen in the range.',
      '- With `label`: the values of that label seen in the range.',
      'Pass `selector` (a stream selector such as {env="prod"}) to only consider the streams it matches, e.g. the services that log in one environment. `contains` keeps names or values that include a text (case-insensitive). At most 500 rows are listed; the header gives the total.',
    ].join('\n'),
    inputSchema: {
      label: z.string().optional().describe('Label whose values to list. Omit to list label names.'),
      selector: z.string().optional().describe('Stream selector that limits the streams considered, e.g. {env="prod", app=~"api.*"}.'),
      contains: z.string().optional().describe('Keep only names or values containing this text (case-insensitive).'),
      from: FROM,
      to: TO,
      datasource: DATASOURCE,
    },
  },
  async ({ label, selector, contains, from = 'now-1h', to = 'now', datasource: name }) => {
    const ds = await datasource(name);
    const start = toNs(from);
    const end = toNs(to, { endOfDay: true });
    if (start >= end) throw new Error('`from` must be earlier than `to`.');
    const { data = [] } = await lokiLabels(ds, label ? `label/${encodeURIComponent(label)}/values` : 'labels', { start, end, query: selector });
    const needle = contains?.toLowerCase();
    const all = needle ? data.filter(v => v.toLowerCase().includes(needle)) : data;
    const head = `${label ? `VALUES ${label}` : 'LABELS'}  ·  ${all.length}${contains ? ` containing "${contains}"` : ''}  ·  ${ds.name}${selector ? `  ·  ${selector}` : ''}`;
    const lines = all.length ? all.slice(0, MAX_VALUES) : [`None in this range${selector ? ' for this selector' : ''}.`];
    if (all.length > MAX_VALUES) lines.push('', `… ${all.length - MAX_VALUES} more: narrow with \`contains\` or \`selector\`.`);
    return [head, '', ...lines].join('\n');
  },
);

tool(
  'loki_query',
  {
    title: 'Run a LogQL query',
    description: [
      'Run any LogQL query against Loki through Grafana and print the result.',
      '',
      'Log queries return lines, newest first by default: {app="api", env="prod"} |= "timeout"',
      '- Stream selector, required: {label="value"}, also != , =~ "regex" , !~. Some Loki servers require several equality matchers; the error says so.',
      '- Line filters, chainable: |= "text", != "text", |~ "regex", !~ "regex".',
      '- Parsers, then label filters on the extracted fields: | json, | logfmt, | pattern "<ip> <_> <status>", | regexp "(?P<status>\\d{3})", then | status >= 500, | level="error".',
      '- Reshape: | line_format "{{.message}}", | label_format, | keep, | drop.',
      '',
      'Metric queries return series: sum by (level) (count_over_time({app="api"} |= "error" [5m])); also rate, bytes_over_time, and quantile_over_time(0.95, {app="api"} | json | unwrap duration [5m]) by (route). `step` sets the distance between points.',
      '',
      'Output: a header with result type, datasource and range (local time). Log results list the labels shared by all streams once, then one line per entry: "<time>  [sN]  <line>", where sN points to the stream legend when several streams match. Lines longer than `maxLineLength` are cut at the end (`truncate: "tail"`, default) or in the middle keeping start and end (`truncate: "middle"`). Pass `extract` (a JS regex) to print only matching fragments from huge lines instead of the whole payload. When the limit is reached, the footer gives the `to` (or `from`) of the next page. Metric results print each series\' labels followed by "<time>  <value>" rows.',
      'Errors start with ERR and carry Loki\'s message: syntax errors with line and column, missing matchers, or too much data (narrow the selector or the range).',
    ].join('\n'),
    inputSchema: {
      query: z.string().min(1).describe('LogQL expression, e.g. {app="api", env="prod"} |= "error" | json | line_format "{{.message}}".'),
      from: FROM,
      to: TO,
      limit: z.number().int().min(1).max(5000).optional().describe('Maximum log lines (default 100). Ignored by metric queries.'),
      direction: z.enum(['backward', 'forward']).optional().describe('backward = newest first (default), forward = oldest first.'),
      step: z.string().optional().describe('Metric queries: distance between points, e.g. 30s, 5m, 1h. Omit to let Loki choose.'),
      maxLineLength: z.number().int().min(0).optional().describe('Cut log lines longer than this many characters (default 1000; 0 = never cut).'),
      truncate: z.enum(['tail', 'middle']).optional().describe('Where to cut lines exceeding `maxLineLength`: "tail" (default, keeps the start) or "middle" (keeps head + tail).'),
      extract: z.string().min(1).optional().describe('Optional JS regex applied to each log line; prints only the matching fragments (e.g. "shippingDataInfo.{0,400}|purpose.{0,40}") instead of the full line.'),
      link: z.boolean().optional().describe('Also return a Grafana Explore link with this query and range, to share or open in the browser.'),
      datasource: DATASOURCE,
    },
  },
  async ({ query, from = 'now-1h', to = 'now', limit = 100, direction = 'backward', step, maxLineLength = 1000, truncate = 'tail', extract, link = false, datasource: name }) => {
    const ds = await datasource(name);
    const start = toNs(from);
    const end = toNs(to, { endOfDay: true });
    if (start >= end) throw new Error('`from` must be earlier than `to`.');
    const matcher = compileExtract(extract);
    const { data } = await lokiRange(ds, { query, start, end, limit, direction, step });
    const head = `${data.resultType.toUpperCase()}  ·  ${ds.name}  ·  ${stamp(nsToMs(start))} → ${stamp(nsToMs(end))} ${TZ}`;
    const body = data.resultType === 'streams' ? streams(data.result, { limit, direction, maxLineLength, truncate, matcher }) : series(data.resultType, data.result);
    return [head, '', ...body, ...(link ? ['', `Explore: ${exploreUrl(ds, query, from, to)}`] : [])].join('\n');
  },
);

await server.connect(new StdioServerTransport());
