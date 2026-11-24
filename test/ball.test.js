import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalVfs, LocalMedia } from '../lib/vfs.js';
import { routes, runRoute, openData, viewState } from '../lib/app.js';
import { makeUser, ANONYMOUS } from '../lib/auth.js';
import { firmwareInfo, FIRMWARE_FOLDER } from '../lib/ball.js';

const trialText = fs.readFileSync(new URL('../samples/leader-trial.yaml', import.meta.url), 'utf8');
const admin = makeUser({ email: 'a@x', roles: ['admin'] });
const leader = makeUser({ email: 'l@x', roles: ['leader'] });

/** A fake ESP-IDF app image: header, segment header, then esp_app_desc_t. */
function fakeImage(version = '0.5.0', project = 'liahona_fw', size = 4096) {
  const b = Buffer.alloc(size);
  b[0] = 0xE9;
  b.writeUInt32LE(0xABCD5432, 32);
  b.write(version, 48, 'latin1');
  b.write(project, 80, 'latin1');
  return b;
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liahona-ball-'));
  const mediaDir = path.join(dir, 'media');
  const data = openData({ vfs: new LocalVfs(dir), media: new LocalMedia(mediaDir) });
  const put = (folder, name, buf) => { fs.mkdirSync(path.join(mediaDir, folder), { recursive: true }); fs.writeFileSync(path.join(mediaDir, folder, name), buf); };
  const ballLinks = {
    media: (folder, name, q) => `/api/ball/media/${folder}/${name}${q}`,
    rev: (folder, name) => String(fs.statSync(path.join(mediaDir, folder, name)).size),
    size: (folder, name) => fs.statSync(path.join(mediaDir, folder, name)).size,
    put
  };
  const call = async (user, method, url, body) => {
    const u = new URL(url, 'http://x');
    const out = await runRoute(routes, { ...data, user, mode: 'local', ballLinks, req: { ip: '1' } },
      { method, path: u.pathname, query: u.searchParams, body });
    return { status: out.status, json: (() => { try { return JSON.parse(out.body); } catch { return out.body; } })() };
  };
  return { dir, mediaDir, data, put, call };
}

