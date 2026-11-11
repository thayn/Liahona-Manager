// The manager's API, shared by the laptop server (server.js) and the cloud
// Lambda (lib/cloud/lambda.js). Each route names the permission it needs
// (see lib/auth.js); the state a person receives is trimmed to their role.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, HttpError, defaultEvent } from './store.js';
import { JourneyStore } from './journeys.js';
import { requirePerm, ROLES, ROLE_LABELS } from './auth.js';
import { DEFAULT_FORM, addRegistration, approveRegistration, rejectRegistration, deleteRegistration } from './registration.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_TRIAL = path.join(process.env.LIAHONA_SAMPLES || path.join(here, '..', 'samples'), 'leader-trial.yaml');

const clean = (v, max = 200) => (v == null ? '' : String(v).trim().slice(0, max));

/** Open the data for one request (cloud) or for the life of the server (laptop). */
export function openData({ vfs, media, name = 'liahona.json' }) {
  const store = new Store(vfs, name);
  const journeys = new JourneyStore({ vfs, media }, store);
  return { store, journeys };
}

/** The team a leader looks after: the leader on the roster with their email. */
export function leaderTeamId(store, user) {
  if (!user?.email) return null;
  return store.db.people.find(p => p.role === 'leader' && p.email && p.email === user.email)?.teamId || null;
}

/** Remove what this person may not see. */
export function viewState(store, user, extra = {}) {
  const st = store.state();
  const canPrivate = user.can('private');
  const myTeam = canPrivate ? null : leaderTeamId(store, user);
  st.people = st.people.map(p => {
    if (canPrivate || (myTeam && p.teamId === myTeam)) return p;
    const { private: _hidden, email: _email, ...rest } = p;
    return { ...rest, private: {}, email: '' };
  });
  st.registrations = user.can('people')
    ? store.db.registrations.map(r => ({ ...r, ipHash: undefined }))
    : [];
  st.pendingRegistrations = store.db.registrations.filter(r => r.status === 'pending').length;
  st.form = store.db.settings.form || DEFAULT_FORM;
  st.me = { email: user.email, name: user.name, roles: user.roles, perms: user.perms, teamId: myTeam };
  st.roles = ROLES.map(r => ({ id: r, label: ROLE_LABELS[r] }));
  return { ...st, ...extra };
}

/**
 * Routes: [method, pattern, permission, handler(c, params, body, query), options]
 * c = { store, journeys, user, mode, cloud?, local?, req }
 * options.lockOk: allowed while the cloud copy is checked out to the camp laptop.
 */
