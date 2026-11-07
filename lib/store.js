// Data store: one JSON file on disk, loaded into memory, written atomically
// after every change. 120 people, 12 teams and a few hundred cards is tiny,
// so this is simpler and sturdier than a database for now.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeUid, uidWarning, UID_FORMATS } from './uid.js';
import { csvToPeople, toCsv, parseAge, AGE_MIN, AGE_MAX } from './csv.js';

export const TEAM_TARGET = { youthMin: 8, youthMax: 10, leaders: 2 };

const TEAM_COLORS = ['#C8102E', '#E87722', '#F2C500', '#5B8C2A', '#00843D', '#00A3AD',
  '#0072CE', '#4B2E83', '#A05EB5', '#D6468F', '#7A4A2A', '#5A5A5A'];

const emptyDb = () => ({
  version: 1,
  people: [],
  teams: [],
  cards: [],
  settings: { uidFormat: 'auto', uidBytes: 7 }
});

export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

const id = (prefix) => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
const now = () => new Date().toISOString();
const clean = (v, max = 200) => (v == null ? '' : String(v).trim().slice(0, max));

export class Store {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      this.db = { ...emptyDb(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
      this.migrate();
    } else {
      this.db = emptyDb();
      this.save();
    }
  }

  /** Bring older data files up to date. */
  migrate() {
    let changed = false;
    for (const p of this.db.people) {
      if ('ageGroup' in p) {               // v0.1 stored free text ("14-15")
        p.age = p.role === 'youth' ? parseAge(String(p.ageGroup).match(/\d+/)?.[0]) : null;
        delete p.ageGroup;
        changed = true;
      }
      if (!('age' in p)) { p.age = null; changed = true; }
    }
    if (changed) this.save();
  }

