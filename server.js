// Liahona manager: a small local server with no dependencies.
// Run with `npm start`, then open http://localhost:3000 (or the laptop's
// address on the camp Wi-Fi from a phone or iPad).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { HttpError } from './lib/store.js';
import { LocalVfs, LocalMedia } from './lib/vfs.js';
import { routes, runRoute, openData } from './lib/app.js';
import { LocalAuth, makeUser, ANONYMOUS, parseCookies, isLoopback } from './lib/auth.js';
import { CampLink } from './lib/camp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const REPO_DATA = path.join(here, 'data', 'liahona.json');
const DATA_FILE = process.env.LIAHONA_DATA || REPO_DATA;
const PUBLIC = path.join(here, 'public');
const DATA_DIR = path.dirname(DATA_FILE);
const MEDIA_DIR = path.join(DATA_DIR, 'media');
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

const DATA_NAME = path.basename(DATA_FILE);
let data = openData({ vfs: new LocalVfs(DATA_DIR), media: new LocalMedia(MEDIA_DIR), name: DATA_NAME });
const localVfs = new LocalVfs(DATA_DIR);
const localAuth = new LocalAuth(localVfs);
const campLink = new CampLink(localVfs);
const reopen = () => { data = openData({ vfs: new LocalVfs(DATA_DIR), media: new LocalMedia(MEDIA_DIR), name: DATA_NAME }); };

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.csv': 'text/csv; charset=utf-8', '.json': 'application/json', '.mjs': 'text/javascript; charset=utf-8' };

function send(res, status, body, type = 'application/json; charset=utf-8', headers = {}) {
  const out = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
  res.end(out);
}

async function readJson(req, limitMb = 5) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitMb * 1024 * 1024) throw new HttpError(413, `Upload too large (${limitMb} MB max)`);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Body is not valid JSON'); }
}

// Sign-in on the laptop: the person at the laptop is Admin; other devices on
// the camp Wi-Fi sign in with their email and the code for their role.
const SESSION = 'liahona_session';
function whoIs(req) {
  if (isLoopback(req.socket.remoteAddress)) return makeUser({ email: 'laptop', name: 'This laptop', roles: ['admin'], via: 'laptop' });
  const s = localAuth.read(parseCookies(req.headers.cookie)[SESSION]);
  return s ? makeUser({ email: s.email, name: s.name || s.email, roles: [s.role], via: 'code' }) : ANONYMOUS;
}

const attempts = new Map();   // ip -> {n, at}, slows down code guessing
function throttle(ip) {
  const a = attempts.get(ip) || { n: 0, at: Date.now() };
  if (Date.now() - a.at > 15 * 60 * 1000) { a.n = 0; a.at = Date.now(); }
  a.n++;
  attempts.set(ip, a);
  if (a.n > 10) throw new HttpError(429, 'Too many tries. Wait 15 minutes and try again.');
}

const sessionCookie = (value, maxAge) => `${SESSION}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;

const localRoutes = [
  ['POST', '/api/local/signin', 'public', (c, _, b) => {
    throttle(c.req.ip);
    const role = localAuth.roleForCode(b.code || '');
    if (!role) throw new HttpError(401, 'That code isn\'t right');
    const email = String(b.email || '').trim().toLowerCase().slice(0, 120);
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter your email');
    const value = localAuth.issue({ email, name: String(b.name || '').slice(0, 80), role });
    return { __response: { status: 200, headers: { 'Content-Type': 'application/json', 'Set-Cookie': sessionCookie(value, 7 * 86400) }, body: JSON.stringify({ ok: true, role }) } };
  }, { lockOk: true }],
  ['POST', '/api/local/signout', 'public', () => ({ __response: { status: 200, headers: { 'Content-Type': 'application/json', 'Set-Cookie': sessionCookie('', 0) }, body: '{"ok":true}' } }), { lockOk: true }],
  ['GET', '/api/local/codes', 'admin', () => localAuth.status()],
  ['PUT', '/api/local/codes', 'admin', (_, __, b) => { localAuth.setCode(b.role, b.code); return localAuth.status(); }],

  ['GET', '/api/camp/link', 'admin', () => campLink.status()],
  ['PUT', '/api/camp/link', 'admin', (_, __, b) => campLink.set(b)],
  ['POST', '/api/camp/download', 'admin', async (_, __, b) => {
    const r = await campLink.download({ vfs: localVfs, mediaRoot: MEDIA_DIR, force: !!b.force, laptop: os.hostname() });
    reopen();
    return r;
  }],
  ['POST', '/api/camp/upload', 'admin', async (_, __, b) => campLink.upload({
    vfs: localVfs, mediaIndex: new LocalMedia(MEDIA_DIR).index(), mediaRoot: MEDIA_DIR, force: !!b.force
  })]
];
const table = [...localRoutes, ...routes];

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname === '/register' ? 'register.html' : pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, body) => {
    if (err) return send(res, 404, { error: 'Not found' });
    send(res, 200, body, MIME[path.extname(file)] || 'application/octet-stream');
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);
  let body = {};
  try {
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) body = await readJson(req);
  } catch (e) {
    return send(res, e.status || 400, { error: e.message });
  }
  const c = { ...data, user: whoIs(req), mode: 'local', req: { ip: req.socket.remoteAddress } };
  const out = await runRoute(table, c, { method: req.method, path: url.pathname, query: url.searchParams, body, ip: req.socket.remoteAddress });
  res.writeHead(out.status, { 'Cache-Control': 'no-store', ...out.headers });
  res.end(out.body);
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
  console.log(`  sign-up form: http://localhost:${PORT}/register`);
  console.log('Keep this window open while you use the app. Close it to stop.');
});
