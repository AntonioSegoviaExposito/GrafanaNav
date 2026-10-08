import { DatabaseSync } from 'node:sqlite';
import { copyFile, mkdtemp, readdir, rm, stat } from 'fs/promises';
import { homedir, platform, tmpdir } from 'os';
import { join } from 'path';

export const BROWSERS = 'Firefox, Zen, LibreWolf, Waterfox or Floorp';

// Folders holding the profiles of Firefox and its forks; every subfolder with a cookies.sqlite is a profile.
function profileRoots() {
  const home = homedir();
  if (platform() === 'darwin') {
    const support = join(home, 'Library', 'Application Support');
    return ['Firefox', 'zen', 'librewolf', 'Waterfox', 'Floorp'].map(app => join(support, app, 'Profiles'));
  }
  if (platform() === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    return [join('Mozilla', 'Firefox'), 'zen', 'librewolf', 'Waterfox', 'Floorp'].map(app => join(appData, app, 'Profiles'));
  }
  return [
    '.mozilla/firefox', 'snap/firefox/common/.mozilla/firefox', '.var/app/org.mozilla.firefox/.mozilla/firefox',
    '.zen', '.librewolf', '.waterfox', '.floorp',
  ].map(dir => join(home, dir));
}

async function profiles() {
  const found = [];
  for (const root of profileRoots()) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const dir = join(root, e.name);
      if (e.isDirectory() && await stat(join(dir, 'cookies.sqlite')).then(() => true, () => false)) found.push(dir);
    }
  }
  return found;
}

// The browser keeps the database locked and recent writes in the -wal file: read a copy of both.
async function readCookies(profile, hosts) {
  const tmp = await mkdtemp(join(tmpdir(), 'grafana-nav-cookies-'));
  try {
    await copyFile(join(profile, 'cookies.sqlite'), join(tmp, 'cookies.sqlite'));
    await copyFile(join(profile, 'cookies.sqlite-wal'), join(tmp, 'cookies.sqlite-wal')).catch(() => {});
    const db = new DatabaseSync(join(tmp, 'cookies.sqlite'));
    try {
      return db.prepare(`SELECT name, value, path, expiry, lastAccessed FROM moz_cookies WHERE host IN (${hosts.map(() => '?').join(', ')})`).all(...hosts);
    } finally {
      db.close();
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// Cookie header for `baseUrl` from the profile that used it most recently. Only cookies set for the Grafana host
// itself: cookies of parent domains belong to other sites and are left out. Containers count as the same profile;
// for each cookie name the most recently used value wins.
export async function firefoxCookie(baseUrl) {
  const { hostname, pathname } = new URL(baseUrl);
  const path = pathname.endsWith('/') ? pathname : `${pathname}/`;
  const hosts = [hostname, `.${hostname}`];
  const now = Date.now();

  const found = await profiles();
  if (!found.length) throw new Error(`no ${BROWSERS} profile found. Searched: ${profileRoots().join(', ')}`);

  let best;
  for (const profile of found) {
    const rows = (await readCookies(profile, hosts).catch(() => []))
      .filter(r => (r.expiry > 1e12 ? r.expiry : r.expiry * 1000) > now && path.startsWith(r.path));
    const lastUsed = Math.max(...rows.map(r => r.lastAccessed));
    if (rows.length && (!best || lastUsed > best.lastUsed)) best = { profile, rows, lastUsed };
  }
  if (!best) throw new Error(`no browser session for ${hostname}. Open ${baseUrl} in ${BROWSERS}, sign in, and call the tool again.`);

  const byName = new Map();
  for (const r of best.rows.sort((a, b) => a.lastAccessed - b.lastAccessed)) byName.set(r.name, r.value);
  return { cookie: [...byName].map(([name, value]) => `${name}=${value}`).join('; '), profile: best.profile };
}
