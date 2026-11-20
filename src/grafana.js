import { createHash } from 'crypto';
import { setTimeout as delay } from 'timers/promises';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { BROWSERS, firefoxCookie } from './firefox.js';

export const BASE = (process.env.GRAFANA_URL ?? '').trim().replace(/\/+$/, '');
const DEFAULT_DATASOURCE = process.env.LOKI_DATASOURCE?.trim();
const DATASOURCES_TTL = 60 * 60_000;

// One cache folder per Grafana URL: browser session and Loki datasources.
export const CACHE = join(tmpdir(), 'grafana-nav', createHash('sha256').update(BASE).digest('hex').slice(0, 12));

async function load(name, fallback) {
  try {
    return JSON.parse(await readFile(join(CACHE, name), 'utf-8'));
  } catch {
    return fallback;
  }
}

// Atomic write: several MCP clients may share the cache folder.
async function save(name, data) {
  const file = join(CACHE, name);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
  await rename(tmp, file);
}

// ---- HTTP with the browser session: the cached cookie first, a fresh one from the browser when Grafana rejects it.

let session; // { cookie, profile, savedAt }

async function refreshSession() {
  session = { ...(await firefoxCookie(BASE)), savedAt: Date.now() };
  await save('session.json', session);
}

function errorText(body) {
  try {
    const json = JSON.parse(body);
    return json.message ?? json.error ?? body;
  } catch {
    return body.trim().slice(0, 1000) || '(empty response)';
  }
}

const RETRY_DELAYS_MS = [500, 1200];
let queue = Promise.resolve();

// Serialize HTTP calls through Grafana so parallel MCP tool invocations do not trip WAF/rate-limit bursts.
function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

export function grafana(path, params) {
  return enqueue(() => grafanaRequest(path, params));
}

async function grafanaRequest(path, params) {
  if (!BASE) throw new Error('GRAFANA_URL is not set: start the server with GRAFANA_URL set to the Grafana address you open in the browser, e.g. https://grafana.example.com');
  const url = `${BASE}${path}${params ? `?${new URLSearchParams(params)}` : ''}`;
  session ??= await load('session.json', null);
  let fresh = false;
  if (!session) {
    await refreshSession();
    fresh = true;
  }
  for (let attempt = 0; ;) {
    const res = await fetch(url, { headers: { Cookie: session.cookie, Accept: 'application/json' }, redirect: 'manual' });
    if (res.status === 401 || (res.status >= 300 && res.status < 400)) {
      if (fresh) throw new Error(`Grafana rejected the browser session (HTTP ${res.status}). Open ${BASE} in ${BROWSERS}, sign in, and call the tool again.`);
      await refreshSession();
      fresh = true;
      continue;
    }
    if ((res.status === 403 || res.status === 429) && attempt < RETRY_DELAYS_MS.length) {
      await res.body?.cancel();
      await delay(RETRY_DELAYS_MS[attempt++]);
      continue;
    }
    const body = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${errorText(body)}`);
    return JSON.parse(body);
  }
}

// ---- Loki datasources, read from the settings Grafana gives its own frontend (visible to any signed-in user).

async function datasources(refresh = false) {
  const cached = await load('datasources.json', null);
  if (!refresh && cached && Date.now() - cached.savedAt < DATASOURCES_TTL) return cached.list;
  const { datasources: all } = await grafana('/api/frontend/settings');
  const list = Object.values(all ?? {})
    .filter(d => d.type === 'loki')
    .map(d => ({ name: d.name, uid: d.uid, isDefault: Boolean(d.isDefault) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  await save('datasources.json', { savedAt: Date.now(), list });
  return list;
}

const names = (list) => list.map(d => `${d.name} (uid ${d.uid})`).join(', ');

// The datasource `wanted` (name or uid); without it LOKI_DATASOURCE, else the only or the default Loki datasource.
export async function datasource(wanted = DEFAULT_DATASOURCE) {
  let list = await datasources();
  const match = () => list.find(d => d.uid === wanted || d.name.toLowerCase() === wanted.toLowerCase());
  if (wanted && !match()) list = await datasources(true);
  if (!list.length) throw new Error('this Grafana has no Loki datasource the signed-in user can read.');
  if (wanted) {
    const hit = match();
    if (hit) return hit;
    throw new Error(`no Loki datasource "${wanted}". Available: ${names(list)}`);
  }
  const pick = list.length === 1 ? list[0] : list.find(d => d.isDefault);
  if (pick) return pick;
  throw new Error(`several Loki datasources and none is the default: pass \`datasource\` (name or uid) or start the server with LOKI_DATASOURCE. Available: ${names(list)}`);
}

