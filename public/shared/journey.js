// Journey format: Task types, checker and compiler.
// Shared by the server (Node) and the designer (browser), so both always agree.
//
// A Journey is plain data (it's saved as YAML):
//   id, title, description?, penalties {darken_s[], unity_restore}, media?, stages[], routes?
// A Stage: id, name, gather, brief?, travel?, limit?, tasks[]
// A Task: type, plus that type's fields, plus optional brief / travel / hints.

export const GATHER_MODES = {
  roll_call: 'Roll call (everyone taps)',
  unity_touch: 'Unity touch (all fingers on the glass)',
  circle_up: 'Circle up (roll call inside the start area)',
  none: 'No gathering'
};

export const TRAVEL_MODES = {
  pointers: 'Follow the pointers',
  race: 'Race (pointers + countdown)',
  path: 'Stay on the path',
  directions: 'Written directions (tag-only places)'
};

export const DARKEN_RESTORE = { unity: 'Unity (everyone taps)', leader: 'Leader card', wait: 'Wait it out' };
export const HINT_AUDIO = { continue: 'Continue from where it paused', restart: 'Start over and play longer' };
export const CIPHERS = { 'reformed-egyptian': 'Reformed Egyptian symbols', pigpen: 'Pigpen', caesar: 'Shift (Caesar)' };

