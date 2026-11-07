// Liahona manager: a small local server with no dependencies.
// Run with `npm start`, then open http://localhost:3000 (or the laptop's
// address on the camp Wi-Fi from a phone or iPad).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Store, HttpError } from './lib/store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const REPO_DATA = path.join(here, 'data', 'liahona.json');
const DATA_FILE = process.env.LIAHONA_DATA || REPO_DATA;
const PUBLIC = path.join(here, 'public');
const OPEN_BROWSER = process.argv.includes('--open');

// First run with a new data location: bring over anything entered in the repo copy.
if (DATA_FILE !== REPO_DATA && !fs.existsSync(DATA_FILE) && fs.existsSync(REPO_DATA)) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.copyFileSync(REPO_DATA, DATA_FILE);
  console.log(`Copied existing data from ${REPO_DATA}`);
}

// One backup per day in a "backups" folder next to the data file; keep the last 30.
function dailyBackup() {
  if (!fs.existsSync(DATA_FILE)) return;
  const dir = path.join(path.dirname(DATA_FILE), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local time
  const target = path.join(dir, `liahona-${today}.json`);
  if (!fs.existsSync(target)) fs.copyFileSync(DATA_FILE, target);
  const old = fs.readdirSync(dir).filter(f => /^liahona-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(0, -30);
  for (const f of old) fs.unlinkSync(path.join(dir, f));
}
dailyBackup();
setInterval(dailyBackup, 60 * 60 * 1000).unref();

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true });
  child.on('error', () => console.log(`Open ${url} in a browser.`));
  child.unref();
}

const store = new Store(DATA_FILE);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.csv': 'text/csv; charset=utf-8', '.json': 'application/json' };

function send(res, status, body, type = 'application/json; charset=utf-8', headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 5 * 1024 * 1024) throw new HttpError(413, 'Upload too large (5 MB max)');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Body is not valid JSON'); }
}

// Routes: [method, pattern, handler(params, body, query)]
const routes = [
  ['GET', '/api/state', () => ({ ...store.state(), dataFile: DATA_FILE })],

  ['POST', '/api/people', (_, b) => store.addPerson(b)],
  ['PATCH', '/api/people/:id', (p, b) => store.updatePerson(p.id, b)],
  ['DELETE', '/api/people/:id', (p) => { store.deletePerson(p.id); return { ok: true }; }],
  ['POST', '/api/people/import', (_, b) => store.importCsv(b.csv, { teamsFromCsv: b.teamsFromCsv !== false })],

  ['POST', '/api/teams', (_, b) => store.createTeam(b)],
  ['POST', '/api/teams/generate', (_, b) => ({ created: store.generateTeams(b.count).length })],
  ['PATCH', '/api/teams/:id', (p, b) => store.updateTeam(p.id, b)],
  ['DELETE', '/api/teams/:id', (p) => { store.deleteTeam(p.id); return { ok: true }; }],
  ['POST', '/api/assign', (_, b) => ({ moved: store.assign(b.personIds, b.teamId) })],
  ['POST', '/api/autofill', () => ({ moved: store.autofill() })],

  ['POST', '/api/cards/lookup', (_, b) => store.lookupCard(b.raw)],
  ['POST', '/api/cards/bind', (_, b) => store.bindCard(b.personId, b.raw, { force: !!b.force })],
  ['POST', '/api/cards/:uid/release', (p, b) => store.releaseCard(p.uid, b.status)],
  ['PATCH', '/api/settings', (_, b) => store.updateSettings(b)],

  ['GET', '/api/export/roster.json', () => ({ __download: 'liahona-roster.json', type: 'application/json', body: JSON.stringify(store.ballRoster(), null, 2) })],
  ['GET', '/api/export/people.csv', () => ({ __download: 'liahona-people.csv', type: 'text/csv; charset=utf-8', body: store.peopleCsv() })],
  ['GET', '/api/export/backup.json', () => ({ __download: `liahona-backup-${new Date().toISOString().slice(0, 10)}.json`, type: 'application/json', body: JSON.stringify(store.db, null, 2) })]
];

function match(method, pathname) {
  for (const [m, pattern, handler] of routes) {
    if (m !== method) continue;
    const a = pattern.split('/'), b = pathname.split('/');
    if (a.length !== b.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < a.length; i++) {
      if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i]);
      else if (a[i] !== b[i]) { ok = false; break; }
    }
    if (ok) return { handler, params };
  }
  return null;
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'Not found' });
    send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);
    const found = match(req.method, url.pathname);
    if (!found) throw new HttpError(404, 'No such API route');
    const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readJson(req) : {};
    const result = await found.handler(found.params, body, url.searchParams);
    if (result?.__download) {
      return send(res, 200, result.body, result.type, { 'Content-Disposition': `attachment; filename="${result.__download}"` });
    }
    send(res, 200, result ?? { ok: true });
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    send(res, status, { error: e.message || 'Server error', ...(e.extra || {}) });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    // Already running (e.g. the icon was clicked twice): just show it.
    console.log(`Liahona manager is already running on port ${PORT}.`);
    if (OPEN_BROWSER) openBrowser(`http://localhost:${PORT}`);
    setTimeout(() => process.exit(0), 500);
  } else throw e;
});

server.listen(PORT, () => {
  console.log(`Liahona manager running at http://localhost:${PORT}`);
  if (OPEN_BROWSER) openBrowser(`http://localhost:${PORT}`);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) console.log(`  on this network: http://${a.address}:${PORT}`);
  }
  console.log(`  data file: ${DATA_FILE}`);
  console.log('Keep this window open while you use the app. Close it to stop.');
});
