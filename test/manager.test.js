import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeUid } from '../lib/uid.js';
import { csvToPeople } from '../lib/csv.js';
import { Store } from '../lib/store.js';

const tmpStore = () => new Store(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'liahona-')), 'db.json'));
const sample = fs.readFileSync(new URL('../public/sample-roster.csv', import.meta.url), 'utf8');

test('UID: hex with separators, lowercase', () => {
  assert.equal(normalizeUid('04:a1:b2:c3:d4:e5:f6').uid, '04A1B2C3D4E5F6');
});
test('UID: decimal and reversed decimal', () => {
  const dec = BigInt('0x04A1B2C3D4E5F6').toString();
  assert.equal(normalizeUid(dec).uid, '04A1B2C3D4E5F6');
  const rev = BigInt('0xF6E5D4C3B2A104').toString();
  assert.equal(normalizeUid(rev, { format: 'decimal-reversed' }).uid, '04A1B2C3D4E5F6');
});
test('UID: rejects junk', () => {
  assert.throws(() => normalizeUid('hello'));
  assert.throws(() => normalizeUid(''));
});

test('CSV: header aliases, quotes, roles', () => {
  const { people, errors } = csvToPeople('First Name,Last Name,Type,Unit,Age\nAnn,Lee,adult,Maple,44\n"Bo","Ray",,"Cedar, North",15\nCy,Fox,alien,X,\nDee,Ott,youth,X,12\n');
  assert.equal(people.length, 3);
  assert.deepEqual(people.map(p => [p.name, p.role, p.ward, p.age]),
    [['Ann Lee', 'leader', 'Maple', null], ['Bo Ray', 'youth', 'Cedar, North', 15], ['Dee Ott', 'youth', 'X', null]]);
  assert.equal(errors.length, 2, 'bad role + out-of-range age');
});

test('import, teams, autofill balance', () => {
  const s = tmpStore();
  const r = s.importCsv(sample);
  assert.equal(r.added, 120);
  assert.equal(s.importCsv(sample).added, 0, 're-import skips duplicates');
  // 100 youth + 20 leaders fills exactly 10 teams of 10 youth + 2 leaders.
  s.generateTeams(10);
  s.autofill();
  const st = s.state();
  assert.equal(st.people.filter(p => !p.teamId).length, 0);
  for (const t of st.teams) {
    assert.equal(t.youth, 10, `${t.name} has ${t.youth} youth`);
    assert.equal(t.leaders, 2);
    assert.ok(t.ok);
  }
});

test('12 teams with 20 leaders flags the short teams', () => {
  const s = tmpStore();
  s.importCsv(sample);
  s.generateTeams(12);
  s.autofill();
  const st = s.state();
  assert.equal(st.people.filter(p => !p.teamId).length, 0);
  assert.equal(st.teams.filter(t => t.leaders === 1).length, 4);
  assert.equal(st.teams.filter(t => !t.ok).length, 4);
  for (const t of st.teams) assert.ok(t.youth >= 8 && t.youth <= 9);
});

test('locked teams refuse moves', () => {
  const s = tmpStore();
  const t = s.createTeam({ name: 'A' });
  const p = s.addPerson({ name: 'Zed', teamId: t.id });
  s.updateTeam(t.id, { locked: true });
  assert.throws(() => s.assign([p.id], null), /locked/);
});

test('cards: bind, conflict, force, replace', () => {
  const s = tmpStore();
  const a = s.addPerson({ name: 'Ann' });
  const b = s.addPerson({ name: 'Bo' });
  s.bindCard(a.id, '04A1B2C3D4E5F6');
  assert.throws(() => s.bindCard(b.id, '04a1b2c3d4e5f6'), e => e.status === 409);
  s.bindCard(b.id, '04A1B2C3D4E5F6', { force: true });
  assert.equal(s.activeCardFor(a.id), null);
  assert.equal(s.activeCardFor(b.id).uid, '04A1B2C3D4E5F6');
  const r = s.bindCard(b.id, '04111111111111');
  assert.equal(r.replaced, '04A1B2C3D4E5F6');
  assert.equal(s.db.cards.find(c => c.uid === '04A1B2C3D4E5F6').status, 'lost');
  const roster = s.ballRoster();
  assert.deepEqual(roster.cards, { '04111111111111': b.id });
  assert.equal(s.lookupCard('04111111111111').person.name, 'Bo');
});

test('ages: 13-18 only, leaders have none', () => {
  const s = tmpStore();
  const p = s.addPerson({ name: 'Kid', age: '16' });
  assert.equal(p.age, 16);
  assert.throws(() => s.updatePerson(p.id, { age: 12 }), /13 to 18/);
  assert.equal(s.updatePerson(p.id, { age: '' }).age, null);
  assert.equal(s.addPerson({ name: 'Adult', role: 'leader', age: 40 }).age, null);
});

test('old age-group text is migrated to a number', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liahona-'));
  const file = path.join(dir, 'db.json');
  fs.writeFileSync(file, JSON.stringify({ people: [{ id: 'p1', name: 'A', role: 'youth', ageGroup: '14-15' }, { id: 'p2', name: 'B', role: 'leader', ageGroup: 'adults' }] }));
  const s = new Store(file);
  assert.deepEqual(s.db.people.map(p => [p.age, 'ageGroup' in p]), [[14, false], [null, false]]);
});

test('purge empties everything but keeps a backup and settings', () => {
  const s = tmpStore();
  s.importCsv(sample);
  s.updateSettings({ uidFormat: 'decimal' });
  const { backup } = s.purge();
  assert.equal(s.db.people.length, 0);
  assert.equal(s.db.settings.uidFormat, 'decimal');
  assert.equal(JSON.parse(fs.readFileSync(backup, 'utf8')).people.length, 120);
});