export const routes = [
  // ---------- public ----------
  ['GET', '/api/config', 'public', (c) => ({
    mode: c.mode,
    auth: c.mode === 'cloud' ? c.cloud.authConfig : { kind: 'local' },
    event: publicEvent(c.store)
  }), { lockOk: true }],
  ['GET', '/api/me', 'public', (c) => {
    if (c.user.via === 'anonymous') throw new HttpError(401, 'Please sign in');
    return { email: c.user.email, name: c.user.name, roles: c.user.roles, perms: c.user.perms, via: c.user.via };
  }, { lockOk: true }],
  ['GET', '/api/public/event', 'public', (c) => ({ event: publicEvent(c.store), form: c.store.db.settings.form || DEFAULT_FORM }), { lockOk: true }],
  ['POST', '/api/public/register', 'public', (c, _, b) => addRegistration(c.store, b, { ip: c.req.ip }), { lockOk: true }],

  // ---------- reading ----------
  ['GET', '/api/state', 'read', (c) => viewState(c.store, c.user, {
    mode: c.mode,
    locked: c.lock || null,
    dataFile: c.mode === 'local' ? c.store.file : null,
    journeysDir: c.mode === 'local' ? c.journeys.dir : null,
    mediaDir: c.mode === 'local' ? c.journeys.mediaRoot : null,
    placeUsage: c.journeys.placeUsage()
  }), { lockOk: true }],
  ['GET', '/api/journeys', 'read', (c) => c.journeys.list(), { lockOk: true }],
  ['GET', '/api/journeys/:id', 'read', (c, p) => c.journeys.get(p.id), { lockOk: true }],
  ['GET', '/api/journeys/:id/download.yaml', 'read', (c, p) => ({ __download: `${p.id}.yaml`, type: 'text/yaml; charset=utf-8', body: c.journeys.read(p.id).yaml }), { lockOk: true }],
  ['GET', '/api/journeys/:id/ball.json', 'plan', (c, p) => ({ __download: `${p.id}.ball.json`, type: 'application/json', body: JSON.stringify(c.journeys.compiled(p.id), null, 2) }), { lockOk: true }],
  ['GET', '/api/export/roster.json', 'plan', (c) => ({ __download: 'liahona-roster.json', type: 'application/json', body: JSON.stringify(c.store.ballRoster(), null, 2) }), { lockOk: true }],
  ['GET', '/api/export/people.csv', 'read', (c) => ({ __download: 'liahona-people.csv', type: 'text/csv; charset=utf-8', body: c.store.peopleCsv() }), { lockOk: true }],
  ['GET', '/api/export/backup.json', 'admin', (c) => ({ __download: `liahona-backup-${new Date().toISOString().slice(0, 10)}.json`, type: 'application/json', body: JSON.stringify(c.store.db, null, 2) }), { lockOk: true }],

  // ---------- journeys (planner) ----------
  ['POST', '/api/journeys', 'plan', (c, _, b) => c.journeys.create(b.title)],
  ['POST', '/api/journeys/import', 'plan', (c, _, b) => c.journeys.importYaml(String(b.yaml || ''), { replace: !!b.replace })],
  ['POST', '/api/journeys/sample', 'plan', (c) => {
    if (c.journeys.exists('leader-trial')) throw new HttpError(409, 'The Leader Trial is already loaded');
    return c.journeys.importYaml(fs.readFileSync(SAMPLE_TRIAL, 'utf8'));
  }],
  ['PUT', '/api/journeys/:id', 'plan', (c, p, b) => c.journeys.save(b.journey, { previousId: p.id })],
  ['DELETE', '/api/journeys/:id', 'plan', (c, p) => { c.journeys.remove(p.id); return { ok: true }; }],
  ['POST', '/api/journeys/:id/duplicate', 'plan', (c, p) => c.journeys.duplicate(p.id)],

  // ---------- places (planner) ----------
  ['POST', '/api/places', 'plan', (c, _, b) => c.store.addPlace(b)],
  ['POST', '/api/places/from-journeys', 'plan', (c) => {
    const have = new Set(c.store.db.places.map(p => p.key));
    const made = [];
    const indoor = c.journeys.directionsPlaces();
    for (const key of Object.keys(c.journeys.placeUsage())) {
      if (have.has(key) || !/^[a-z0-9][a-z0-9-]*$/.test(key)) continue;
      const name = key.replace(/-/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase());
      made.push(c.store.addPlace({ key, name, tagOnly: indoor.has(key) }).key);
    }
    return { created: made };
  }],
  ['PATCH', '/api/places/:key', 'plan', (c, p, b) => c.store.updatePlace(p.key, b)],
  ['DELETE', '/api/places/:key', 'plan', (c, p) => { c.store.deletePlace(p.key); return { ok: true }; }],
  ['POST', '/api/places/:key/tags', 'plan', (c, p, b) => c.store.bindPlaceTag(p.key, b.raw, { force: !!b.force })],
  ['DELETE', '/api/places/:key/tags/:uid', 'plan', (c, p) => c.store.removePlaceTag(p.key, p.uid)],

  // ---------- people (registrar) ----------
  ['POST', '/api/people', 'people', (c, _, b) => c.store.addPerson(b)],
  ['PATCH', '/api/people/:id', 'people', (c, p, b) => c.store.updatePerson(p.id, b)],
  ['DELETE', '/api/people/:id', 'people', (c, p) => { c.store.deletePerson(p.id); return { ok: true }; }],
  ['POST', '/api/people/import', 'people', (c, _, b) => c.store.importCsv(b.csv, { teamsFromCsv: b.teamsFromCsv !== false })],

  // ---------- registrations (registrar) ----------
  ['POST', '/api/registrations/:id/approve', 'people', (c, p) => approveRegistration(c.store, p.id, { by: c.user.email })],
  ['POST', '/api/registrations/:id/reject', 'people', (c, p, b) => rejectRegistration(c.store, p.id, { by: c.user.email, reason: b.reason })],
  ['DELETE', '/api/registrations/:id', 'admin', (c, p) => { deleteRegistration(c.store, p.id); return { ok: true }; }],

  // ---------- teams and cards (planner) ----------
  ['POST', '/api/teams', 'plan', (c, _, b) => c.store.createTeam(b)],
  ['POST', '/api/teams/generate', 'plan', (c, _, b) => ({ created: c.store.generateTeams(b.count).length })],
  ['PATCH', '/api/teams/:id', 'plan', (c, p, b) => c.store.updateTeam(p.id, b)],
  ['DELETE', '/api/teams/:id', 'plan', (c, p) => { c.store.deleteTeam(p.id); return { ok: true }; }],
  ['POST', '/api/assign', 'plan', (c, _, b) => ({ moved: c.store.assign(b.personIds, b.teamId) })],
  ['POST', '/api/autofill', 'plan', (c) => ({ moved: c.store.autofill() })],
  ['POST', '/api/cards/lookup', 'read', (c, _, b) => {
    const r = c.store.lookupCard(b.raw);
    if (r.person && !c.user.can('private')) r.person = { ...r.person, private: {}, email: '' };
    return r;
  }, { lockOk: true }],
  ['POST', '/api/cards/bind', 'plan', (c, _, b) => c.store.bindCard(b.personId, b.raw, { force: !!b.force })],
  ['POST', '/api/cards/:uid/release', 'plan', (c, p, b) => c.store.releaseCard(p.uid, b.status)],

  // ---------- settings (admin) ----------
  ['PATCH', '/api/settings', 'admin', (c, _, b) => c.store.updateSettings(b)],
  ['PATCH', '/api/event', 'admin', (c, _, b) => updateEvent(c.store, b)],
  ['POST', '/api/purge', 'admin', (c, _, b) => {
    if (b.confirm !== 'DELETE') throw new HttpError(400, 'Type DELETE to confirm');
    return c.store.purge({ keepSettings: b.keepSettings !== false });
  }]
];