export async function listDatasources() {
  const list = await datasources(true);
  const used = await datasource().catch(() => null);
  return list.map(d => ({ ...d, used: d.uid === used?.uid }));
}

// Loki HTTP API through Grafana's datasource proxy.
export function loki(ds, endpoint, params) {
  return grafana(`/api/datasources/proxy/uid/${encodeURIComponent(ds.uid)}/loki/api/v1/${endpoint}`, params);
}

const CHUNK_NS = 12n * 3600n * 1_000_000_000n;
const RANGE_TOO_LONG_RE = /max_query_length|query_range.*exceed|time range exceeds|exceeds the maximum|too long.*range/i;

function parseDurationNs(raw) {
  let total = 0;
  for (const [, n, u] of raw.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h|d|w)/g)) {
    const mult = { ns: 1e-6, us: 1e-3, µs: 1e-3, ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[u];
    total += Number(n) * mult;
  }
  return total > 0 ? BigInt(Math.floor(total * 0.9)) * 1_000_000n : CHUNK_NS;
}

function chunkSizeNs(err) {
  const hint = /(?:limit|max(?:imum)?|exceeds)[^0-9]*((?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h|d|w))+)/i.exec(err.message);
  const hinted = hint ? parseDurationNs(hint[1]) : CHUNK_NS;
  return hinted > 0n && hinted < CHUNK_NS ? hinted : CHUNK_NS;
}

function mergeStreams(target, incoming) {
  for (const s of incoming) {
    const key = JSON.stringify(Object.entries(s.stream).sort(([a], [b]) => a.localeCompare(b)));
    let bucket = target.get(key);
    if (!bucket) target.set(key, (bucket = { stream: s.stream, values: [], seen: new Set() }));
    for (const entry of s.values) {
      const id = `${entry[0]}\0${entry[1]}`;
      if (!bucket.seen.has(id)) {
        bucket.seen.add(id);
        bucket.values.push(entry);
      }
    }
  }
}

function mergeMatrix(target, incoming) {
  for (const s of incoming) {
    const key = JSON.stringify(Object.entries(s.metric).sort(([a], [b]) => a.localeCompare(b)));
    let bucket = target.get(key);
    if (!bucket) target.set(key, (bucket = { metric: s.metric, values: [], seen: new Set() }));
    for (const pt of s.values ?? []) {
      if (!bucket.seen.has(pt[0])) {
        bucket.seen.add(pt[0]);
        bucket.values.push(pt);
      }
    }
  }
}

// Runs query_range; if Loki rejects a multi-day span (max_query_length), transparently walks sub-windows.
export async function lokiRange(ds, { query, start, end, limit, direction, step }) {
  try {
    return await loki(ds, 'query_range', { query, start, end, limit, direction, ...(step && { step }) });
  } catch (err) {
    if (end - start <= 3600_000_000_000n || !RANGE_TOO_LONG_RE.test(err.message)) throw err;
    const win = chunkSizeNs(err);
    const forward = direction === 'forward';
    const buckets = new Map();
    let resultType = 'streams';
    let collected = 0;
    let cursor = forward ? start : end;

    while (forward ? cursor < end : cursor > start) {
      const wStart = forward ? cursor : (cursor - win > start ? cursor - win : start);
      const wEnd = forward ? (cursor + win < end ? cursor + win : end) : cursor;
      const rem = resultType === 'streams' ? limit - collected : limit;
      const { data } = await loki(ds, 'query_range', { query, start: wStart, end: wEnd, limit: rem, direction, ...(step && { step }) });
      resultType = data.resultType;
      if (resultType === 'streams') {
        mergeStreams(buckets, data.result);
        collected = Array.from(buckets.values()).reduce((sum, b) => sum + b.values.length, 0);
        if (collected >= limit) break;
      } else if (resultType === 'matrix') {
        mergeMatrix(buckets, data.result);
      } else {
        return { data };
      }
      cursor = forward ? wEnd : wStart;
    }
    const result = Array.from(buckets.values(), ({ seen, ...rest }) => {
      if (resultType === 'matrix') rest.values.sort((a, b) => a[0] - b[0]);
      return rest;
    });
    return { data: { resultType, result } };
  }
}

