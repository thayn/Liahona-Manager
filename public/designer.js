// Journeys tab (designer) and Places tab.

import yaml from '/vendor/js-yaml.mjs';
import {
  TASK_TYPES, TASK_GROUPS, GATHER_MODES, TRAVEL_MODES, validateJourney, newJourney, newStage, newTask, slugify,
  parseDuration, parseOffset, formatDuration, DEFAULT_HINT_AFTER, AUDIO_DEFAULTS, hasHelp
} from '/shared/journey.js';

let H;  // helpers from app.js: { api, act, toast, esc, state, refresh, rerender }
const esc = (v) => H.esc(v);

export const D = {
  list: null,          // journey summaries
  open: null,          // { id (saved id), data (working copy), dirty, mediaFiles, file }
  sel: 'settings',     // 'settings' or stage index
  showYaml: false,
  showProblems: false,
  placeBind: null,     // place key the next scanned tag goes to
  placeResult: null
};

export function initDesigner(helpers) {
  H = helpers;
  // After a cloud upload, refresh the open Journey's list of media files.
  document.addEventListener('media-uploaded', async () => {
    if (!D.open) return;
    const r = await H.api('GET', `/api/journeys/${encodeURIComponent(D.open.id)}`);
    D.open.mediaFiles = r.mediaFiles;
    H.rerender();
  });
}

function mediaHelp(j) {
  const files = D.open.mediaFiles || [];
  const list = files.length ? ` ${files.length} file${files.length > 1 ? 's' : ''}: ${files.map(f => H.esc(f)).join(', ')}.` : ' No files yet.';
  if (H.mode?.() === 'cloud') {
    if (!j.media) return 'Name a folder for this Journey\'s audio, images and clips, save, then upload files here.';
    return `Upload audio, images and clips to the cloud.${list}
      <button type="button" class="small" id="media-upload-btn">Upload files…</button>
      <input type="file" id="media-upload" data-folder="${H.esc(j.media)}" multiple hidden accept=".mp4,.mp3,.wav,.m4a,.aac,.jpg,.jpeg,.png,.gif,.txt,.json">`;
  }
  return D.open.mediaFolder ? `Files go in ${H.esc(D.open.mediaFolder)}.${list}` : 'A folder name under Liahona Data\\media for this Journey\'s audio, images and clips.';
}

// ---------- path helpers ----------
const segs = (path) => path.split('.').map(s => (/^\d+$/.test(s) ? Number(s) : s));
function getAt(obj, path) { return segs(path).reduce((o, k) => (o == null ? undefined : o[k]), obj); }
function setAt(obj, path, value) {
  const k = segs(path); let o = obj;
  for (let i = 0; i < k.length - 1; i++) {
    if (o[k[i]] == null) o[k[i]] = typeof k[i + 1] === 'number' ? [] : {};
    o = o[k[i]];
  }
  if (value === undefined) { if (Array.isArray(o)) o.splice(k.at(-1), 1); else delete o[k.at(-1)]; }
  else o[k.at(-1)] = value;
}
const clone = (x) => JSON.parse(JSON.stringify(x));

// ---------- data ----------
export async function loadJourneyList() { D.list = await H.api('GET', '/api/journeys'); }

async function openJourney(id) {
  const r = await H.api('GET', `/api/journeys/${encodeURIComponent(id)}`);
  D.open = { id, data: r.journey, dirty: false, mediaFiles: r.mediaFiles, file: r.file, mediaFolder: r.mediaFolder };
  D.sel = 'settings'; D.showYaml = false; D.showProblems = false;
  H.rerender();
}

function ctx() {
  const S = H.state();
  const places = Object.fromEntries(S.places.map(p => [p.key, { name: p.name, tagOnly: p.tagOnly, tags: p.tags }]));
  return { places, teams: S.teams.map(t => t.name), mediaFiles: new Set(D.open?.mediaFiles || []) };
}
const issues = () => (D.open ? validateJourney(D.open.data, ctx()) : []);

function markDirty() { D.open.dirty = true; updateLive(); }

async function save() {
  if (!D.open) return;
  try {
    const r = await H.api('PUT', `/api/journeys/${encodeURIComponent(D.open.id)}`, { journey: D.open.data });
    D.open.id = r.journey.id; D.open.data = r.journey; D.open.dirty = false; D.open.file = r.file; D.open.mediaFiles = r.mediaFiles;
    await loadJourneyList();
    H.toast(r.errors ? `Saved, with ${r.errors} error${r.errors > 1 ? 's' : ''} to fix` : 'Saved');
    H.rerender();
  } catch (e) { H.toast(e.message, true); }
}

function leaveEditor() {
  if (D.open?.dirty && !confirm('Leave without saving your changes?')) return;
  D.open = null;
  loadJourneyList().then(H.rerender);
}

window.addEventListener('beforeunload', (e) => { if (D.open?.dirty) { e.preventDefault(); e.returnValue = ''; } });

