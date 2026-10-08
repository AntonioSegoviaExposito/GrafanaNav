import { createHash } from 'crypto';
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

export async function grafana(path, params) {
  if (!BASE) throw new Error('GRAFANA_URL is not set: start the server with GRAFANA_URL set to the Grafana address you open in the browser, e.g. https://grafana.example.com');
  const url = `${BASE}${path}${params ? `?${new URLSearchParams(params)}` : ''}`;
  session ??= await load('session.json', null);
  let fresh = false;
  if (!session) {
    await refreshSession();
    fresh = true;
  }
  for (;;) {
    const res = await fetch(url, { headers: { Cookie: session.cookie, Accept: 'application/json' }, redirect: 'manual' });
    if (res.status === 401 || (res.status >= 300 && res.status < 400)) {
      if (fresh) throw new Error(`Grafana rejected the browser session (HTTP ${res.status}). Open ${BASE} in ${BROWSERS}, sign in, and call the tool again.`);
      await refreshSession();
      fresh = true;
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

// ---- Time: now, now-<n><unit>, ISO dates and epoch seconds/milliseconds/nanoseconds, as Loki nanoseconds.

const UNIT_S = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };

export function toNs(value, now = Date.now()) {
  const v = String(value).trim();
  const rel = /^now(?:-(\d+)([smhdw]))?$/.exec(v);
  if (rel) return BigInt(now - (rel[1] ? Number(rel[1]) * UNIT_S[rel[2]] * 1000 : 0)) * 1_000_000n;
  if (/^\d+$/.test(v)) {
    if (v.length > 16) return BigInt(v);
    return BigInt(v) * (v.length > 11 ? 1_000_000n : 1_000_000_000n);
  }
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) throw new Error(`bad time "${value}": use now, now-15m (units s m h d w), an ISO date such as 2026-01-31T10:00:00Z (without zone = local time), or epoch seconds, milliseconds or nanoseconds.`);
  return BigInt(ms) * 1_000_000n;
}

// Grafana Explore link; relative times stay relative.
export function exploreUrl(ds, expr, from, to) {
  const range = (v) => (/^now/.test(String(v).trim()) ? String(v).trim() : String(toNs(v) / 1_000_000n));
  const panes = {
    a: {
      datasource: ds.uid,
      queries: [{ refId: 'A', expr, queryType: 'range', datasource: { type: 'loki', uid: ds.uid }, editorMode: 'code' }],
      range: { from: range(from), to: range(to) },
    },
  };
  return `${BASE}/explore?schemaVersion=1&panes=${encodeURIComponent(JSON.stringify(panes))}`;
}
