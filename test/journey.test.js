import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateJourney, compileJourney, parseDuration, parseOffset, newJourney, newTask, TASK_TYPES } from '../public/shared/journey.js';
import { parseYaml, JourneyStore } from '../lib/journeys.js';
import { Store } from '../lib/store.js';

const trialText = fs.readFileSync(new URL('../samples/leader-trial.yaml', import.meta.url), 'utf8');
const trial = () => parseYaml(trialText);
const errors = (iss) => iss.filter(i => i.level === 'error');

test('durations', () => {
  assert.equal(parseDuration('8m'), 480);
  assert.equal(parseDuration('45s'), 45);
  assert.equal(parseDuration('1m30s'), 90);
  assert.equal(parseDuration(120), 120);
  assert.equal(parseDuration('90'), 90);
  assert.ok(Number.isNaN(parseDuration('soon')));
});

test('the Leader Trial has no errors', () => {
  const iss = validateJourney(trial());
  assert.deepEqual(errors(iss), []);
});

test('a new Journey and every new Task are valid apart from blanks', () => {
  assert.deepEqual(errors(validateJourney(newJourney('Test'))).map(e => e.path).sort(),
    ['stages.0.tasks.0.choices', 'stages.0.tasks.0.prompt']);
  for (const type of Object.keys(TASK_TYPES)) {
    const t = newTask(type);
    assert.equal(t.type, type);
  }
});

test('catches common mistakes', () => {
  const j = trial();
  j.stages[1].tasks[0].answer = 5;                    // past the end
  j.stages[3].tasks[0].decoys = ['plate-1'];           // fragment and decoy
  j.stages[3].tasks[0].limit = 'soon';                 // bad duration
  j.stages[2].id = j.stages[1].id;                     // duplicate stage id
  j.stages[4].tasks.push({ type: 'dance' });           // unknown type
  j.stages[5].tasks[0].plaintext = 'SHED 2';           // not letters
  j.stages[6].tasks[0].travel.mode = 'path';           // path needs a path name
  const paths = errors(validateJourney(j)).map(e => e.path);
  for (const p of ['stages.1.tasks.0.answer', 'stages.3.tasks.0.decoys', 'stages.3.tasks.0.limit', 'stages.2.id',
    'stages.4.tasks.2.type', 'stages.5.tasks.0.plaintext', 'stages.6.tasks.0.travel.path']) {
    assert.ok(paths.includes(p), `expected an error at ${p}; got ${paths.join(', ')}`);
  }
});

test('places: missing, untagged, tagged', () => {
  const places = { 'lot-corner': { tags: ['04AA'] }, classroom: { tags: [] } };
  const iss = validateJourney(trial(), { places });
  assert.ok(iss.some(i => i.message.includes('"classroom" has no tag')));
  assert.ok(iss.some(i => i.message.includes('"shed" isn\'t set up')));
  assert.ok(!iss.some(i => i.message.includes('"lot-corner"')));
});

test('compile turns durations into seconds and resolves places', () => {
  const c = compileJourney(trial(), { places: { 'plate-1': { name: 'Plate 1', tags: ['04AB'] } } });
  assert.deepEqual(c.penalties.darken_s, [30, 60, 120]);
  assert.equal(c.stages[3].tasks[0].limit, 480);
  assert.equal(c.stages[6].limit, 1200);
  assert.equal(c.stages[6].tasks[0].travel.limit, 480);
  assert.deepEqual(c.places['plate-1'].tags, ['04AB']);
  assert.equal(c.stages[1].tasks[1].travel.mode, 'pointers');
});