// ---------- Journeys tab ----------
export function renderJourneys(el) {
  if (!D.list) { el.innerHTML = '<p class="hint">Loading…</p>'; loadJourneyList().then(H.rerender).catch(e => H.toast(e.message, true)); return; }
  if (D.open) return renderEditor(el);
  const S = H.state();
  const hasTrial = D.list.some(j => j.id === 'leader-trial');
  el.innerHTML = `
    <div class="panel row">
      <input id="new-journey-title" class="grow" placeholder="Title for a new Journey" autocomplete="off">
      <button class="primary" data-act="new-journey">New Journey</button>
      <label class="button-like">Import YAML<input type="file" id="journey-file" accept=".yaml,.yml,text/yaml" hidden></label>
      ${hasTrial ? '' : '<button data-act="load-sample">Load the Leader Trial</button>'}
    </div>
    <div class="journey-list">
      ${D.list.map(j => `
        <div class="panel journey-card">
          <div class="row" style="justify-content:space-between;align-items:flex-start">
            <div>
              <h3><a href="#" data-act="open-journey" data-id="${esc(j.id)}">${esc(j.title)}</a></h3>
              <div class="hint mono">${esc(j.id)}.yaml · ${j.stages} stage${j.stages === 1 ? '' : 's'}</div>
              ${j.description ? `<p class="hint">${esc(j.description)}</p>` : ''}
              ${j.broken ? `<p class="bad-text">${esc(j.broken)}</p>` : ''}
            </div>
            <div class="badges">${badge(j.errors, 'error')}${badge(j.warnings, 'warning')}${!j.errors && !j.warnings ? '<span class="badge ok">Ready</span>' : ''}</div>
          </div>
          <div class="row" style="margin-top:10px">
            <button class="small primary" data-act="open-journey" data-id="${esc(j.id)}">Open</button>
            <button class="small" data-act="dup-journey" data-id="${esc(j.id)}">Duplicate</button>
            <a class="button-like small" href="/api/journeys/${encodeURIComponent(j.id)}/download.yaml">Download YAML</a>
            ${j.errors ? '' : `<a class="button-like small" href="/api/journeys/${encodeURIComponent(j.id)}/ball.json">Ball file</a>`}
            <button class="small danger" data-act="del-journey" data-id="${esc(j.id)}">Delete</button>
          </div>
        </div>`).join('') || '<p class="hint">No Journeys yet. Make a new one, import a YAML file, or load the Leader Trial to start from.</p>'}
    </div>
    <p class="hint">Journey files are saved in <span class="mono">${esc(S.journeysDir)}</span>. Media goes in <span class="mono">${esc(S.mediaDir)}\\&lt;journey media folder&gt;</span>.</p>`;
}

const badge = (n, kind) => (n ? `<span class="badge ${kind}">${n} ${kind}${n > 1 ? 's' : ''}</span>` : '');

function renderEditor(el) {
  const j = D.open.data;
  const iss = issues();
  const errs = iss.filter(i => i.level === 'error').length, warns = iss.length - errs;
  const stages = Array.isArray(j.stages) ? j.stages : [];
  el.innerHTML = `
    <div class="editor-bar">
      <button class="small" data-act="back">← All Journeys</button>
      <strong class="editor-title" id="ed-title">${esc(j.title || 'Untitled')}</strong>
      <span id="ed-status" class="hint">${D.open.dirty ? 'Unsaved changes' : 'Saved'}</span>
      <span class="spacer"></span>
      <button class="small" data-act="toggle-problems" id="ed-problems">${problemLabel(errs, warns)}</button>
      <button class="small" data-act="toggle-yaml">${D.showYaml ? 'Form view' : 'YAML view'}</button>
      <button class="primary" data-act="save" id="ed-save" ${D.open.dirty ? '' : 'disabled'}>Save</button>
    </div>
    <div class="problems ${D.showProblems ? 'show' : ''}" id="problems">${problemsHtml(iss)}</div>
    ${D.showYaml ? yamlView(j) : `
    <div class="editor">
      <nav class="outline">
        <a href="#" class="${D.sel === 'settings' ? 'cur' : ''}" data-act="sel" data-sel="settings">Journey settings</a>
        <div class="outline-head">Stages</div>
        <ol>${stages.map((s, i) => `<li class="${D.sel === i ? 'cur' : ''}">
          <a href="#" data-act="sel" data-sel="${i}"><span class="dotflag" data-flag="stages.${i}"></span><span data-outline-name="${i}">${esc(s?.name || `Stage ${i + 1}`)}</span>
          <span class="hint"> · ${(s?.tasks || []).length}</span></a></li>`).join('')}</ol>
        <button class="small" data-act="add-stage">+ Add Stage</button>
      </nav>
      <section class="pane">${D.sel === 'settings' ? settingsPane(j) : stagePane(j, D.sel)}</section>
    </div>`}`;
  markIssues(iss);
}

const problemLabel = (e, w) => (e || w ? `${e ? `⛔ ${e}` : ''}${e && w ? ' · ' : ''}${w ? `⚠ ${w}` : ''}` : '✓ No problems');

function problemsHtml(iss) {
  if (!iss.length) return '<p class="hint">No problems found.</p>';
  return `<ul>${iss.map(i => `<li class="${i.level}"><a href="#" data-act="goto" data-goto="${esc(i.path)}">${i.level === 'error' ? '⛔' : '⚠'} ${esc(i.message)}</a></li>`).join('')}</ul>
    <p class="hint">Errors stop a Journey from going to the balls. Warnings are things to finish before the run (places, tags, media).</p>`;
}

function yamlView(j) {
  return `<div class="panel">
    <p class="hint">The Journey as it will be saved. You can edit here and press Apply. Comments (# lines) aren't kept once you save from the designer.</p>
    <textarea id="yaml-text" class="yaml" spellcheck="false">${esc(yaml.dump(j, { lineWidth: 100, noRefs: true }))}</textarea>
    <div class="row" style="margin-top:8px"><button class="primary" data-act="apply-yaml">Apply</button><span class="hint" id="yaml-msg"></span></div>
  </div>`;
}

// ---------- form pieces ----------
const opt = (map, cur, blank) => (blank ? `<option value="">${esc(blank)}</option>` : '') +
  Object.entries(map).map(([k, v]) => `<option value="${esc(k)}"${String(cur) === k ? ' selected' : ''}>${esc(v)}</option>`).join('');

function field(label, control, path, help) {
  return `<label class="field" data-field-path="${esc(path)}"><span class="flabel">${esc(label)}</span>${control}
    ${help ? `<span class="hint">${esc(help)}</span>` : ''}<span class="fmsg" data-msg="${esc(path)}"></span></label>`;
}
const input = (path, v, attrs = '') => `<input data-path="${esc(path)}" value="${esc(v ?? '')}" ${attrs} autocomplete="off">`;