// Field kinds the designer knows how to draw:
//   text, longtext, number, duration, select, choices, answer, items, places, media, time
export const TASK_TYPES = {
  intro: {
    label: 'Introduction', group: 'Story',
    help: 'The ball introduces itself, Darkened and hints. Leave the text blank for the standard intro.',
    fields: [{ key: 'text', kind: 'longtext', label: 'What the ball says' }]
  },
  question: {
    label: 'Question', group: 'Knowledge',
    help: 'A question with 2 to 6 answers as touch targets. Add an image or clip to show first.',
    fields: [
      { key: 'prompt', kind: 'text', label: 'Question', required: true },
      { key: 'choices', kind: 'choices', label: 'Answers', required: true, min: 2, max: 6 },
      { key: 'answer', kind: 'answer', label: 'Correct answer', required: true, of: 'choices' },
      { key: 'image', kind: 'media', label: 'Image', media: 'image' },
      { key: 'clip', kind: 'media', label: 'Clip', media: 'clip' },
      { key: 'replays', kind: 'number', label: 'Replays allowed', section: 'Playback', min: 0, max: 5, placeholder: '1', help: 'Offered after the hint wait, like hints. Each replay counts as a hint.' }
    ]
  },
  true_false: {
    label: 'True or false', group: 'Knowledge',
    fields: [
      { key: 'prompt', kind: 'text', label: 'Statement', required: true },
      { key: 'answer', kind: 'select', label: 'Correct answer', required: true, options: { true: 'True', false: 'False' } }
    ]
  },
  scripture_ref: {
    label: 'Find the verse', group: 'Knowledge',
    help: 'The team dials in book, chapter and verse.',
    fields: [
      { key: 'prompt', kind: 'text', label: 'Prompt', required: true, placeholder: 'Where is "I will go and do"?' },
      { key: 'answer', kind: 'text', label: 'Reference', required: true, placeholder: '1 Nephi 3:7', pattern: 'reference' },
      { key: 'passage', kind: 'longtext', label: 'Passage to show (optional)' }
    ]
  },
  order_it: {
    label: 'Put in order', group: 'Knowledge',
    help: 'List the items in the correct order. The ball shuffles them.',
    fields: [
      { key: 'prompt', kind: 'text', label: 'Prompt', required: true },
      { key: 'items', kind: 'items', label: 'Items, in the correct order', required: true, min: 3, max: 6 }
    ]
  },
  audio_clue: {
    label: 'Audio clue', group: 'Audio and video',
    help: 'Plays a short snippet of a song, then pauses. Each hint plays more of it. The answer is where they go next, so follow it with a check-in.',
    fields: [
      { key: 'audio', kind: 'media', label: 'Audio', media: 'audio', required: true },
      { key: 'prompt', kind: 'text', label: 'Prompt', placeholder: 'Where does this song send you?' },
      { key: 'start', kind: 'offset', label: 'Start at', section: 'Playback', placeholder: '0:00', help: 'Where in the file to begin, e.g. 0:20 to skip an intro.' },
      { key: 'play_for', kind: 'duration', label: 'First play', section: 'Playback', placeholder: '10s', help: 'How much plays before it pauses.' },
      { key: 'audio_hints', kind: 'number', label: 'Audio hints', section: 'Playback', min: 0, max: 5, placeholder: '3', help: 'How many times a hint plays more of the song.' },
      { key: 'hint_adds', kind: 'duration', label: 'Each hint plays', section: 'Playback', placeholder: '5s' },
      { key: 'hint_audio', kind: 'select', label: 'On a hint', section: 'Playback', options: HINT_AUDIO },
      { key: 'replays', kind: 'number', label: 'Replays allowed', section: 'Playback', min: 0, max: 5, placeholder: '1', help: 'Offered after the hint wait, like hints. Each replay counts as a hint.' }
    ]
  },
  name_that_hymn: {
    label: 'Name that hymn', group: 'Audio and video',
    help: 'Plays a short snippet of an instrumental, then pauses. Each hint plays more of it.',
    fields: [
      { key: 'audio', kind: 'media', label: 'Audio', media: 'audio', required: true },
      { key: 'prompt', kind: 'text', label: 'Prompt', placeholder: 'Which hymn is this?' },
      { key: 'choices', kind: 'choices', label: 'Hymns', required: true, min: 2, max: 6 },
      { key: 'answer', kind: 'answer', label: 'Correct hymn', required: true, of: 'choices' },
      { key: 'start', kind: 'offset', label: 'Start at', section: 'Playback', placeholder: '0:00', help: 'Where in the file to begin, e.g. 0:20 to skip an intro.' },
      { key: 'play_for', kind: 'duration', label: 'First play', section: 'Playback', placeholder: '10s', help: 'How much plays before it pauses.' },
      { key: 'audio_hints', kind: 'number', label: 'Audio hints', section: 'Playback', min: 0, max: 5, placeholder: '3', help: 'How many times a hint plays more of the song.' },
      { key: 'hint_adds', kind: 'duration', label: 'Each hint plays', section: 'Playback', placeholder: '5s' },
      { key: 'hint_audio', kind: 'select', label: 'On a hint', section: 'Playback', options: HINT_AUDIO },
      { key: 'replays', kind: 'number', label: 'Replays allowed', section: 'Playback', min: 0, max: 5, placeholder: '1', help: 'Offered after the hint wait, like hints. Each replay counts as a hint.' }
    ]
  },
  clip: {
    label: 'Watch a clip', group: 'Audio and video',
    fields: [
      { key: 'clip', kind: 'media', label: 'Clip', media: 'clip', required: true },
      { key: 'prompt', kind: 'text', label: 'Caption' },
      { key: 'replays', kind: 'number', label: 'Replays allowed', section: 'Playback', min: 0, max: 5, placeholder: '1', help: 'Offered after the hint wait, like hints. Each replay counts as a hint.' }
    ]
  },
  sing: {
    label: 'Sing together', group: 'Audio and video',
    help: 'The team sings; the ball listens for steady singing for the set time.',
    fields: [
      { key: 'prompt', kind: 'text', label: 'What to sing', required: true, placeholder: 'Sing the first verse of "Come, Come, Ye Saints"' },
      { key: 'seconds', kind: 'number', label: 'Seconds of singing', required: true, min: 5, max: 300 }
    ]
  },
  checkin: {
    label: 'Check in', group: 'Location',
    help: 'Tap a place\'s tag. Add Travel to guide them there first.',
    fields: [{ key: 'tags', kind: 'places', label: 'Places that count', required: true, min: 1 }]
  },
  gather_fragments: {
    label: 'Gather the fragments', group: 'Location',
    help: 'Find every tag in the set, in any order. A decoy darkens the ball.',
    fields: [
      { key: 'tags', kind: 'places', label: 'Fragments to find', required: true, min: 2 },
      { key: 'decoys', kind: 'places', label: 'Decoys' },
      { key: 'limit', kind: 'duration', label: 'Time limit', placeholder: '8m' }
    ]
  },
  cipher: {
    label: 'Cipher', group: 'Puzzles',
    help: 'Shows the word in a symbol alphabet with a key to decode it.',
    fields: [
      { key: 'alphabet', kind: 'select', label: 'Alphabet', required: true, options: CIPHERS },
      { key: 'plaintext', kind: 'text', label: 'Hidden word', required: true, pattern: 'letters' },
      { key: 'prompt', kind: 'text', label: 'Prompt' }
    ]
  },
  be_still: {
    label: 'Be still', group: 'Activities',
    help: 'Silence for the set time, measured by the microphones. Talking restarts it.',
    fields: [{ key: 'seconds', kind: 'number', label: 'Seconds', required: true, min: 5, max: 300 }]
  },
  hold_course: {
    label: 'Hold the course', group: 'Activities',
    help: 'Keep the ball pointed at a bearing for the set time.',
    fields: [
      { key: 'bearing', kind: 'number', label: 'Bearing (degrees)', required: true, min: 0, max: 359 },
      { key: 'tolerance', kind: 'number', label: 'Allowed drift (±degrees)', min: 5, max: 90, placeholder: '15' },
      { key: 'seconds', kind: 'number', label: 'Seconds', required: true, min: 5, max: 600 }
    ]
  },
  leader_approve: {
    label: 'Leader approves', group: 'Activities',
    help: 'For anything the sensors can\'t judge. A station leader taps their card.',
    fields: [{ key: 'prompt', kind: 'text', label: 'What the team must do', required: true }]
  },
  testimony: {
    label: 'Testimony moment', group: 'Activities',
    help: 'Each member shares, then taps their card once.',
    fields: [{ key: 'prompt', kind: 'text', label: 'Prompt' }]
  },
  scripted_darken: {
    label: 'Scripted darkening', group: 'Story',
    help: 'The ball goes dark on purpose, as a lesson.',
    fields: [
      { key: 'restore', kind: 'select', label: 'Restored by', required: true, options: DARKEN_RESTORE },
      { key: 'seconds', kind: 'number', label: 'Seconds (for Wait it out)', min: 5, max: 600 }
    ]
  },
  rest: {
    label: 'Rest until', group: 'Story',
    help: 'Locks the Journey until a set time, such as after lunch or the next morning.',
    fields: [
      { key: 'until', kind: 'time', label: 'Unlocks at', required: true, placeholder: '13:30' },
      { key: 'prompt', kind: 'text', label: 'Message' }
    ]
  }
};

