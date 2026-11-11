// Cloud handler end to end, with a fake S3 document store, real RS256 tokens
// shaped like Cognito's, and the laptop's CampLink talking to it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCloudHandler } from '../lib/cloud/handler.js';
import { CampLink } from '../lib/camp.js';
import { LocalVfs, LocalMedia } from '../lib/vfs.js';
import { openData } from '../lib/app.js';

const REGION = 'us-west-2', POOL = 'us-west-2_TEST', CLIENT = 'client123';
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };

function token({ email, groups = [], exp = 3600, aud = CLIENT }) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = enc({ alg: 'RS256', kid: 'k1' });
  const body = enc({ iss: `https://cognito-idp.${REGION}.amazonaws.com/${POOL}`, aud, token_use: 'id', email, name: email.split('@')[0],
    'cognito:groups': groups, exp: now + exp, iat: now });
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}

function fakeCloud({ conflictsFirst = 0 } = {}) {
  const s3 = { doc: null, etag: null, n: 0, conflicts: conflictsFirst, saves: 0 };
  const storage = {
    async load() { return { doc: s3.doc ? JSON.parse(JSON.stringify(s3.doc)) : null, etag: s3.etag }; },
    async save(doc, etag) {
      if (s3.conflicts > 0) { s3.conflicts--; s3.etag = `e${++s3.n}`; const c = new Error('conflict'); c.conflict = true; throw c; }
      if (etag !== s3.etag) { const c = new Error('conflict'); c.conflict = true; throw c; }
      s3.doc = JSON.parse(JSON.stringify(doc)); s3.etag = `e${++s3.n}`; s3.saves++;
    }
  };
  const media = {
    presignGet: async (f, n) => `https://media.test/get/${f}/${n}`,
    presignPut: async (f, n) => `https://media.test/put/${f}/${n}`,
    remove: async () => {}
  };
  const users = { list: async () => [], invite: async () => ({}), update: async () => ({}), remove: async () => ({}) };
  const handle = makeCloudHandler({ storage, media, users, auth: { region: REGION, userPoolId: POOL, clientId: CLIENT, domain: 'x', jwks: [jwk] } });
  const call = async (method, p, { as, body, headers = {} } = {}) => {
    const h = { ...headers };
    if (as) h.authorization = `Bearer ${as}`;
    const out = await handle({ method, path: p, query: new URLSearchParams(), headers: h, body: body || {}, ip: '1.2.3.4' });
    return { status: out.status, data: JSON.parse(out.body || '{}') };
  };
  return { s3, handle, call };
}

const admin = token({ email: 'thayn@example.org', groups: ['admin'] });
const planner = token({ email: 'pat@example.org', groups: ['planner'] });
const registrar = token({ email: 'reg@example.org', groups: ['registrar'] });
const leader = token({ email: 'lee@example.org', groups: ['leader'] });

const signup = (over = {}) => ({
  _started: Date.now() - 60000, firstName: 'Sam', lastName: 'Ray', birthdate: '2011-05-04', gender: 'Male', ward: 'Maple',
  parentName: 'Jo Ray', parentEmail: 'jo@example.org', parentPhone: '555-0100', emergencyName: 'Al Ray', emergencyPhone: '555-0101',
  allergies: 'Peanuts', permission: true, photos: 'Yes', signature: 'Jo Ray', ...over
});

test('cloud: sign-in required, config is public, bad tokens refused', async () => {
  const { call } = fakeCloud();
  assert.equal((await call('GET', '/api/state')).status, 401);
  const cfg = await call('GET', '/api/config');
  assert.equal(cfg.status, 200);
  assert.equal(cfg.data.mode, 'cloud');
  assert.equal(cfg.data.auth.clientId, CLIENT);
  assert.equal((await call('GET', '/api/state', { as: token({ email: 'a@b.c', groups: ['admin'], exp: -120 }) })).status, 401, 'expired');
  assert.equal((await call('GET', '/api/state', { as: token({ email: 'a@b.c', groups: ['admin'], aud: 'other' }) })).status, 401, 'wrong app');
  assert.equal((await call('GET', '/api/state', { as: admin.slice(0, -4) + 'AAAA' })).status, 401, 'tampered');
  assert.equal((await call('GET', '/api/state', { as: admin })).status, 200);
});