function settingsPane(j) {
  const d = j.penalties?.darken_s || [];
  return `<h2>Journey settings</h2>
    <div class="grid2">
      ${field('Title', input('title', j.title, 'data-kind="title"'), 'title')}
      ${field('Journey ID', input('id', j.id, 'class="mono"'), 'id', 'Also the file name. Lowercase letters, numbers and dashes.')}
    </div>
    ${field('Description', `<textarea data-path="description" rows="2">${esc(j.description || '')}</textarea>`, 'description')}
    ${field('Media folder', input('media', j.media, 'placeholder="leader-trial"'), 'media')}
    <div class="hint media-help">${mediaHelp(j)}</div>
    <h3>Darkened</h3>
    <div class="row">${[0, 1, 2].map(i => field(['1st mistake', '2nd', '3rd and later'][i], input(`penalties.darken_s.${i}`, d[i], 'data-kind="duration" placeholder="30" size="6"'), `penalties.darken_s.${i}`)).join('')}</div>
    <label class="check"><input type="checkbox" data-path="penalties.unity_restore" data-kind="bool" ${j.penalties?.unity_restore !== false ? 'checked' : ''}> Everyone tapping their medallion ends Darkened early (unity)</label>
    <h3>Hints</h3>
    ${field('Offer hints after', input('hint_after', j.hint_after, `data-kind="duration" placeholder="${formatDuration(DEFAULT_HINT_AFTER)}" size="8"`), 'hint_after',
      'How long a team works on a Task before the hint and replay buttons fade in. Each Task can change this. Using a hint or a replay restarts the wait.')}
    <p class="hint">File: <span class="mono">${esc(D.open.file || '')}</span></p>`;
}

function stagePane(j, i) {
  const st = j.stages[i];
  if (!st) { D.sel = 'settings'; return settingsPane(j); }
  const p = `stages.${i}`;
  const n = j.stages.length;
  return `<div class="row" style="justify-content:space-between">
      <h2>Stage ${i + 1}</h2>
      <div class="row">
        <button class="small" data-act="move-stage" data-i="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="small" data-act="move-stage" data-i="${i}" data-dir="1" ${i === n - 1 ? 'disabled' : ''}>↓</button>
        <button class="small" data-act="dup-stage" data-i="${i}">Duplicate</button>
        <button class="small danger" data-act="del-stage" data-i="${i}">Delete</button>
      </div>
    </div>
    <div class="grid2">
      ${field('Name', input(`${p}.name`, st.name, `data-kind="stage-name" data-i="${i}"`), `${p}.name`)}
      ${field('Stage ID', input(`${p}.id`, st.id, 'class="mono"'), `${p}.id`, 'Follows the name until you change it.')}
      ${field('Gathering', `<select data-path="${p}.gather">${opt(GATHER_MODES, st.gather || 'roll_call')}</select>`, `${p}.gather`)}
      ${field('Time limit for the whole Stage', input(`${p}.limit`, st.limit, 'data-kind="duration" placeholder="none"'), `${p}.limit`)}
    </div>
    ${briefBlock(st.brief, `${p}.brief`, 'Brief (shown when the Stage starts)')}
    ${travelBlock(st.travel, `${p}.travel`, 'Travel (before the first Task)')}
    <h3 style="margin-top:18px">Tasks</h3>
    ${(st.tasks || []).map((t, ti) => taskCard(t, `${p}.tasks.${ti}`, ti, st.tasks.length)).join('')}
    <div class="row add-task">
      <select id="new-task-type">${TASK_GROUPS.map(g => `<optgroup label="${esc(g)}">${Object.entries(TASK_TYPES).filter(([, d]) => d.group === g)
        .map(([k, d]) => `<option value="${k}">${esc(d.label)}</option>`).join('')}</optgroup>`).join('')}</select>
      <button data-act="add-task" data-i="${i}">+ Add Task</button>
    </div>`;
}

function briefBlock(b, path, title) {
  if (!b) return `<button class="small ghost" data-act="obj-add" data-path="${esc(path)}" data-init="brief">+ ${esc(title)}</button>`;
  return `<fieldset class="sub"><legend>${esc(title)} <button class="small danger" data-act="obj-del" data-path="${esc(path)}">Remove</button></legend>
    <div class="grid2">
      ${field('Scripture reference', input(`${path}.ref`, b.ref, 'placeholder="1 Nephi 16:10"'), `${path}.ref`)}
      ${field('Image', mediaInput(`${path}.image`, b.image), `${path}.image`)}
      ${field('Audio', mediaInput(`${path}.audio`, b.audio), `${path}.audio`)}
      ${field('Clip', mediaInput(`${path}.clip`, b.clip), `${path}.clip`)}
    </div>
    ${field('Text', `<textarea data-path="${esc(path)}.text" rows="3">${esc(b.text || '')}</textarea>`, `${path}.text`)}
  </fieldset>`;
}

function travelBlock(tr, path, title) {
  if (!tr) return `<button class="small ghost" data-act="obj-add" data-path="${esc(path)}" data-init="travel">+ ${esc(title)}</button>`;
  const mode = tr.mode || 'pointers';
  return `<fieldset class="sub"><legend>${esc(title)} <button class="small danger" data-act="obj-del" data-path="${esc(path)}">Remove</button></legend>
    <div class="grid2">
      ${field('Go to place', input(`${path}.to`, tr.to, 'list="place-keys" class="mono" placeholder="lot-corner"'), `${path}.to`)}
      ${field('How', `<select data-path="${esc(path)}.mode">${opt(TRAVEL_MODES, mode)}</select>`, `${path}.mode`)}
      ${mode === 'path' ? field('Path name', input(`${path}.path`, tr.path, 'class="mono" placeholder="sidewalk-loop"'), `${path}.path`, 'Recorded later in the route builder.') : ''}
      ${mode === 'race' || tr.limit !== undefined ? field('Time limit', input(`${path}.limit`, tr.limit, 'data-kind="duration" placeholder="8m"'), `${path}.limit`) : ''}
    </div>
  </fieldset>${placeDatalist()}`;
}