export const TASK_GROUPS = ['Story', 'Knowledge', 'Audio and video', 'Location', 'Puzzles', 'Activities'];

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const REF_RE = /^(\d\s)?[A-Za-z&. ]+ \d+:\d+(-\d+)?$/;

export function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

/** "8m", "45s", "1h", "1m30s" or a number of seconds -> seconds; NaN if not a duration. */
export function parseDuration(v) {
  if (typeof v === 'number') return v > 0 ? v : NaN;
  if (typeof v !== 'string') return NaN;
  const s = v.trim().toLowerCase();
  if (/^\d+$/.test(s)) return Number(s) || NaN;
  const clock = s.match(/^(?:(\d+):)?(\d+):([0-5]\d)$/);
  if (clock) return (Number(clock[1] || 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3])) || NaN;
  const m = s.match(/^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?$/);
  if (!m || (!m[1] && !m[2] && !m[3])) return NaN;
  const secs = (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
  return secs || NaN;
}

/** A position in a file: 0, 20, "20s", "0:20" or "1:05:00" -> seconds (0 allowed); NaN if not. */
export function parseOffset(v) {
  if (typeof v === 'number') return v >= 0 ? v : NaN;
  if (typeof v !== 'string') return NaN;
  const s = v.trim();
  const clock = s.match(/^(?:(\d+):)?(\d+):([0-5]\d)$/);
  if (clock) return Number(clock[1] || 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  if (/^0+s?$/.test(s)) return 0;
  return parseDuration(s);
}

/** Playback defaults for audio Tasks (seconds). */
export const AUDIO_DEFAULTS = { start: 0, play_for: 10, audio_hints: 3, hint_adds: 5, hint_audio: 'continue', replays: 1 };
export const VIDEO_DEFAULTS = { replays: 1 };

export function formatDuration(secs) {
  if (!Number.isFinite(secs)) return '';
  const m = Math.floor(secs / 60), s = secs % 60;
  return m && s ? `${m}m${s}s` : m ? `${m}m` : `${s}s`;
}

/** Default wait before a Task offers its first hint, when the Journey doesn't set one. */
export const DEFAULT_HINT_AFTER = 120;

export function newJourney(title = 'New Journey') {
  return {
    id: slugify(title) || 'new-journey',
    title,
    penalties: { darken_s: [30, 60, 120], unity_restore: true },
    hint_after: '2m',
    stages: [newStage(1)]
  };
}

export function newStage(n = 1) {
  return { id: `stage-${n}`, name: `Stage ${n}`, gather: 'roll_call', tasks: [newTask('question')] };
}

export function newTask(type) {
  const t = { type };
  const def = TASK_TYPES[type];
  for (const f of def?.fields || []) {
    if (f.kind === 'choices') t[f.key] = ['', ''];
    if (f.kind === 'items') t[f.key] = ['', '', ''];
    if (f.kind === 'answer') t[f.key] = 0;
    if (f.kind === 'places') if (f.required) t[f.key] = [];
    if (f.kind === 'select' && f.required) t[f.key] = Object.keys(f.options)[0];
    if (f.kind === 'number' && f.required) t[f.key] = f.min > 30 ? f.min : 30;
  }
  if (type === 'true_false') t.answer = 'true';
  return t;
}

const AUDIO_TASKS = new Set(['audio_clue', 'name_that_hymn']);
export function hasAudioHints(t) { return AUDIO_TASKS.has(t?.type) && (t.audio_hints ?? AUDIO_DEFAULTS.audio_hints) > 0; }
/** Replays a Task allows (0 if it has nothing to replay). */
export function replaysFor(t) {
  if (AUDIO_TASKS.has(t?.type)) return t.replays ?? AUDIO_DEFAULTS.replays;
  if (t?.type === 'clip' || (t?.type === 'question' && t.clip)) return t.replays ?? VIDEO_DEFAULTS.replays;
  return 0;
}
/** True when a Task shows a hint or replay button, so it needs a hint wait. */
export function hasHelp(t) { return !!t?.hints?.length || hasAudioHints(t) || replaysFor(t) > 0; }

/** Every place key a Journey mentions, with where. */
export function referencedPlaces(j) {
  const out = [];
  const add = (key, path, role) => { if (typeof key === 'string' && key) out.push({ key, path, role }); };
  (j?.stages || []).forEach((st, si) => {
    if (st?.travel?.to) add(st.travel.to, `stages.${si}.travel.to`, 'travel');
    (st?.tasks || []).forEach((t, ti) => {
      const p = `stages.${si}.tasks.${ti}`;
      if (t?.travel?.to) add(t.travel.to, `${p}.travel.to`, 'travel');
      for (const k of Array.isArray(t?.tags) ? t.tags : []) add(k, `${p}.tags`, 'tag');
      for (const k of Array.isArray(t?.decoys) ? t.decoys : []) add(k, `${p}.decoys`, 'tag');
    });
  });
  return out;
}

/** Every media file a Journey mentions. */
export function referencedMedia(j) {
  const out = [];
  const visit = (o, path) => {
    if (!o || typeof o !== 'object') return;
    for (const k of ['image', 'audio', 'clip']) if (typeof o[k] === 'string' && o[k]) out.push({ file: o[k], path: `${path}.${k}` });
    if (o.brief) visit(o.brief, `${path}.brief`);
  };
  (j?.stages || []).forEach((st, si) => {
    visit(st, `stages.${si}`);
    (st?.tasks || []).forEach((t, ti) => visit(t, `stages.${si}.tasks.${ti}`));
  });
  return out;
}

/**
 * Check a Journey. Returns [{level: 'error'|'warning', path, message}].
 * ctx (all optional): places {key: {tags: [], tagOnly}}, mediaFiles (Set of names), teams (names)
 * Errors stop a Journey from going to the balls; warnings are things to finish before camp.
 */
export function validateJourney(j, ctx = {}) {
  const issues = [];
  const err = (path, message) => issues.push({ level: 'error', path, message });
  const warn = (path, message) => issues.push({ level: 'warning', path, message });
  const str = (v) => typeof v === 'string' && v.trim() !== '';

  if (!j || typeof j !== 'object' || Array.isArray(j)) { err('', 'The file is not a Journey (expected id, title and stages)'); return issues; }
  if (!str(j.id)) err('id', 'Journey ID is required');
  else if (!ID_RE.test(j.id)) err('id', 'Journey ID must be lowercase letters, numbers and dashes');
  if (!str(j.title)) err('title', 'Title is required');

  const pen = j.penalties;
  if (pen !== undefined) {
    const list = pen?.darken_s;
    if (!Array.isArray(list) || list.length < 1 || list.length > 3 || list.some(d => !Number.isFinite(parseDuration(d)))) {
      err('penalties.darken_s', 'Darkened times must be 1 to 3 durations, like 30, 60, 120 or 30s, 1m, 2m');
    }
    if (pen && 'unity_restore' in pen && typeof pen.unity_restore !== 'boolean') err('penalties.unity_restore', 'Unity restore must be true or false');
  }

  if (j.hint_after !== undefined && !Number.isFinite(parseDuration(j.hint_after))) err('hint_after', `Hint wait "${j.hint_after}" isn't a duration (try 2m or 90)`);

  if (!Array.isArray(j.stages) || j.stages.length === 0) { err('stages', 'A Journey needs at least one Stage'); return issues; }

  const stageIds = new Set();
  j.stages.forEach((st, si) => {
    const sp = `stages.${si}`;
    const label = `Stage ${si + 1}${str(st?.name) ? ` (${st.name})` : ''}`;
    if (!st || typeof st !== 'object') { err(sp, `${label} is empty`); return; }
    if (!str(st.id)) err(`${sp}.id`, `${label}: Stage ID is required`);
    else if (!ID_RE.test(st.id)) err(`${sp}.id`, `${label}: Stage ID must be lowercase letters, numbers and dashes`);
    else if (stageIds.has(st.id)) err(`${sp}.id`, `${label}: Stage ID "${st.id}" is used twice`);
    else stageIds.add(st.id);
    if (!str(st.name)) err(`${sp}.name`, `${label}: name is required`);
    if (st.gather !== undefined && !(st.gather in GATHER_MODES)) err(`${sp}.gather`, `${label}: unknown gathering "${st.gather}"`);
    if (st.limit !== undefined && !Number.isFinite(parseDuration(st.limit))) err(`${sp}.limit`, `${label}: time limit "${st.limit}" isn't a duration (try 20m)`);
    checkBrief(st.brief, `${sp}.brief`, label);
    checkTravel(st.travel, `${sp}.travel`, label);

    if (!Array.isArray(st.tasks) || st.tasks.length === 0) { err(`${sp}.tasks`, `${label}: needs at least one Task`); return; }
    st.tasks.forEach((t, ti) => checkTask(t, `${sp}.tasks.${ti}`, `${label}, Task ${ti + 1}`));
  });

  function checkBrief(b, path, label) {
    if (b === undefined || b === null) return;
    if (typeof b !== 'object' || Array.isArray(b)) { err(path, `${label}: brief must have ref, text, image, audio or clip`); return; }
    const known = ['ref', 'text', 'image', 'audio', 'clip'];
    for (const k of Object.keys(b)) if (!known.includes(k)) warn(`${path}.${k}`, `${label}: brief has an unknown field "${k}"`);
    if (b.ref !== undefined && (!str(b.ref) || !REF_RE.test(b.ref.trim()))) warn(`${path}.ref`, `${label}: "${b.ref}" doesn't look like a reference (e.g. 1 Nephi 16:10 or Alma 32:21-23)`);
  }

  function checkTravel(tr, path, label) {
    if (tr === undefined || tr === null) return;
    if (typeof tr !== 'object' || Array.isArray(tr)) { err(path, `${label}: travel must have a "to" place`); return; }
    if (!str(tr.to)) err(`${path}.to`, `${label}: travel needs a place to go to`);
    else if (!ID_RE.test(tr.to)) err(`${path}.to`, `${label}: place name "${tr.to}" must be lowercase letters, numbers and dashes`);
    const mode = tr.mode ?? 'pointers';
    if (!(mode in TRAVEL_MODES)) err(`${path}.mode`, `${label}: unknown travel mode "${tr.mode}"`);
    if (mode === 'path' && !str(tr.path)) err(`${path}.path`, `${label}: "Stay on the path" needs a path name`);
    if (mode === 'race' && tr.limit === undefined) warn(`${path}.limit`, `${label}: a race usually has a time limit`);
    if (tr.limit !== undefined && !Number.isFinite(parseDuration(tr.limit))) err(`${path}.limit`, `${label}: time limit "${tr.limit}" isn't a duration`);
    const place = ctx.places?.[tr.to];
    if (place && mode === 'pointers' && place.tagOnly) warn(`${path}.mode`, `${label}: "${tr.to}" is tag-only (no GPS), so use Written directions`);
  }

  function checkTask(t, path, label) {
    if (!t || typeof t !== 'object') { err(path, `${label} is empty`); return; }
    const def = TASK_TYPES[t.type];
    if (!def) { err(`${path}.type`, `${label}: unknown Task type "${t.type}"`); return; }
    const name = `${label} (${def.label})`;
    for (const f of def.fields) {
      const v = t[f.key];
      const fp = `${path}.${f.key}`;
      const missing = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
      if (missing) { if (f.required) err(fp, `${name}: ${f.label.toLowerCase()} is required`); continue; }
      switch (f.kind) {
        case 'text': case 'longtext': case 'media': case 'time':
          if (typeof v !== 'string') { err(fp, `${name}: ${f.label.toLowerCase()} must be text`); break; }
          if (f.pattern === 'reference' && !REF_RE.test(v.trim())) warn(fp, `${name}: "${v}" doesn't look like a reference (e.g. 1 Nephi 3:7)`);
          if (f.pattern === 'letters' && !/^[A-Za-z ]+$/.test(v)) err(fp, `${name}: the hidden word can only use letters A to Z`);
          if (f.kind === 'time' && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(v) && Number.isNaN(Date.parse(v))) err(fp, `${name}: "${v}" isn't a time (use 13:30 or a full date and time)`);
          break;
        case 'number':
          if (typeof v !== 'number' || !Number.isFinite(v)) err(fp, `${name}: ${f.label.toLowerCase()} must be a number`);
          else if ((f.min !== undefined && v < f.min) || (f.max !== undefined && v > f.max)) err(fp, `${name}: ${f.label.toLowerCase()} must be ${f.min} to ${f.max}`);
          break;
        case 'duration':
          if (!Number.isFinite(parseDuration(v))) err(fp, `${name}: "${v}" isn't a duration (try 8m or 45s)`);
          break;
        case 'offset':
          if (!Number.isFinite(parseOffset(v))) err(fp, `${name}: "${v}" isn't a position in the file (try 0:20 or 20s)`);
          break;
        case 'select':
          if (!(String(v) in f.options)) err(fp, `${name}: "${v}" isn't one of ${Object.keys(f.options).join(', ')}`);
          break;
        case 'choices': case 'items': {
          if (!Array.isArray(v)) { err(fp, `${name}: ${f.label.toLowerCase()} must be a list`); break; }
          const filled = v.filter(str);
          if (filled.length !== v.length) err(fp, `${name}: one of the ${f.label.toLowerCase()} is blank`);
          if (v.length < f.min || v.length > f.max) err(fp, `${name}: needs ${f.min} to ${f.max} ${f.label.toLowerCase()}`);
          const dupes = filled.filter((x, i) => filled.findIndex(y => y.trim().toLowerCase() === x.trim().toLowerCase()) !== i);
          if (dupes.length) err(fp, `${name}: "${dupes[0]}" is listed twice`);
          break;
        }
        case 'answer': {
          const list = t[f.of];
          if (!Number.isInteger(v)) err(fp, `${name}: pick the correct answer`);
          else if (Array.isArray(list) && (v < 0 || v >= list.length)) err(fp, `${name}: the correct answer points past the end of the list`);
          break;
        }
        case 'places': {
          if (!Array.isArray(v)) { err(fp, `${name}: ${f.label.toLowerCase()} must be a list of places`); break; }
          if (f.min && v.length < f.min) err(fp, `${name}: needs at least ${f.min} place${f.min > 1 ? 's' : ''}`);
          for (const k of v) if (!str(k) || !ID_RE.test(k)) err(fp, `${name}: place name "${k}" must be lowercase letters, numbers and dashes`);
          break;
        }
      }
    }
    if (Array.isArray(t.tags) && Array.isArray(t.decoys)) {
      const both = t.decoys.filter(k => t.tags.includes(k));
      if (both.length) err(`${path}.decoys`, `${name}: "${both[0]}" can't be both a fragment and a decoy`);
    }
    if (t.type === 'question' && t.replays !== undefined && !t.clip) warn(`${path}.replays`, `${name}: replays only apply when the question has a clip`);
    if (t.audio_hints === 0 && (t.hint_adds !== undefined || t.hint_audio !== undefined)) warn(`${path}.audio_hints`, `${name}: audio hints are off, so "each hint plays" isn't used`);
    if (t.type === 'scripted_darken' && t.restore === 'wait' && t.seconds === undefined) err(`${path}.seconds`, `${name}: "Wait it out" needs a number of seconds`);
    if (t.hints !== undefined) {
      if (!Array.isArray(t.hints) || t.hints.length > 3) err(`${path}.hints`, `${name}: up to 3 hints`);
      else if (t.hints.some(h => !str(h))) err(`${path}.hints`, `${name}: a hint is blank`);
    }
    if (t.hint_after !== undefined) {
      if (!Number.isFinite(parseDuration(t.hint_after))) err(`${path}.hint_after`, `${name}: hint wait "${t.hint_after}" isn't a duration (try 90 or 2m)`);
      else if (!hasHelp(t)) warn(`${path}.hint_after`, `${name}: has a hint wait but no hints or replays`);
    }
    checkBrief(t.brief, `${path}.brief`, name);
    checkTravel(t.travel, `${path}.travel`, name);
  }

  // Places: must be set up in Places, with a tag for anything that is tapped.
  if (ctx.places) {
    const seen = new Set();
    for (const ref of referencedPlaces(j)) {
      const p = ctx.places[ref.key];
      const id = `${ref.key}|${ref.role}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (!p) warn(ref.path, `Place "${ref.key}" isn't set up yet (Places tab)`);
      else if (ref.role === 'tag' && !(p.tags?.length)) warn(ref.path, `Place "${ref.key}" has no tag bound yet`);
    }
  }

  // Media: optional check against the files on disk.
  if (ctx.mediaFiles) {
    for (const m of referencedMedia(j)) if (!ctx.mediaFiles.has(m.file)) warn(m.path, `Media file "${m.file}" isn't in the media folder yet`);
  }

  // Routes: each team's Stage order must use real Stage IDs.
  if (j.routes !== undefined) {
    if (typeof j.routes !== 'object' || Array.isArray(j.routes)) err('routes', 'Routes must map a team to a list of Stage IDs');
    else for (const [team, order] of Object.entries(j.routes)) {
      if (!Array.isArray(order)) { err(`routes.${team}`, `Route for ${team} must be a list of Stage IDs`); continue; }
      for (const sid of order) if (!stageIds.has(sid)) err(`routes.${team}`, `Route for ${team} uses unknown Stage "${sid}"`);
      if (ctx.teams && !ctx.teams.includes(team)) warn(`routes.${team}`, `Route is for "${team}", which isn't a team name`);
    }
  }
  return issues;
}

/** What the balls load: durations in seconds, places resolved to tag IDs. */
export function compileJourney(j, ctx = {}) {
  const secs = (v) => (v === undefined ? undefined : parseDuration(v));
  const travel = (tr) => tr && { ...tr, mode: tr.mode || 'pointers', ...(tr.limit !== undefined ? { limit: secs(tr.limit) } : {}) };
  const keys = [...new Set(referencedPlaces(j).map(r => r.key))];
  const places = {};
  for (const k of keys) {
    const p = ctx.places?.[k];
    places[k] = { name: p?.name || k, tagOnly: !!p?.tagOnly, tags: p?.tags || [], lat: p?.lat ?? null, lon: p?.lon ?? null, radius_m: p?.radius_m ?? 20 };
  }
  const hintDefault = j.hint_after !== undefined ? secs(j.hint_after) : DEFAULT_HINT_AFTER;
  return {
    format: 1,
    id: j.id,
    title: j.title,
    compiledAt: new Date().toISOString(),
    penalties: {
      darken_s: (j.penalties?.darken_s || [30, 60, 120]).map(secs),
      unity_restore: j.penalties?.unity_restore ?? true
    },
    media: j.media || null,
    hint_after: hintDefault,
    places,
    stages: j.stages.map(st => ({
      ...st,
      gather: st.gather || 'roll_call',
      ...(st.limit !== undefined ? { limit: secs(st.limit) } : {}),
      ...(st.travel ? { travel: travel(st.travel) } : {}),
      tasks: st.tasks.map(t => ({
        ...t,
        ...(t.limit !== undefined ? { limit: secs(t.limit) } : {}),
        ...(t.travel ? { travel: travel(t.travel) } : {}),
        ...(hasHelp(t) ? { hint_after: t.hint_after !== undefined ? secs(t.hint_after) : hintDefault } : {}),
        ...(AUDIO_TASKS.has(t.type) ? {
          start: parseOffset(t.start ?? AUDIO_DEFAULTS.start),
          play_for: secs(t.play_for ?? AUDIO_DEFAULTS.play_for),
          audio_hints: t.audio_hints ?? AUDIO_DEFAULTS.audio_hints,
          hint_adds: secs(t.hint_adds ?? AUDIO_DEFAULTS.hint_adds),
          hint_audio: t.hint_audio ?? AUDIO_DEFAULTS.hint_audio,
          replays: t.replays ?? AUDIO_DEFAULTS.replays
        } : {}),
        ...(t.type === 'clip' || (t.type === 'question' && t.clip) ? { replays: t.replays ?? VIDEO_DEFAULTS.replays } : {}),
        ...(t.type === 'true_false' ? { answer: String(t.answer) === 'true' } : {})
      }))
    })),
    routes: j.routes || null
  };
}