// Runs labels / label-values; if Loki rejects a multi-day span, unions values across sub-windows.
export async function lokiLabels(ds, endpoint, { start, end, query }) {
  try {
    return await loki(ds, endpoint, { start, end, ...(query && { query }) });
  } catch (err) {
    if (end - start <= 3600_000_000_000n || !RANGE_TOO_LONG_RE.test(err.message)) throw err;
    const win = chunkSizeNs(err);
    const seen = new Set();
    for (let cursor = start; cursor < end;) {
      const wEnd = cursor + win < end ? cursor + win : end;
      const { data = [] } = await loki(ds, endpoint, { start: cursor, end: wEnd, ...(query && { query }) });
      for (const v of data) seen.add(v);
      cursor = wEnd;
    }
    return { data: Array.from(seen).sort() };
  }
}

// ---- Time: now, now-<n><unit>, short dates (YYYY-MM-DD or DD/MM/YYYY), ISO dates and epoch s/ms/ns, as Loki nanoseconds.

const UNIT_S = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };

function localDateMs(y, m, d, endOfDay, h = 0, min = 0, s = 0, hasTime = false) {
  const dt = endOfDay && !hasTime
    ? new Date(y, m - 1, d, 23, 59, 59, 999)
    : new Date(y, m - 1, d, h, min, s, 0);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? dt.getTime() : NaN;
}

const BAD_TIME = (value) => new Error(`bad time "${value}": use now, now-15m (units s m h d w), a date such as 2026-02-11 or 11/02/2026, an ISO timestamp such as 2026-01-31T10:00:00Z (without zone = local time), or epoch seconds, milliseconds or nanoseconds.`);

export function toNs(value, { endOfDay = false, now = Date.now() } = {}) {
  const v = String(value).trim();
  const rel = /^now(?:-(\d+)([smhdw]))?$/.exec(v);
  if (rel) return BigInt(now - (rel[1] ? Number(rel[1]) * UNIT_S[rel[2]] * 1000 : 0)) * 1_000_000n;
  if (/^\d+$/.test(v)) {
    if (v.length > 16) return BigInt(v);
    return BigInt(v) * (v.length > 11 ? 1_000_000n : 1_000_000_000n);
  }
  const isoDay = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v);
  if (isoDay) {
    const ms = localDateMs(Number(isoDay[1]), Number(isoDay[2]), Number(isoDay[3]), endOfDay);
    if (Number.isNaN(ms)) throw BAD_TIME(value);
    return BigInt(ms) * 1_000_000n;
  }
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(v);
  if (dmy) {
    const ms = localDateMs(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]), endOfDay, Number(dmy[4] ?? 0), Number(dmy[5] ?? 0), Number(dmy[6] ?? 0), Boolean(dmy[4]));
    if (Number.isNaN(ms)) throw BAD_TIME(value);
    return BigInt(ms) * 1_000_000n;
  }
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) throw BAD_TIME(value);
  return BigInt(ms) * 1_000_000n;
}

// Grafana Explore link; relative times stay relative.
export function exploreUrl(ds, expr, from, to) {
  const range = (v, endOfDay) => (/^now/.test(String(v).trim()) ? String(v).trim() : String(toNs(v, { endOfDay }) / 1_000_000n));
  const panes = {
    a: {
      datasource: ds.uid,
      queries: [{ refId: 'A', expr, queryType: 'range', datasource: { type: 'loki', uid: ds.uid }, editorMode: 'code' }],
      range: { from: range(from, false), to: range(to, true) },
    },
  };
  return `${BASE}/explore?schemaVersion=1&panes=${encodeURIComponent(JSON.stringify(panes))}`;
}