function placeDatalist() {
  return `<datalist id="place-keys">${H.state().places.map(p => `<option value="${esc(p.key)}">${esc(p.name)}</option>`).join('')}</datalist>`;
}
function mediaInput(path, v) {
  return `${input(path, v, 'list="media-files" placeholder="file name"')}<datalist id="media-files">${(D.open.mediaFiles || []).map(f => `<option value="${esc(f)}">`).join('')}</datalist>`;
}

function taskCard(t, p, ti, n) {
  const def = TASK_TYPES[t?.type];
  const head = `<div class="task-head">
      <strong>Task ${ti + 1} · ${esc(def?.label || t?.type || 'Unknown')}</strong><span class="dotflag" data-flag="${esc(p)}"></span>
      <span class="spacer"></span>
      <button class="small" data-act="move-task" data-path="${esc(p)}" data-dir="-1" ${ti === 0 ? 'disabled' : ''}>↑</button>
      <button class="small" data-act="move-task" data-path="${esc(p)}" data-dir="1" ${ti === n - 1 ? 'disabled' : ''}>↓</button>
      <button class="small" data-act="dup-task" data-path="${esc(p)}">Duplicate</button>
      <button class="small danger" data-act="del-task" data-path="${esc(p)}">✕</button>
    </div>`;
  if (!def) return `<div class="task">${head}<p class="bad-text">Unknown Task type "${esc(t?.type)}". Fix it in the YAML view.</p></div>`;
  return `<div class="task" data-task="${esc(p)}">${head}
    ${def.help ? `<p class="hint">${esc(def.help)}</p>` : ''}
    <div class="grid2">${def.fields.filter(f => !f.section).map(f => taskField(t, f, p)).join('')}</div>
    ${sectionsHtml(t, def, p)}
    ${listField('Hints', t.hints || [], `${p}.hints`, { max: 3, placeholder: 'A nudge, not the answer' })}
    ${hasHelp(t) || t.hint_after !== undefined ? `<div class="hint-wait">${field('Offer hints and replays after', input(`${p}.hint_after`, t.hint_after,
      `data-kind="duration" placeholder="${esc(defaultHintLabel())}" size="8"`), `${p}.hint_after`, 'Blank uses the Journey default.')}</div>` : ''}
    <div class="row">${t.brief ? '' : briefBlock(null, `${p}.brief`, 'Brief before this Task')}${t.travel ? '' : travelBlock(null, `${p}.travel`, 'Travel before this Task')}</div>
    ${t.brief ? briefBlock(t.brief, `${p}.brief`, 'Brief before this Task') : ''}
    ${t.travel ? travelBlock(t.travel, `${p}.travel`, 'Travel before this Task') : ''}
  </div>`;
}

function sectionsHtml(t, def, p) {
  if (t.type === 'question' && !t.clip) return '';
  const names = [...new Set(def.fields.filter(f => f.section).map(f => f.section))];
  return names.map(n => {
    let fields = def.fields.filter(f => f.section === n);
    if (t.audio_hints === 0) fields = fields.filter(f => !['hint_adds', 'hint_audio'].includes(f.key));
    return `<fieldset class="sub"><legend>${esc(n)}</legend><div class="grid3">${fields.map(f => taskField(t, f, p)).join('')}</div>
      ${n === 'Playback' && fields.some(f => f.key === 'play_for') ? `<p class="hint" data-play-summary="${esc(p)}">${esc(playSummary(t))}</p>` : ''}</fieldset>`;
  }).join('');
}

function playSummary(t) {
  const d = AUDIO_DEFAULTS;
  const start = parseOffset(t.start ?? d.start), first = parseDuration(t.play_for ?? d.play_for);
  const n = t.audio_hints ?? d.audio_hints, more = parseDuration(t.hint_adds ?? d.hint_adds);
  if (![start, first, more].every(Number.isFinite)) return '';
  const clock = (x) => `${Math.floor(x / 60)}:${String(Math.round(x % 60)).padStart(2, '0')}`;
  let line = `Plays ${clock(start)}–${clock(start + first)}`;
  if (n > 0) {
    const restart = (t.hint_audio ?? d.hint_audio) === 'restart';
    line += restart ? `; each hint starts over and plays ${more}s longer (up to ${clock(start)}–${clock(start + first + n * more)})`
      : `; each hint plays the next ${more}s (up to ${clock(start + first + n * more)})`;
  }
  const r = t.replays ?? d.replays;
  return `${line}. ${r ? `${r} replay${r > 1 ? 's' : ''} allowed.` : 'No replays.'} Hints and replays appear after the hint wait.`;
}

function taskField(t, f, p) {
  const path = `${p}.${f.key}`;
  const v = t[f.key];
  const label = f.label + (f.required ? '' : ' (optional)');
  const ph = f.placeholder ? `placeholder="${esc(f.placeholder)}"` : '';
  switch (f.kind) {
    case 'text': return field(label, input(path, v, ph), path);
    case 'time': return field(label, input(path, v, ph), path);
    case 'longtext': return `<div class="span2">${field(label, `<textarea data-path="${esc(path)}" rows="3" ${ph}>${esc(v || '')}</textarea>`, path)}</div>`;
    case 'number': return field(label, input(path, v, `type="number" data-kind="number" min="${f.min ?? ''}" max="${f.max ?? ''}" ${ph}`), path, f.help);
    case 'duration': return field(label, input(path, v, `data-kind="duration" ${ph}`), path, f.help);
    case 'offset': return field(label, input(path, v, `data-kind="offset" ${ph}`), path, f.help);
    case 'media': return field(label, mediaInput(path, v), path);
    case 'select': return field(label, `<select data-path="${esc(path)}">${opt(f.options, v, f.required ? null : f.section ? 'Default (continue)' : '—')}</select>`, path, f.help);
    case 'choices': return `<div class="span2">${listField(label, v || [], path, { max: f.max, min: f.min, numbered: true })}</div>`;
    case 'items': return `<div class="span2">${listField(label, v || [], path, { max: f.max, min: f.min, numbered: true, reorder: true })}</div>`;
    case 'answer': {
      const list = t[f.of] || [];
      return `<div class="span2"><div class="field" data-field-path="${esc(path)}"><span class="flabel">${esc(label)}</span>
        <div class="radios">${list.map((c, i) => `<label class="radio"><input type="radio" name="${esc(path)}" data-path="${esc(path)}" data-kind="index" value="${i}" ${v === i ? 'checked' : ''}> ${esc(c || `(answer ${i + 1})`)}</label>`).join('') || '<span class="hint">Add answers first.</span>'}</div>
        <span class="fmsg" data-msg="${esc(path)}"></span></div></div>`;
    }
    case 'places': return `<div class="span2">${placesField(label, v || [], path)}</div>`;
    default: return '';
  }
}