test('cloud: roles limit what people can do and see', async () => {
  const { call } = fakeCloud();
  const ann = await call('POST', '/api/people', { as: admin, body: { name: 'Lee Leader', role: 'leader', email: 'LEE@example.org' } });
  assert.equal(ann.status, 200);
  const kid = await call('POST', '/api/people', { as: registrar, body: { name: 'Kid One', private: { allergies: 'Bees' } } });
  const other = await call('POST', '/api/people', { as: registrar, body: { name: 'Kid Two', private: { allergies: 'Dust' } } });
  assert.equal((await call('POST', '/api/people', { as: planner, body: { name: 'Nope' } })).status, 403, 'planner cannot add people');
  const team = await call('POST', '/api/teams', { as: planner, body: { name: 'Red' } });
  assert.equal(team.status, 200);
  assert.equal((await call('POST', '/api/assign', { as: planner, body: { personIds: [ann.data.id, kid.data.id], teamId: team.data.id } })).status, 200);
  assert.equal((await call('POST', '/api/teams', { as: leader, body: {} })).status, 403, 'leader is read-only');

  const pst = (await call('GET', '/api/state', { as: planner })).data;
  assert.deepEqual(pst.people.find(p => p.name === 'Kid One').private, {}, 'planner sees no private details');
  const lst = (await call('GET', '/api/state', { as: leader })).data;
  assert.equal(lst.me.teamId, team.data.id);
  assert.equal(lst.people.find(p => p.name === 'Kid One').private.allergies, 'Bees', 'leader sees own team');
  assert.deepEqual(lst.people.find(p => p.name === 'Kid Two').private, {}, 'but not other teams');
  assert.equal((await call('GET', '/api/export/backup.json', { as: registrar })).status, 403);
  assert.ok(other.status === 200);
});

test('cloud: sign-up form, approve into the roster', async () => {
  const { call } = fakeCloud();
  assert.equal((await call('POST', '/api/public/register', { body: signup() })).status, 403, 'closed by default');
  await call('PATCH', '/api/event', { as: admin, body: { name: 'Covenant Path', registrationOpen: true, startDate: '2027-07-12' } });
  const pub = await call('GET', '/api/public/event');
  assert.equal(pub.data.event.name, 'Covenant Path');
  assert.ok(pub.data.form.some(f => f.key === 'signature'));
  const bad = await call('POST', '/api/public/register', { body: signup({ permission: false }) });
  assert.equal(bad.status, 400);
  assert.equal((await call('POST', '/api/public/register', { body: signup({ website: 'spam' }) })).status, 400, 'honeypot');
  const ok = await call('POST', '/api/public/register', { body: signup() });
  assert.equal(ok.status, 200);
  const dup = await call('POST', '/api/public/register', { body: signup() });
  assert.equal(dup.data.duplicate, true);
  assert.equal((await call('GET', '/api/state', { as: planner })).data.registrations.length, 0, 'planner cannot see sign-ups');
  const regs = (await call('GET', '/api/state', { as: registrar })).data.registrations;
  assert.equal(regs.length, 2);
  const ap = await call('POST', `/api/registrations/${ok.data.id}/approve`, { as: registrar });
  assert.equal(ap.status, 200);
  assert.equal(ap.data.person.name, 'Sam Ray');
  assert.equal(ap.data.person.age, 16, 'age on the camp start date');
  assert.equal(ap.data.person.private.allergies, 'Peanuts');
  assert.equal(ap.data.person.private.signedBy, 'Jo Ray');
  assert.equal(ap.data.person.profile.gender, 'Male');
});

test('cloud: a save that clashes with another one is retried', async () => {
  const { call, s3 } = fakeCloud({ conflictsFirst: 2 });
  const r = await call('POST', '/api/teams', { as: admin, body: { name: 'Blue' } });
  assert.equal(r.status, 200);
  assert.equal(s3.saves, 1);
  assert.equal(s3.doc.files['liahona.json'] && JSON.parse(s3.doc.files['liahona.json'].text).teams.length, 1);
});