test('journey files: import keeps comments, save, rename, duplicate, delete', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liahona-j-'));
  const store = new Store(path.join(dir, 'liahona.json'));
  const js = new JourneyStore(dir, store);
  js.importYaml(trialText);
  assert.ok(fs.readFileSync(js.file('leader-trial'), 'utf8').includes('# Leader Trial'), 'comments kept on import');
  const second = js.importYaml(trialText);
  assert.equal(second.journey.id, 'leader-trial-2', 'second import gets a new ID');
  const { journey } = js.read('leader-trial');
  journey.id = 'trial-renamed';
  js.save(journey, { previousId: 'leader-trial' });
  assert.ok(js.exists('trial-renamed') && !js.exists('leader-trial'));
  js.duplicate('trial-renamed');
  assert.ok(js.exists('trial-renamed-copy'));
  js.remove('trial-renamed-copy');
  assert.ok(!js.exists('trial-renamed-copy'));
  assert.equal(js.list().length, 2);
  assert.ok(js.placeUsage()['plate-1']);
  store.addPlace({ key: 'plate-1', name: 'Plate 1' });
  store.bindPlaceTag('plate-1', '04A1B2C3D4E5F6');
  const p = store.addPerson({ name: 'Ann' });
  assert.throws(() => store.bindCard(p.id, '04A1B2C3D4E5F6'), /place/);
});

test('hint wait: per Task, falling back to the Journey default', () => {
  const j = parseYaml(trialText);
  const c = compileJourney(j);
  assert.equal(c.hint_after, 120);
  assert.equal(c.stages[1].tasks[0].hint_after, 45, 'Task override');
  assert.equal(c.stages[2].tasks[0].hint_after, 120, 'Journey default');
  assert.equal(c.stages[3].tasks[0].hint_after, undefined, 'no hints, no wait');
  j.stages[1].tasks[0].hint_after = 'later';
  assert.ok(validateJourney(j).some(i => i.level === 'error' && i.path === 'stages.1.tasks.0.hint_after'));
  delete j.stages[1].tasks[0].hints;
  j.stages[1].tasks[0].hint_after = 30;
  assert.ok(validateJourney(j).some(i => i.level === 'warning' && i.path === 'stages.1.tasks.0.hint_after'));
});

test('audio playback: snippets, audio hints, replays', () => {
  assert.equal(parseOffset('0:20'), 20);
  assert.equal(parseOffset(0), 0);
  assert.equal(parseOffset('1:05:00'), 3900);
  assert.equal(parseDuration('1:30'), 90);
  const j = parseYaml(trialText);
  assert.deepEqual(errors(validateJourney(j)), []);
  const c = compileJourney(j);
  const clue = c.stages[2].tasks[0];
  assert.deepEqual([clue.start, clue.play_for, clue.audio_hints, clue.hint_adds, clue.hint_audio, clue.replays], [0, 8, 3, 5, 'continue', 1]);
  const hymn = c.stages[7].tasks[1];
  assert.equal(hymn.hint_audio, 'restart');
  assert.equal(hymn.hint_after, 120, 'audio hints get a hint wait even with no text hints');
  delete j.stages[7].tasks[1].play_for;
  assert.equal(compileJourney(j).stages[7].tasks[1].play_for, 10, 'default first play');
  j.stages[2].tasks[0].start = 'intro';
  j.stages[2].tasks[0].hint_audio = 'shuffle';
  const bad = errors(validateJourney(j)).map(e => e.path);
  assert.ok(bad.includes('stages.2.tasks.0.start') && bad.includes('stages.2.tasks.0.hint_audio'));
  assert.equal(compileJourney(parseYaml(trialText)).stages[1].tasks[0].replays, undefined, 'question without a clip has no replays');
});

test('replays wait for the hint timer too', () => {
  const j = parseYaml(trialText);
  j.stages[1].tasks.push({ type: 'clip', clip: 'x.mjpeg' });
  j.stages[1].tasks.push({ type: 'clip', clip: 'y.mjpeg', replays: 0 });
  const c = compileJourney(j);
  assert.equal(c.stages[1].tasks[2].replays, 1);
  assert.equal(c.stages[1].tasks[2].hint_after, 120, 'a clip with replays gets the hint wait');
  assert.equal(c.stages[1].tasks[3].hint_after, undefined, 'no replays, no wait');
  j.stages[1].tasks[3].hint_after = 30;
  assert.ok(validateJourney(j).some(i => i.level === 'warning' && i.path === 'stages.1.tasks.3.hint_after'));
});