function defaultHintLabel() {
  const v = D.open?.data?.hint_after;
  const secs = v !== undefined ? parseDuration(v) : DEFAULT_HINT_AFTER;
  return Number.isFinite(secs) ? `${formatDuration(secs)} (default)` : 'default';
}

function listField(label, list, path, { max = 6, numbered = false, reorder = false, placeholder = '' } = {}) {
  return `<div class="field" data-field-path="${esc(path)}"><span class="flabel">${esc(label)}</span>
    ${list.map((v, i) => `<div class="list-row">${numbered ? `<span class="num">${i + 1}</span>` : ''}
      ${input(`${path}.${i}`, v, `placeholder="${esc(placeholder)}"`)}
      ${reorder ? `<button class="small" data-act="list-move" data-path="${esc(path)}" data-i="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''}>↑</button>` : ''}
      <button class="small danger" data-act="list-del" data-path="${esc(path)}" data-i="${i}" title="Remove">✕</button></div>`).join('')}
    ${list.length < max ? `<button class="small ghost" data-act="list-add" data-path="${esc(path)}">+ Add</button>` : ''}
    <span class="fmsg" data-msg="${esc(path)}"></span></div>`;
}

function placesField(label, list, path) {
  const S = H.state();
  return `<div class="field" data-field-path="${esc(path)}"><span class="flabel">${esc(label)}</span>
    <div class="chips">${list.map((k, i) => {
      const pl = S.places.find(p => p.key === k);
      const state = !pl ? 'missing' : pl.tags.length ? 'ok' : 'notag';
      return `<span class="pchip ${state}" title="${state === 'missing' ? 'Not set up in Places' : state === 'notag' ? 'No tag bound yet' : `${pl.tags.length} tag(s)`}">${esc(k)}
        <button class="x" data-act="list-del" data-path="${esc(path)}" data-i="${i}">✕</button></span>`;
    }).join('')}
      <input class="mono place-add" data-place-add="${esc(path)}" list="place-keys" placeholder="add a place…" size="14" autocomplete="off">
    </div>${placeDatalist()}
    <span class="hint">Type a place name and press Enter. New names can be set up on the Places tab.</span>
    <span class="fmsg" data-msg="${esc(path)}"></span></div>`;
}

// ---------- live updates without a full redraw (keeps typing smooth) ----------
function markIssues(iss) {
  document.querySelectorAll('.has-error, .has-warning').forEach(e => e.classList.remove('has-error', 'has-warning'));
  document.querySelectorAll('[data-msg]').forEach(e => { e.textContent = ''; });
  document.querySelectorAll('.dotflag').forEach(e => { e.className = 'dotflag'; });
  for (const i of iss) {
    const msg = document.querySelector(`[data-msg="${CSS.escape(i.path)}"]`);
    const fld = document.querySelector(`[data-field-path="${CSS.escape(i.path)}"]`);
    if (fld) fld.classList.add(i.level === 'error' ? 'has-error' : fld.classList.contains('has-error') ? 'has-error' : 'has-warning');
    if (msg && !msg.textContent) msg.textContent = i.message.replace(/^Stage \d+( \([^)]*\))?(, Task \d+ \([^)]*\))?: /, '');
    const m = i.path.match(/^stages\.(\d+)(?:\.tasks\.(\d+))?/);
    if (m) {
      for (const key of [`stages.${m[1]}`, m[2] !== undefined ? `stages.${m[1]}.tasks.${m[2]}` : null].filter(Boolean)) {
        document.querySelectorAll(`[data-flag="${key}"]`).forEach(f => { if (!f.classList.contains('error')) f.classList.add(i.level); });
      }
    }
  }
}

function updateLive() {
  const iss = issues();
  const errs = iss.filter(i => i.level === 'error').length;
  const b = document.getElementById('ed-problems'); if (b) b.textContent = problemLabel(errs, iss.length - errs);
  const pr = document.getElementById('problems'); if (pr) pr.innerHTML = problemsHtml(iss);
  const st = document.getElementById('ed-status'); if (st) st.textContent = D.open.dirty ? 'Unsaved changes' : 'Saved';
  const sv = document.getElementById('ed-save'); if (sv) sv.disabled = !D.open.dirty;
  const tt = document.getElementById('ed-title'); if (tt) tt.textContent = D.open.data.title || 'Untitled';
  markIssues(iss);
}

function valueFrom(el) {
  const kind = el.dataset.kind;
  if (kind === 'bool') return el.checked;
  if (kind === 'index') return Number(el.value);
  const v = el.value;
  if (kind === 'number') return v === '' ? undefined : Number(v);
  if (kind === 'duration' || kind === 'offset') return v.trim() === '' ? undefined : (/^\d+$/.test(v.trim()) ? Number(v.trim()) : v.trim());
  return v === '' && !/\.\d+$/.test(el.dataset.path) ? undefined : v;
}

function redrawKeepingFocus() {
  const a = document.activeElement;
  const path = a?.dataset?.path, pos = a?.selectionStart;
  const y = window.scrollY;
  H.rerender();
  window.scrollTo(0, y);
  if (path) {
    const el = document.querySelector(`[data-path="${CSS.escape(path)}"]`);
    if (el) { el.focus(); try { if (pos != null) el.setSelectionRange(pos, pos); } catch { /* not a text box */ } }
  }
}