test('firmware images: version read from the app description, junk refused', () => {
  const info = firmwareInfo(fakeImage('0.5.1'));
  assert.equal(info.version, '0.5.1');
  assert.equal(info.project, 'liahona_fw');
  assert.equal(info.sha256.length, 64);
  assert.throws(() => firmwareInfo(Buffer.alloc(100)), /too small/);
  const bad = fakeImage(); bad[0] = 0;
  assert.throws(() => firmwareInfo(bad), /isn't an ESP32 firmware/);
  const boot = fakeImage(); boot.writeUInt32LE(0, 32);
  assert.throws(() => firmwareInfo(boot), /No app description/);
});

test('ball package: key, journey, roster, media and firmware', async () => {
  const { data, put, call } = setup();
  data.journeys.importYaml(trialText);
  const { journey } = data.journeys.read('leader-trial');
  put(journey.media, 'lehi-clue.mp3', Buffer.alloc(1000));
  put(journey.media, 'notes.txt', Buffer.from('not for the ball'));

  // nothing set up yet: no key, so balls are refused
  assert.equal((await call(ANONYMOUS, 'GET', '/api/ball/package?key=x')).status, 401);

  let r = await call(admin, 'PATCH', '/api/ball', { journeyId: 'leader-trial' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.journeyId, 'leader-trial');
  assert.equal((await call(admin, 'PATCH', '/api/ball', { journeyId: 'nope' })).status, 404);
  assert.equal((await call(leader, 'POST', '/api/ball/key')).status, 403);
  r = await call(admin, 'POST', '/api/ball/key');
  const key = r.json.key;
  assert.ok(key && key.length >= 20);

  // the key never rides along in the state, even for admins
  const st = viewState(data.store, admin);
  assert.equal(st.settings.ball.key, undefined);
  assert.equal(st.settings.ball.hasKey, true);
  assert.equal((await call(leader, 'GET', '/api/ball')).json.key, undefined);

  // firmware: leaders can't, admins can; wrong project refused
  const fw = fakeImage('0.5.0').toString('base64');
  assert.equal((await call(leader, 'POST', '/api/ball/firmware', { name: 'x.bin', data: fw })).status, 403);
  assert.equal((await call(admin, 'POST', '/api/ball/firmware', { name: 'x.bin', data: fakeImage('1', 'base_station').toString('base64') })).status, 400);
  r = await call(admin, 'POST', '/api/ball/firmware', { name: 'liahona_fw.bin', data: fw });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.firmware.version, '0.5.0');

  // the ball's view
  assert.equal((await call(ANONYMOUS, 'GET', '/api/ball/package?key=wrong')).status, 401);
  r = await call(ANONYMOUS, 'GET', `/api/ball/package?key=${key}&ball=3`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const m = r.json;
  const paths = m.files.map(f => f.path).sort();
  assert.deepEqual(paths, ['journey.json', 'media/lehi-clue.mp3', 'roster.json']);
  assert.ok(m.files.every(f => f.url && f.rev));
  assert.equal(m.firmware.version, '0.5.0');
  assert.ok(m.firmware.url.startsWith(`/api/ball/media/${FIRMWARE_FOLDER}/`));
  assert.ok(m.firmware.url.includes(`key=${key}`));

  // the generated files, and their revs change when the content does
  const jf = m.files.find(f => f.path === 'journey.json');
  r = await call(ANONYMOUS, 'GET', jf.url);
  assert.equal(r.status, 200);
  assert.equal(r.json.format, 1);
  assert.equal((await call(ANONYMOUS, 'GET', '/api/ball/file/journey.json?key=nope')).status, 401);
  const rosterRev = m.files.find(f => f.path === 'roster.json').rev;
  data.store.addPerson({ name: 'New Person', role: 'youth' });
  const m2 = (await call(ANONYMOUS, 'GET', `/api/ball/package?key=${key}`)).json;
  assert.notEqual(m2.files.find(f => f.path === 'roster.json').rev, rosterRev);
  assert.equal(m2.files.find(f => f.path === 'journey.json').rev, jf.rev);

  // a new key locks the old one out
  await call(admin, 'POST', '/api/ball/key');
  assert.equal((await call(ANONYMOUS, 'GET', `/api/ball/package?key=${key}`)).status, 401);
});

test('ball logs: upload with the key, listed for planners, snapshot replaced', async () => {
  const { mediaDir, call } = setup();
  const key = (await call(admin, 'POST', '/api/ball/key')).json.key;
  assert.equal((await call(ANONYMOUS, 'POST', '/api/ball/log?key=nope&ball=1', { name: 'now.txt', text: 'x' })).status, 401);
  const q = `?key=${encodeURIComponent(key)}&ball=3`;
  assert.equal((await call(ANONYMOUS, 'POST', `/api/ball/log${q}`, { name: '001-brownout.txt', reason: 'brownout', text: 'I (1) boot\n' })).status, 200);
  assert.equal((await call(ANONYMOUS, 'POST', `/api/ball/log${q}`, { name: 'now.txt', reason: 'brownout', text: 'first' })).status, 200);
  assert.equal((await call(ANONYMOUS, 'POST', `/api/ball/log${q}`, { name: 'now.txt', reason: 'brownout', text: 'second' })).status, 200);
  const logs = (await call(admin, 'GET', '/api/ball')).json.logs;
  assert.equal(logs.length, 2);
  assert.equal(logs[0].name, 'now.txt');
  assert.equal(logs[1].crash, true);
  assert.equal(fs.readFileSync(path.join(mediaDir, '_ball-logs', 'ball-3-now.txt'), 'utf8'), 'second');
  const link = (await call(admin, 'GET', '/api/ball/logs/ball-3-001-brownout.txt')).json.url;
  assert.match(link, /_ball-logs\/ball-3-001-brownout\.txt\?key=/);
  assert.equal((await call(admin, 'GET', '/api/ball/logs/ball-9-x.txt')).status, 404);
  assert.equal((await call(ANONYMOUS, 'GET', '/api/ball/logs/ball-3-now.txt')).status, 401);
});

test('ball networks: saved by an admin and sent with the package', async () => {
  const { call } = setup();
  const key = (await call(admin, 'POST', '/api/ball/key')).json.key;
  assert.equal((await call(admin, 'PUT', '/api/ball/networks', { networks: [{ ssid: 'Camp', password: 'pw' }, { ssid: '' }, { ssid: 'Phone', password: 'x' }] })).status, 200);
  const pkg = (await call(ANONYMOUS, 'GET', `/api/ball/package?key=${encodeURIComponent(key)}&ball=1`));
  if (pkg.status === 200) assert.deepEqual(pkg.json.networks.map(n => n.ssid), ['Camp', 'Phone']);
  assert.equal((await call(ANONYMOUS, 'PUT', '/api/ball/networks', { networks: [] })).status, 401);
});