  /** Delete everything (a dated copy is kept in the backups folder first). */
  purge({ keepSettings = true } = {}) {
    const dir = path.join(path.dirname(this.file), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toLocaleString('sv-SE').replace(/[: ]/g, '-');
    const backup = path.join(dir, `liahona-before-purge-${stamp}.json`);
    fs.writeFileSync(backup, JSON.stringify(this.db, null, 2));
    const settings = this.db.settings;
    this.db = emptyDb();
    if (keepSettings) this.db.settings = settings;
    this.save();
    return { backup };
  }

  ageFor(role, value) {
    if (role !== 'youth' || value === '' || value == null) return null;
    const age = parseAge(value);
    if (age === null) throw new HttpError(400, `Age must be a whole number from ${AGE_MIN} to ${AGE_MAX}`);
    return age;
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.db, null, 2));
    fs.renameSync(tmp, this.file);
  }

  // ---------- lookups ----------
  person(pid) {
    const p = this.db.people.find(x => x.id === pid);
    if (!p) throw new HttpError(404, 'Person not found');
    return p;
  }
  team(tid) {
    const t = this.db.teams.find(x => x.id === tid);
    if (!t) throw new HttpError(404, 'Team not found');
    return t;
  }
  activeCardFor(pid) { return this.db.cards.find(c => c.personId === pid && c.status === 'active') || null; }

  state() {
    const people = this.db.people.map(p => ({ ...p, cardUid: this.activeCardFor(p.id)?.uid || null }));
    const teams = this.db.teams.map(t => ({ ...t, ...this.teamCounts(t.id) }));
    return { people, teams, cards: this.db.cards, settings: this.db.settings, target: TEAM_TARGET, uidFormats: UID_FORMATS, ages: { min: AGE_MIN, max: AGE_MAX } };
  }

  teamCounts(tid) {
    const members = this.db.people.filter(p => p.teamId === tid);
    const youth = members.filter(p => p.role === 'youth').length;
    const leaders = members.filter(p => p.role === 'leader').length;
    const ok = youth >= TEAM_TARGET.youthMin && youth <= TEAM_TARGET.youthMax && leaders === TEAM_TARGET.leaders;
    return { youth, leaders, ok };
  }

  assertMovable(p, toTeamId) {
    const from = p.teamId ? this.team(p.teamId) : null;
    if (from?.locked) throw new HttpError(409, `${p.name} is on ${from.name}, which is locked`);
    if (toTeamId) {
      const to = this.team(toTeamId);
      if (to.locked) throw new HttpError(409, `${to.name} is locked`);
    }
  }

  // ---------- people ----------
  addPerson(input) {
    const name = clean(input.name, 120);
    if (!name) throw new HttpError(400, 'Name is required');
    const role = input.role === 'leader' ? 'leader' : 'youth';
    const p = { id: id('p'), name, role, ward: clean(input.ward, 80), age: this.ageFor(role, input.age),
      notes: clean(input.notes, 500), teamId: null, absent: false, createdAt: now() };
    if (input.teamId) { this.assertMovable(p, input.teamId); p.teamId = input.teamId; }
    this.db.people.push(p);
    this.save();
    return p;
  }

  updatePerson(pid, input) {
    const p = this.person(pid);
    if ('name' in input) {
      const name = clean(input.name, 120);
      if (!name) throw new HttpError(400, 'Name is required');
      p.name = name;
    }
    if ('role' in input) {
      const role = input.role === 'leader' ? 'leader' : 'youth';
      if (role !== p.role && p.teamId && this.team(p.teamId).locked) throw new HttpError(409, 'Unlock the team to change roles');
      p.role = role;
      if (role === 'leader') p.age = null;
    }
    if ('age' in input) p.age = this.ageFor(p.role, input.age);
    for (const k of ['ward', 'notes']) if (k in input) p[k] = clean(input[k], k === 'notes' ? 500 : 80);
    this.save();
    return p;
  }

  deletePerson(pid) {
    const p = this.person(pid);
    this.assertMovable(p, null);
    this.db.people = this.db.people.filter(x => x.id !== pid);
    for (const c of this.db.cards) if (c.personId === pid && c.status === 'active') { c.status = 'spare'; c.personId = null; }
    this.save();
  }

  importCsv(text, { teamsFromCsv = true } = {}) {
    const { people, errors } = csvToPeople(text || '');
    const existing = new Set(this.db.people.map(p => p.name.toLowerCase()));
    const added = [];
    const skipped = [];
    for (const draft of people) {
      if (existing.has(draft.name.toLowerCase())) { skipped.push(draft.name); continue; }
      let teamId = null;
      if (teamsFromCsv && draft.team) {
        let t = this.db.teams.find(x => x.name.toLowerCase() === draft.team.toLowerCase());
        if (!t) t = this.createTeam({ name: draft.team }, false);
        if (!t.locked) teamId = t.id;
      }
      const p = { id: id('p'), name: draft.name, role: draft.role, ward: draft.ward, age: draft.age,
        notes: draft.notes, teamId, absent: false, createdAt: now() };
      this.db.people.push(p);
      existing.add(p.name.toLowerCase());
      added.push(p.name);
    }
    this.save();
    return { added: added.length, skipped, errors };
  }

  // ---------- teams ----------
  createTeam(input = {}, persist = true) {
    const n = this.db.teams.length;
    const t = { id: id('t'), name: clean(input.name, 60) || `Team ${n + 1}`,
      color: /^#[0-9a-fA-F]{6}$/.test(input.color || '') ? input.color : TEAM_COLORS[n % TEAM_COLORS.length],
      ballId: clean(input.ballId, 40), locked: false };
    this.db.teams.push(t);
    if (persist) this.save();
    return t;
  }

  generateTeams(count) {
    const c = Math.max(1, Math.min(40, Number(count) || 0));
    const made = [];
    while (this.db.teams.length < c) made.push(this.createTeam({}, false));
    this.save();
    return made;
  }

  updateTeam(tid, input) {
    const t = this.team(tid);
    if ('name' in input) t.name = clean(input.name, 60) || t.name;
    if ('color' in input && /^#[0-9a-fA-F]{6}$/.test(input.color)) t.color = input.color;
    if ('ballId' in input) t.ballId = clean(input.ballId, 40);
    if ('locked' in input) t.locked = !!input.locked;
    this.save();
    return t;
  }

  deleteTeam(tid) {
    const t = this.team(tid);
    if (t.locked) throw new HttpError(409, 'Unlock the team before deleting it');
    for (const p of this.db.people) if (p.teamId === tid) p.teamId = null;
    this.db.teams = this.db.teams.filter(x => x.id !== tid);
    this.save();
  }

  assign(personIds, teamId) {
    const people = (personIds || []).map(pid => this.person(pid));
    for (const p of people) this.assertMovable(p, teamId || null);
    for (const p of people) p.teamId = teamId || null;
    this.save();
    return people.length;
  }

  /**
   * Fill unlocked teams from the unassigned pool.
   * Youth go to the team with the fewest youth, breaking ties by fewest of the same
   * age group, then the same ward, so groups come out balanced. Leaders top each
   * team up to 2.
   */
  autofill() {
    const teams = this.db.teams.filter(t => !t.locked);
    if (!teams.length) throw new HttpError(400, 'Create at least one unlocked team first');
    const members = (tid) => this.db.people.filter(p => p.teamId === tid);
    const pool = this.db.people.filter(p => !p.teamId);
    const sortKey = (p) => `${String(p.age ?? 99).padStart(2, '0')}\u0000${p.ward}\u0000${p.name}`;
    let moved = 0;

    const youth = pool.filter(p => p.role === 'youth').sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    for (const p of youth) {
      const scored = teams.map(t => {
        const m = members(t.id).filter(x => x.role === 'youth');
        return { t, n: m.length, age: m.filter(x => x.age === p.age).length, ward: m.filter(x => x.ward === p.ward).length };
      }).sort((a, b) => a.n - b.n || a.age - b.age || a.ward - b.ward);
      p.teamId = scored[0].t.id;
      moved++;
    }

    const leaders = pool.filter(p => p.role === 'leader').sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    for (const p of leaders) {
      const scored = teams.map(t => {
        const m = members(t.id).filter(x => x.role === 'leader');
        return { t, n: m.length, ward: m.filter(x => x.ward === p.ward).length };
      }).filter(s => s.n < TEAM_TARGET.leaders).sort((a, b) => a.n - b.n || a.ward - b.ward);
      if (!scored.length) break;
      p.teamId = scored[0].t.id;
      moved++;
    }
    this.save();
    return moved;
  }

  // ---------- cards ----------
  updateSettings(input) {
    const s = this.db.settings;
    if ('uidFormat' in input) {
      if (!UID_FORMATS.includes(input.uidFormat)) throw new HttpError(400, 'Unknown card ID format');
      s.uidFormat = input.uidFormat;
    }
    if ('uidBytes' in input) {
      const b = Number(input.uidBytes);
      if (![4, 7, 10].includes(b)) throw new HttpError(400, 'Card IDs are 4, 7 or 10 bytes');
      s.uidBytes = b;
    }
    this.save();
    return s;
  }

  parseUid(raw) {
    try {
      const { uid, detected } = normalizeUid(raw, { format: this.db.settings.uidFormat, byteLength: this.db.settings.uidBytes });
      return { uid, detected, warning: uidWarning(uid, this.db.settings.uidBytes) };
    } catch (e) {
      throw new HttpError(400, e.message);
    }
  }

  /** Look up a scanned card: who it belongs to, if anyone. */
  lookupCard(raw) {
    const parsed = this.parseUid(raw);
    const card = this.db.cards.find(c => c.uid === parsed.uid) || null;
    const person = card?.personId ? this.db.people.find(p => p.id === card.personId) : null;
    const team = person?.teamId ? this.db.teams.find(t => t.id === person.teamId) : null;
    return { ...parsed, card, person: person || null, team: team || null };
  }

  /**
   * Bind a scanned card to a person. A person has at most one active card: binding
   * a new one marks the old one lost. A card already on someone else is refused
   * unless `force`, which moves it.
   */
  bindCard(personId, raw, { force = false } = {}) {
    const p = this.person(personId);
    const { uid, warning } = this.parseUid(raw);
    let card = this.db.cards.find(c => c.uid === uid);
    if (card?.personId === p.id && card.status === 'active') return { card, person: p, warning, unchanged: true };
    if (card?.status === 'active' && card.personId && !force) {
      const owner = this.db.people.find(x => x.id === card.personId);
      throw new HttpError(409, `This card already belongs to ${owner?.name || 'someone else'}`, { ownerId: card.personId, uid });
    }
    const old = this.activeCardFor(p.id);
    if (old) { old.status = 'lost'; old.changedAt = now(); }
    if (!card) { card = { uid }; this.db.cards.push(card); }
    Object.assign(card, { personId: p.id, status: 'active', boundAt: now(), changedAt: now() });
    this.save();
    return { card, person: p, warning, replaced: old?.uid || null };
  }

  /** Mark a person's card lost (or unbind it as a spare). */
  releaseCard(uid, status = 'lost') {
    const card = this.db.cards.find(c => c.uid === uid);
    if (!card) throw new HttpError(404, 'Card not found');
    card.status = status === 'spare' ? 'spare' : 'lost';
    if (card.status === 'spare') card.personId = null;
    card.changedAt = now();
    this.save();
    return card;
  }

  // ---------- exports ----------
  /**
   * What every ball gets: the whole roster (so a ball can say "Sarah is on Team 3"
   * for a card from another team) keyed by card UID, plus the team list.
   */
  ballRoster() {
    const teams = this.db.teams.map(t => ({ id: t.id, name: t.name, color: t.color, ballId: t.ballId }));
    const people = this.db.people.map(p => ({ id: p.id, name: p.name, role: p.role, teamId: p.teamId }));
    const cards = {};
    for (const c of this.db.cards) if (c.status === 'active' && c.personId) cards[c.uid] = c.personId;
    return { generatedAt: now(), uidFormat: 'hex-msb-first', teams, people, cards };
  }

  peopleCsv() {
    const teamName = (tid) => this.db.teams.find(t => t.id === tid)?.name || '';
    const rows = [['name', 'role', 'ward', 'age', 'team', 'card', 'notes']];
    const sorted = [...this.db.people].sort((a, b) => teamName(a.teamId).localeCompare(teamName(b.teamId)) || a.name.localeCompare(b.name));
    for (const p of sorted) rows.push([p.name, p.role, p.ward, p.age ?? '', teamName(p.teamId), this.activeCardFor(p.id)?.uid || '', p.notes]);
    return toCsv(rows);
  }
}