// ---------- events (called from app.js) ----------
export function designerInput(el) {
  if (!D.open || !el.dataset.path) return false;
  const path = el.dataset.path;
  const j = D.open.data;
  if (el.dataset.kind === 'stage-name') {
    const i = Number(el.dataset.i);
    const st = j.stages[i];
    const autoId = !st.id || st.id === slugify(st.name) || /^stage-\d+$/.test(st.id);
    st.name = el.value;
    if (autoId && slugify(el.value)) {
      st.id = slugify(el.value);
      const idBox = document.querySelector(`[data-path="stages.${i}.id"]`); if (idBox) idBox.value = st.id;
    }
    const o = document.querySelector(`[data-outline-name="${i}"]`); if (o) o.textContent = el.value || `Stage ${i + 1}`;
  } else if (path.startsWith('penalties.darken_s.')) {
    const list = [0, 1, 2].map(k => valueFrom(document.querySelector(`[data-path="penalties.darken_s.${k}"]`)));
    j.penalties = { ...(j.penalties || {}), darken_s: list.filter(v => v !== undefined) };
  } else {
    setAt(j, path, valueFrom(el));
  }
  const task = path.match(/^(stages\.\d+\.tasks\.\d+)\./)?.[1];
  const sum = task && document.querySelector(`[data-play-summary="${CSS.escape(task)}"]`);
  if (sum) sum.textContent = playSummary(getAt(j, task));
  markDirty();
  return true;
}

export function designerChange(el) {
  if (!D.open || !el.dataset.path) return false;
  designerInput(el);
  // Selects and list text change what other parts show, so redraw.
  if (el.tagName === 'SELECT' || /\.(choices|items)\.\d+$/.test(el.dataset.path) || /\.(audio_hints|clip|replays)$/.test(el.dataset.path)) redrawKeepingFocus();
  return true;
}

export function designerKeydown(ev) {
  if (ev.key === 's' && (ev.ctrlKey || ev.metaKey) && D.open) { ev.preventDefault(); save(); return true; }
  const el = ev.target;
  if (ev.key === 'Enter' && el.dataset.placeAdd) {
    ev.preventDefault();
    const key = slugify(el.value);
    if (!key) return true;
    const list = getAt(D.open.data, el.dataset.placeAdd) || [];
    if (!list.includes(key)) { list.push(key); setAt(D.open.data, el.dataset.placeAdd, list); markDirty(); }
    redrawKeepingFocus();
    document.querySelector(`[data-place-add="${CSS.escape(el.dataset.placeAdd)}"]`)?.focus();
    return true;
  }
  if (ev.key === 'Enter' && el.id === 'new-journey-title') { ev.preventDefault(); newJourneyFromBox(); return true; }
  if (ev.key === 'Enter' && el.id === 'place-scan') { ev.preventDefault(); const raw = el.value; el.value = ''; if (raw.trim()) bindPlaceScan(raw); return true; }
  return false;
}

async function newJourneyFromBox() {
  const title = document.getElementById('new-journey-title')?.value.trim() || 'New Journey';
  try { const r = await H.api('POST', '/api/journeys', { title }); await loadJourneyList(); await openJourney(r.journey.id); }
  catch (e) { H.toast(e.message, true); }
}

export async function designerFile(el) {
  if (el.id !== 'journey-file' || !el.files[0]) return false;
  const text = await el.files[0].text();
  el.value = '';
  try {
    const r = await H.api('POST', '/api/journeys/import', { yaml: text });
    await loadJourneyList();
    H.toast(`Imported "${r.journey.title}"${r.errors ? `, ${r.errors} error(s) to fix` : ''}`);
    H.rerender();
  } catch (e) { H.toast(e.message, true); }
  return true;
}

function move(list, i, dir) {
  const k = i + dir;
  if (k < 0 || k >= list.length) return;
  [list[i], list[k]] = [list[k], list[i]];
}