test('camp: download to the laptop, cloud read-only, edit at camp, upload back', async () => {
  const cloud = fakeCloud();
  const { call } = cloud;
  await call('POST', '/api/teams', { as: admin, body: { name: 'Gold' } });
  await call('POST', '/api/journeys', { as: planner, body: { title: 'Leader Test' } });
  await call('POST', '/api/media/leader-test/uploaded', { as: planner, body: { name: 'intro.mp4' } });
  await call('PATCH', '/api/event', { as: admin, body: { registrationOpen: true } });
  const key = (await call('POST', '/api/camp/keys', { as: admin, body: { label: 'HP laptop' } })).data.key;
  assert.match(key, /^lhk_/);

  // The laptop talks to the cloud through this fake fetch.
  const fakeFetch = async (url, init = {}) => {
    if (url.startsWith('https://media.test/get/')) return new Response('VIDEO');
    if (url.startsWith('https://media.test/put/')) return new Response('', { status: 200 });
    const u = new URL(url);
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const out = await cloud.handle({ method: init.method || 'GET', path: u.pathname, query: u.searchParams, headers, body: init.body ? JSON.parse(init.body) : {}, ip: '9.9.9.9' });
    return new Response(out.body, { status: out.status, headers: out.headers });
  };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liahona-camp-'));
  const vfs = new LocalVfs(dir);
  vfs.write('journeys/old-local.yaml', 'id: old-local\ntitle: Old\nstages: []\n');
  const link = new CampLink(vfs);
  assert.throws(() => link.set({ key: 'nope' }), /sync key/);
  link.set({ cloudUrl: 'https://cloud.test/', key });
  const down = await link.download({ vfs, mediaRoot: path.join(dir, 'media'), laptop: 'test' }, fakeFetch);
  assert.equal(down.mediaFetched, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'media', 'leader-test', 'intro.mp4'), 'utf8'), 'VIDEO');
  assert.ok(vfs.exists('journeys/leader-test.yaml'));
  assert.ok(!vfs.exists('journeys/old-local.yaml'), 'laptop copy replaced');
  assert.ok(vfs.exists(`${down.backup}/journeys/old-local.yaml`), 'but backed up');

  // While the laptop has it, the cloud is read-only; sign-ups still come in.
  const blocked = await call('POST', '/api/teams', { as: admin, body: { name: 'Nope' } });
  assert.equal(blocked.status, 423);
  assert.equal((await call('GET', '/api/state', { as: admin })).data.locked.laptop, 'test');
  const late = await call('POST', '/api/public/register', { body: signup({ firstName: 'Late' }) });
  assert.equal(late.status, 200);

  // Edit at camp on the laptop, add new media, upload.
  const { store } = openData({ vfs, media: new LocalMedia(path.join(dir, 'media')) });
  store.createTeam({ name: 'Camp Team' });
  fs.writeFileSync(path.join(dir, 'media', 'leader-test', 'new.mp3'), 'AUDIO');
  const up = await link.upload({ vfs, mediaIndex: new LocalMedia(path.join(dir, 'media')).index(), mediaRoot: path.join(dir, 'media') }, fakeFetch);
  assert.equal(up.mediaUploaded, 1, 'only the new file goes up');
  assert.equal(up.keptSignups, 1);

  const st = (await call('GET', '/api/state', { as: admin })).data;
  assert.equal(st.locked, null, 'unlocked');
  assert.deepEqual(st.teams.map(t => t.name).sort(), ['Camp Team', 'Gold']);
  assert.ok(st.registrations.some(r => r.answers.firstName === 'Late'), 'late sign-up kept');
  assert.deepEqual(cloud.s3.doc.media['leader-test'], ['intro.mp4', 'new.mp3']);
  assert.equal((await call('POST', '/api/teams', { as: admin, body: { name: 'After' } })).status, 200, 'editable again');
  assert.ok(!JSON.stringify(cloud.s3.doc.files).includes('local-auth'), 'laptop secrets never uploaded');

  // A second laptop can't silently take over, and a stale laptop can't overwrite.
  await link.download({ vfs, mediaRoot: path.join(dir, 'media'), laptop: 'test' }, fakeFetch);
  const link2 = new CampLink(new LocalVfs(fs.mkdtempSync(path.join(os.tmpdir(), 'liahona-camp2-'))));
  link2.set({ cloudUrl: 'https://cloud.test', key });
  await assert.rejects(link2.download({ vfs: link2.vfs, mediaRoot: path.join(dir, 'm2') }, fakeFetch), /Already checked out/);
  await call('POST', '/api/camp/unlock', { as: admin });
  assert.equal((await call('GET', '/api/state', { as: admin })).data.locked, null);
  await assert.rejects(link.upload({ vfs, mediaIndex: {}, mediaRoot: path.join(dir, 'media') }, fakeFetch), /isn't checked out/);
  assert.equal((await call('POST', '/api/camp/checkout', { headers: { 'x-liahona-sync-key': 'lhk_wrongwrongwrongwrongwrong' } })).status, 401);
});

test('first-time setup: copy an existing laptop into an empty cloud', async () => {
  const cloud = fakeCloud();
  const key = (await cloud.call('POST', '/api/camp/keys', { as: admin, body: {} })).data.key;
  const fakeFetch = async (url, init = {}) => {
    if (url.startsWith('https://media.test/')) return new Response('', { status: 200 });
    const u = new URL(url);
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const out = await cloud.handle({ method: init.method || 'GET', path: u.pathname, query: u.searchParams, headers, body: init.body ? JSON.parse(init.body) : {}, ip: '9.9.9.9' });
    return new Response(out.body, { status: out.status, headers: out.headers });
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liahona-seed-'));
  const vfs = new LocalVfs(dir);
  const { store, journeys } = openData({ vfs, media: new LocalMedia(path.join(dir, 'media')) });
  store.importCsv(fs.readFileSync(new URL('../public/sample-roster.csv', import.meta.url), 'utf8'));
  journeys.create('Leader Test');
  fs.mkdirSync(path.join(dir, 'media', 'leader-test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'media', 'leader-test', 'a.mp3'), 'A');
  const link = new CampLink(vfs);
  link.set({ cloudUrl: 'https://cloud.test', key });
  await assert.rejects(link.upload({ vfs, mediaIndex: {}, mediaRoot: dir }, fakeFetch), /hasn't downloaded/);
  const r = await link.upload({ vfs, mediaIndex: new LocalMedia(path.join(dir, 'media')).index(), mediaRoot: path.join(dir, 'media'), force: true }, fakeFetch);
  assert.equal(r.mediaUploaded, 1);
  const st = (await cloud.call('GET', '/api/state', { as: admin })).data;
  assert.equal(st.people.length, 120);
  assert.equal((await cloud.call('GET', '/api/journeys', { as: planner })).data.length, 1);
});