function publicEvent(store) {
  const e = { ...defaultEvent(), ...(store.db.settings.event || {}) };
  return { name: e.name, tagline: e.tagline, dates: e.dates, location: e.location, intro: e.intro, color: e.color,
    registrationOpen: !!e.registrationOpen, startDate: e.startDate || '' };
}

function updateEvent(store, input) {
  const e = store.db.settings.event = { ...defaultEvent(), ...(store.db.settings.event || {}) };
  for (const k of ['name', 'tagline', 'dates', 'location']) if (k in input) e[k] = clean(input[k], 120);
  if ('intro' in input) e.intro = clean(input.intro, 2000);
  if ('color' in input && /^#[0-9a-fA-F]{6}$/.test(input.color)) e.color = input.color;
  if ('startDate' in input) e.startDate = /^\d{4}-\d{2}-\d{2}$/.test(input.startDate) ? input.startDate : '';
  if ('registrationOpen' in input) e.registrationOpen = !!input.registrationOpen;
  if (!e.name) e.name = 'Youth Camp';
  store.save();
  return publicEvent(store);
}

/** Add more routes (laptop-only or cloud-only) in front of the shared ones. */
export function match(table, method, pathname) {
  for (const [m, pattern, perm, handler, opts = {}] of table) {
    if (m !== method) continue;
    const a = pattern.split('/'), b = pathname.split('/');
    if (a.length !== b.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < a.length; i++) {
      if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i]);
      else if (a[i] !== b[i]) { ok = false; break; }
    }
    if (ok) return { perm, handler, params, opts };
  }
  return null;
}

/**
 * Run one API request. req: { method, path, query (URLSearchParams), body (object), ip }
 * Returns { status, headers, body } where body is a string or Buffer.
 */
export async function runRoute(table, c, req) {
  try {
    const found = match(table, req.method, req.path);
    if (!found) throw new HttpError(404, 'No such API route');
    requirePerm(c.user, found.perm);
    if (c.lock && req.method !== 'GET' && !found.opts.lockOk) {
      throw new HttpError(423, `The cloud copy is checked out to the camp laptop (since ${new Date(c.lock.at).toLocaleString('en-US')}), so it's read-only. Make changes on the laptop, or ask an Admin to unlock it.`);
    }
    const result = await found.handler(c, found.params, req.body || {}, req.query || new URLSearchParams());
    if (result?.__download) {
      return { status: 200, headers: { 'Content-Type': result.type, 'Content-Disposition': `attachment; filename="${result.__download}"` }, body: result.body };
    }
    if (result?.__response) return result.__response;
    return { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(result ?? { ok: true }) };
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    return { status, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ error: status === 500 && c.mode === 'cloud' ? 'Server error' : (e.message || 'Error'), ...(e.extra || {}) }) };
  }
}