export async function designerClick(t, ev) {
  const act = t.dataset.act;
  if (!act) return false;
  ev.preventDefault();
  const j = D.open?.data;
  switch (act) {
    // list view
    case 'new-journey': await newJourneyFromBox(); break;
    case 'load-sample':
      try {
        const r = await H.api('POST', '/api/journeys/sample');
        await H.api('POST', '/api/places/from-journeys');
        await H.refresh(); await loadJourneyList();
        H.toast(`Loaded "${r.journey.title}" and added its places`);
        H.rerender();
      } catch (e) { H.toast(e.message, true); }
      break;
    case 'open-journey': await openJourney(t.dataset.id); break;
    case 'dup-journey':
      try { await H.api('POST', `/api/journeys/${encodeURIComponent(t.dataset.id)}/duplicate`); await loadJourneyList(); H.rerender(); H.toast('Duplicated'); }
      catch (e) { H.toast(e.message, true); }
      break;
    case 'del-journey':
      if (!confirm(`Delete the Journey "${t.dataset.id}"? A copy is kept in the backups folder.`)) break;
      try { await H.api('DELETE', `/api/journeys/${encodeURIComponent(t.dataset.id)}`); await loadJourneyList(); H.rerender(); H.toast('Deleted'); }
      catch (e) { H.toast(e.message, true); }
      break;

    // editor
    case 'back': leaveEditor(); break;
    case 'save': await save(); break;
    case 'toggle-yaml': D.showYaml = !D.showYaml; H.rerender(); break;
    case 'toggle-problems': D.showProblems = !D.showProblems; document.getElementById('problems')?.classList.toggle('show', D.showProblems); break;
    case 'apply-yaml': {
      try {
        const obj = yaml.load(document.getElementById('yaml-text').value);
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('expected id, title and stages at the top');
        D.open.data = obj; D.open.dirty = true; D.showYaml = false;
        H.rerender(); H.toast('Applied. Press Save to keep it.');
      } catch (e) {
        const m = document.getElementById('yaml-msg');
        if (m) m.textContent = `Can't read that YAML${e.mark ? ` (line ${e.mark.line + 1})` : ''}: ${e.reason || e.message}`;
      }
      break;
    }
    case 'sel': D.sel = t.dataset.sel === 'settings' ? 'settings' : Number(t.dataset.sel); H.rerender(); window.scrollTo(0, 0); break;
    case 'goto': {
      const path = t.dataset.goto;
      const m = path.match(/^stages\.(\d+)/);
      D.sel = m ? Number(m[1]) : 'settings';
      D.showYaml = false;
      H.rerender();
      const target = document.querySelector(`[data-field-path="${CSS.escape(path)}"]`) || document.querySelector(`[data-task="${CSS.escape(path.split('.').slice(0, 4).join('.'))}"]`);
      if (target) { target.scrollIntoView({ block: 'center' }); target.querySelector('input, select, textarea')?.focus(); }
      break;
    }
    case 'add-stage': {
      j.stages ||= [];
      const st = newStage(j.stages.length + 1);
      while (j.stages.some(s => s.id === st.id)) st.id += '-new';
      j.stages.push(st); D.sel = j.stages.length - 1; markDirty(); H.rerender(); break;
    }
    case 'move-stage': { const i = Number(t.dataset.i); move(j.stages, i, Number(t.dataset.dir)); D.sel = i + Number(t.dataset.dir); markDirty(); H.rerender(); break; }
    case 'dup-stage': {
      const i = Number(t.dataset.i); const c = clone(j.stages[i]);
      c.id = `${c.id}-copy`; c.name = `${c.name} (copy)`;
      j.stages.splice(i + 1, 0, c); D.sel = i + 1; markDirty(); H.rerender(); break;
    }
    case 'del-stage': {
      const i = Number(t.dataset.i);
      if (!confirm(`Delete Stage ${i + 1} "${j.stages[i].name}" and its Tasks?`)) break;
      j.stages.splice(i, 1); D.sel = j.stages.length ? Math.min(i, j.stages.length - 1) : 'settings'; markDirty(); H.rerender(); break;
    }
    case 'add-task': {
      const i = Number(t.dataset.i); const type = document.getElementById('new-task-type').value;
      (j.stages[i].tasks ||= []).push(newTask(type)); markDirty(); H.rerender();
      document.querySelectorAll('.task').item(j.stages[i].tasks.length - 1)?.scrollIntoView({ block: 'center' });
      break;
    }
    case 'move-task': case 'dup-task': case 'del-task': {
      const k = segs(t.dataset.path); const ti = k.at(-1); const list = getAt(j, k.slice(0, -1).join('.'));
      if (act === 'move-task') move(list, ti, Number(t.dataset.dir));
      if (act === 'dup-task') list.splice(ti + 1, 0, clone(list[ti]));
      if (act === 'del-task') { if (!confirm(`Delete Task ${ti + 1}?`)) break; list.splice(ti, 1); }
      markDirty(); redrawKeepingFocus(); break;
    }
    case 'list-add': {
      const list = getAt(j, t.dataset.path) || [];
      list.push(''); setAt(j, t.dataset.path, list); markDirty(); H.rerender();
      document.querySelector(`[data-path="${CSS.escape(`${t.dataset.path}.${list.length - 1}`)}"]`)?.focus();
      break;
    }
    case 'list-del': case 'list-move': {
      const path = t.dataset.path; const list = getAt(j, path); const i = Number(t.dataset.i);
      if (act === 'list-del') list.splice(i, 1); else move(list, i, Number(t.dataset.dir));
      if (!list.length && /\.(hints|decoys)$/.test(path)) setAt(j, path, undefined);
      // Keep a choice question's correct answer pointing at the same text.
      const ans = path.replace(/\.choices$/, '.answer');
      if (ans !== path && act === 'list-del') { const a = getAt(j, ans); if (Number.isInteger(a) && a >= i && a > 0) setAt(j, ans, a - (a === i ? 0 : 1)); }
      markDirty(); redrawKeepingFocus(); break;
    }
    case 'obj-add': setAt(j, t.dataset.path, t.dataset.init === 'travel' ? { to: '', mode: 'pointers' } : { ref: '' }); markDirty(); H.rerender(); break;
    case 'obj-del': setAt(j, t.dataset.path, undefined); markDirty(); redrawKeepingFocus(); break;

    // places tab
    case 'places-from-journeys':
      try { const r = await H.api('POST', '/api/places/from-journeys'); await H.refresh(); H.toast(r.created.length ? `Added ${r.created.length} places` : 'Every place used in a Journey is already here'); }
      catch (e) { H.toast(e.message, true); }
      break;
    case 'add-place': {
      const key = slugify(document.getElementById('place-key').value);
      const name = document.getElementById('place-name').value.trim();
      const tagOnly = document.getElementById('place-tagonly').checked;
      try { await H.api('POST', '/api/places', { key, name, tagOnly }); await H.refresh(); H.toast(`Added ${key}`); }
      catch (e) { H.toast(e.message, true); }
      break;
    }
    case 'del-place':
      if (!confirm(`Delete the place "${t.dataset.key}"?`)) break;
      try { await H.api('DELETE', `/api/places/${encodeURIComponent(t.dataset.key)}`); if (D.placeBind === t.dataset.key) D.placeBind = null; await H.refresh(); }
      catch (e) { H.toast(e.message, true); }
      break;
    case 'bind-place': D.placeBind = t.dataset.key; D.placeResult = null; H.rerender(); break;
    case 'next-untagged': D.placeBind = H.state().places.find(p => !p.tags.length)?.key || null; D.placeResult = null; H.rerender(); break;
    case 'del-tag':
      try { await H.api('DELETE', `/api/places/${encodeURIComponent(t.dataset.key)}/tags/${encodeURIComponent(t.dataset.uid)}`); await H.refresh(); }
      catch (e) { H.toast(e.message, true); }
      break;
    case 'force-place-tag':
      await bindPlaceScan(t.dataset.raw, true); break;
    default: return false;
  }
  return true;
}

// ---------- Places tab ----------
async function bindPlaceScan(raw, force = false) {
  const key = D.placeBind;
  if (!key) {
    try {
      const r = await H.api('POST', '/api/cards/lookup', { raw });
      D.placeResult = r.place ? { kind: 'good', html: `<strong class="mono">${esc(r.uid)}</strong> is the tag for <strong>${esc(r.place.name || r.place.key)}</strong>.` }
        : r.person ? { kind: 'bad', html: `That's ${esc(r.person.name)}'s member card.` }
        : { kind: 'bad', html: `<strong class="mono">${esc(r.uid)}</strong> isn't bound to anything.` };
    } catch (e) { D.placeResult = { kind: 'bad', html: esc(e.message) }; }
    return H.rerender();
  }
  try {
    const r = await H.api('POST', `/api/places/${encodeURIComponent(key)}/tags`, { raw, force });
    D.placeResult = { kind: 'good', html: `✓ <strong class="mono">${esc(r.uid)}</strong> → ${esc(r.place.name || r.place.key)}${r.unchanged ? ' (already bound)' : ''}${r.movedFrom ? ` (moved from ${esc(r.movedFrom)})` : ''}${r.warning ? `<br>${esc(r.warning)}` : ''}` };
    D.placeBind = H.state().places.find(p => !p.tags.length && p.key !== key)?.key || null;
    await H.refresh();
  } catch (e) {
    D.placeResult = { kind: 'bad', html: `${esc(e.message)}${e.data?.otherPlace ? ` <button class="small" data-act="force-place-tag" data-raw="${esc(raw)}">Move it to ${esc(key)}</button>` : ''}` };
    H.rerender();
  }
}

export function renderPlaces(el) {
  const S = H.state();
  const usage = S.placeUsage || {};
  const missing = Object.keys(usage).filter(k => !S.places.some(p => p.key === k));
  const untagged = S.places.filter(p => !p.tags.length).length;
  const cur = D.placeBind ? S.places.find(p => p.key === D.placeBind) : null;
  const r = D.placeResult;
  el.innerHTML = `
    <div class="two">
      <div class="panel">
        <h3>Bind tags</h3>
        ${cur ? `<div class="next-up">Tap the tag for: ${esc(cur.name || cur.key)} <span class="team mono">${esc(cur.key)}</span></div>`
          : `<p class="hint">${untagged ? `${untagged} place${untagged > 1 ? 's have' : ' has'} no tag yet.` : 'Every place has a tag.'} Pick a place below, or scan a tag to see what it belongs to.</p>`}
        <input id="place-scan" class="scan-box mono" placeholder="${cur ? 'Tap the tag on the reader' : 'Tap a tag to look it up'}" autocomplete="off" autocapitalize="off" spellcheck="false">
        <div class="row" style="margin-top:8px">
          ${untagged ? '<button class="small" data-act="next-untagged">Go through places with no tag</button>' : ''}
          ${cur ? '<button class="small" data-act="bind-place" data-key="">Stop</button>' : ''}
        </div>
        <div class="result ${r ? `show ${r.kind}` : ''}">${r ? r.html : ''}</div>
      </div>
      <div class="panel">
        <h3>Add a place</h3>
        <div class="row">
          <input id="place-key" class="mono" placeholder="lot-corner" size="14" autocomplete="off">
          <input id="place-name" class="grow" placeholder="Name, e.g. Parking lot corner" autocomplete="off">
          <label class="check"><input type="checkbox" id="place-tagonly"> Tag-only (indoors)</label>
          <button class="primary" data-act="add-place">Add</button>
        </div>
        ${missing.length ? `<p class="hint">${missing.length} place${missing.length > 1 ? 's are' : ' is'} used in Journeys but not set up: <span class="mono">${missing.map(esc).join(', ')}</span></p>
          <button data-act="places-from-journeys">Add them</button>` : '<p class="hint">Every place used in a Journey is set up.</p>'}
        <p class="hint">GPS positions come later, with the route builder. Tag-only places skip GPS and use written directions.</p>
      </div>
    </div>
    <div class="panel">
      <table>
        <thead><tr><th>Place</th><th>Name</th><th>Tag-only</th><th>Tags</th><th>Used in</th><th>Notes</th><th></th></tr></thead>
        <tbody>${S.places.map(p => `<tr data-place="${esc(p.key)}" class="${D.placeBind === p.key ? 'cur-row' : ''}">
          <td class="mono">${esc(p.key)}</td>
          <td><input data-place-field="name" value="${esc(p.name)}"></td>
          <td><input type="checkbox" data-place-field="tagOnly" ${p.tagOnly ? 'checked' : ''}></td>
          <td>${p.tags.map(u => `<span class="pchip ok mono">${esc(u)}<button class="x" data-act="del-tag" data-key="${esc(p.key)}" data-uid="${esc(u)}" title="Remove tag">✕</button></span>`).join('')}
              <button class="small" data-act="bind-place" data-key="${esc(p.key)}">${p.tags.length ? '+ Tag' : 'Bind tag'}</button></td>
          <td class="hint">${esc((usage[p.key] || []).join(', ') || 'not used')}</td>
          <td><input data-place-field="notes" value="${esc(p.notes)}" placeholder="where exactly"></td>
          <td><button class="small danger" data-act="del-place" data-key="${esc(p.key)}">✕</button></td>
        </tr>`).join('')}</tbody>
      </table>
      ${S.places.length ? '' : '<p class="hint">No places yet.</p>'}
    </div>`;
  setTimeout(() => document.getElementById('place-scan')?.focus(), 0);
}

export function placesChange(el) {
  const row = el.closest('tr[data-place]');
  if (!row || !el.dataset.placeField) return false;
  const f = el.dataset.placeField;
  H.act(() => H.api('PATCH', `/api/places/${encodeURIComponent(row.dataset.place)}`, { [f]: f === 'tagOnly' ? el.checked : el.value }));
  return true;
}
