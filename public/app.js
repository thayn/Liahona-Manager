// Liahona Manager front end: plain JS, no build step.

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let S = null;                 // server state
const ui = {
  tab: 'people',
  peopleFilter: '',
  selected: new Set(),        // person ids selected on the team board
  bindTeam: '',               // team id in the bind queue ('' = all, '_none' = unassigned)
  bindPerson: null,           // person id the next scan goes to
  bindSkip: new Set(),
  lastResult: null
};

// ---------- API ----------
async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `Request failed (${res.status})`); e.data = data; e.status = res.status; throw e; }
  return data;
}
async function refresh() { S = await api('GET', '/api/state'); render(); }
async function act(fn, okMsg) {
  try { const r = await fn(); await refresh(); if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg); return r; }
  catch (e) { toast(e.message, true); throw e; }
}
let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = `toast show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.className = 'toast', 3200);
}

// ---------- helpers ----------
const teamById = (id) => S.teams.find(t => t.id === id);
const personById = (id) => S.people.find(p => p.id === id);
const byName = (a, b) => a.name.localeCompare(b.name);
const byRoleThenName = (a, b) => (a.role === b.role ? 0 : a.role === 'leader' ? -1 : 1) || byName(a, b);

// ---------- render ----------
function render() {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === ui.tab));
  document.querySelectorAll('.tab').forEach(s => s.classList.toggle('active', s.id === `tab-${ui.tab}`));
  const youth = S.people.filter(p => p.role === 'youth').length;
  const leaders = S.people.length - youth;
  const carded = S.people.filter(p => p.cardUid).length;
  $('#summary').textContent = `${youth} youth · ${leaders} leaders · ${S.teams.length} teams · ${carded}/${S.people.length} cards`;
  ({ people: renderPeople, teams: renderTeams, cards: renderCards, settings: renderSettings })[ui.tab]();
  document.body.classList.toggle('selecting', ui.tab === 'teams' && ui.selected.size > 0);
}

// ----- People -----
function renderPeople() {
  const f = ui.peopleFilter.toLowerCase();
  const rows = S.people.filter(p => !f || `${p.name} ${p.ward} ${p.ageGroup} ${teamById(p.teamId)?.name || ''}`.toLowerCase().includes(f))
    .sort(byName);
  $('#tab-people').innerHTML = `
    <div class="two">
      <div class="panel">
        <h3>Add a person</h3>
        <form id="add-person" class="row">
          <input name="name" class="grow" placeholder="Full name" required autocomplete="off">
          <select name="role"><option value="youth">Youth</option><option value="leader">Leader</option></select>
          <input name="ward" placeholder="Ward" size="10">
          <input name="ageGroup" placeholder="Age group" size="10">
          <button class="primary">Add</button>
        </form>
        <p class="hint">Press Enter to add and stay in the name box, for quick typing of many names.</p>
      </div>
      <div class="panel">
        <h3>Import a CSV</h3>
        <div class="row">
          <input type="file" id="csv-file" accept=".csv,.tsv,.txt,text/csv">
          <button id="csv-import" class="primary">Import</button>
          <a href="/sample-roster.csv" download>Sample file</a>
        </div>
        <textarea id="csv-text" placeholder="…or paste rows here. Columns: name, role, ward, age group, notes, team (any order, with a header row). A plain list of names works too."></textarea>
        <p class="hint">Names already in the list are skipped. A "team" column creates and fills teams.</p>
      </div>
    </div>
    <div class="panel">
      <div class="row" style="justify-content:space-between">
        <h3>${S.people.length} people</h3>
        <input id="people-filter" placeholder="Filter by name, ward, team…" value="${esc(ui.peopleFilter)}">
      </div>
      <table>
        <thead><tr><th>Name</th><th>Role</th><th>Ward</th><th>Age group</th><th>Team</th><th>Card</th><th>Notes</th><th></th></tr></thead>
        <tbody>${rows.map(p => `
          <tr data-pid="${p.id}">
            <td><input data-field="name" value="${esc(p.name)}"></td>
            <td><select data-field="role"><option value="youth"${p.role === 'youth' ? ' selected' : ''}>Youth</option><option value="leader"${p.role === 'leader' ? ' selected' : ''}>Leader</option></select></td>
            <td><input data-field="ward" value="${esc(p.ward)}"></td>
            <td><input data-field="ageGroup" value="${esc(p.ageGroup)}"></td>
            <td>${p.teamId ? `<span class="dot" style="background:${esc(teamById(p.teamId)?.color)}"></span>${esc(teamById(p.teamId)?.name)}` : '<span class="hint">none</span>'}</td>
            <td class="mono">${p.cardUid ? esc(p.cardUid) : '<span class="hint">none</span>'}</td>
            <td><input data-field="notes" value="${esc(p.notes)}"></td>
            <td><button class="small danger" data-del-person="${p.id}" title="Delete">✕</button></td>
          </tr>`).join('')}</tbody>
      </table>
      ${rows.length ? '' : '<p class="hint">No one yet. Add people above or import a CSV.</p>'}
    </div>`;
}

// ----- Teams -----
function chip(p) {
  return `<div class="chip${ui.selected.has(p.id) ? ' sel' : ''}" draggable="true" data-chip="${p.id}">
    <span>${esc(p.name)} ${p.role === 'leader' ? '<span class="tag leader">Leader</span>' : ''}</span>
    <span class="meta">${esc([p.ageGroup, p.ward].filter(Boolean).join(' · '))}${p.cardUid ? '' : ' <span class="nocard" title="No card yet">●</span>'}</span>
  </div>`;
}
function renderTeams() {
  const T = S.target;
  const unassigned = S.people.filter(p => !p.teamId).sort(byRoleThenName);
  const cols = S.teams.map(t => {
    const members = S.people.filter(p => p.teamId === t.id).sort(byRoleThenName);
    return `<div class="col${t.locked ? ' locked' : ''}" data-team="${t.id}" style="--team:${esc(t.color)}">
      <div class="col-head">
        <input class="name" data-team-name="${t.id}" value="${esc(t.name)}" ${t.locked ? 'disabled' : ''}>
        <div class="counts ${t.ok ? 'ok' : 'bad'}">${t.youth} youth (${T.youthMin}–${T.youthMax}) · ${t.leaders} leaders (${T.leaders})</div>
        <div class="col-tools">
          <input type="color" data-team-color="${t.id}" value="${esc(t.color)}" title="Team colour" style="width:44px;padding:2px">
          <input data-team-ball="${t.id}" value="${esc(t.ballId)}" placeholder="Ball ID" size="7" title="Which ball this team carries">
          <button class="small" data-lock="${t.id}">${t.locked ? '🔒 Locked' : 'Lock'}</button>
          ${t.locked ? '' : `<button class="small danger" data-del-team="${t.id}" title="Delete team">✕</button>`}
        </div>
      </div>
      <button class="small move-here" data-move="${t.id}" ${t.locked ? 'disabled' : ''}>Move selected here</button>
      <div class="col-body">${members.map(chip).join('')}</div>
    </div>`;
  }).join('');

  $('#tab-teams').innerHTML = `
    <div class="panel row">
      <label>Teams: <input id="team-count" type="number" min="1" max="40" value="${Math.max(S.teams.length, 12)}" style="width:80px"></label>
      <button id="make-teams">Make teams</button>
      <button id="autofill" class="primary">Auto-fill unassigned</button>
      <span class="hint">Auto-fill balances age groups and wards, then gives each team ${T.leaders} leaders. Tap people to select them, then tap "Move selected here". On a laptop you can also drag.</span>
    </div>
    <div class="selbar"><strong id="sel-count">${ui.selected.size} selected</strong><button class="small" id="sel-clear">Clear</button><button class="small" data-move="">Move to unassigned</button></div>
    <div class="board">
      <div class="col unassigned" data-team="">
        <div class="col-head"><strong>Unassigned</strong><div class="counts">${unassigned.length} people</div></div>
        <button class="small move-here" data-move="">Move selected here</button>
        <div class="col-body">${unassigned.map(chip).join('') || '<p class="hint">Everyone is on a team.</p>'}</div>
      </div>
      ${cols}
    </div>`;
}

// ----- Cards -----
function bindQueue() {
  let list = S.people;
  if (ui.bindTeam === '_none') list = list.filter(p => !p.teamId);
  else if (ui.bindTeam) list = list.filter(p => p.teamId === ui.bindTeam);
  return list.sort(byRoleThenName);
}
function nextToBind() {
  const q = bindQueue();
  if (ui.bindPerson && q.some(p => p.id === ui.bindPerson)) return personById(ui.bindPerson);
  return q.find(p => !p.cardUid && !ui.bindSkip.has(p.id)) || null;
}
function renderCards() {
  const q = bindQueue();
  const next = nextToBind();
  const done = q.filter(p => p.cardUid).length;
  const r = ui.lastResult;
  $('#tab-cards').innerHTML = `
    <div class="two">
      <div class="panel">
        <h3>Bind cards</h3>
        <div class="row">
          <label>Go through: <select id="bind-team">
            <option value="">Everyone</option>
            <option value="_none"${ui.bindTeam === '_none' ? ' selected' : ''}>Unassigned</option>
            ${S.teams.map(t => `<option value="${t.id}"${ui.bindTeam === t.id ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}
          </select></label>
          <span class="hint">${done} of ${q.length} have cards</span>
        </div>
        ${next ? `
          <div class="next-up">Next: ${esc(next.name)} <span class="team">${esc(teamById(next.teamId)?.name || 'no team')}${next.cardUid ? ' · replacing card ' + esc(next.cardUid) : ''}</span></div>
          <input id="scan" class="scan-box mono" placeholder="Tap a card on the reader" autocomplete="off" autocapitalize="off" spellcheck="false">
          <div class="row" style="margin-top:8px"><button id="skip" class="small">Skip ${esc(next.name)}</button><span class="hint">Reader not here? Type the ID and press Enter.</span></div>`
        : `<p class="next-up">Everyone here has a card.</p>
           <input id="scan" class="scan-box mono" placeholder="Tap any card to see whose it is" autocomplete="off" autocapitalize="off" spellcheck="false">`}
        <div class="result ${r ? 'show ' + r.kind : ''}">${r ? r.html : ''}</div>
      </div>
      <div class="panel">
        <h3>Who's in this list</h3>
        <ol class="queue">${q.map(p => `<li class="${next && p.id === next.id ? 'current' : ''}">
          <a href="#" data-bind-person="${p.id}">${esc(p.name)}</a> ${p.cardUid ? '✓' : ''}</li>`).join('')}</ol>
        <p class="hint">Tap a name to bind (or replace) that person's card next.</p>
      </div>
    </div>
    <div class="panel">
      <h3>Cards (${S.cards.length})</h3>
      <table><thead><tr><th>Card ID</th><th>Status</th><th>Person</th><th>Team</th><th></th></tr></thead>
      <tbody>${[...S.cards].sort((a, b) => (b.changedAt || '').localeCompare(a.changedAt || '')).map(c => {
        const p = c.personId ? personById(c.personId) : null;
        return `<tr><td class="mono">${esc(c.uid)}</td><td>${esc(c.status)}</td><td>${esc(p?.name || '')}</td><td>${esc(teamById(p?.teamId)?.name || '')}</td>
          <td>${c.status === 'active' ? `<button class="small" data-release="${esc(c.uid)}" data-status="lost">Mark lost</button> <button class="small" data-release="${esc(c.uid)}" data-status="spare">Unbind</button>` : ''}</td></tr>`;
      }).join('')}</tbody></table>
    </div>`;
  setTimeout(() => $('#scan')?.focus(), 0);
}

async function handleScan(raw) {
  const next = nextToBind();
  if (!next) {
    try {
      const r = await api('POST', '/api/cards/lookup', { raw });
      ui.lastResult = r.person
        ? { kind: 'good', html: `<strong>${esc(r.uid)}</strong> belongs to <strong>${esc(r.person.name)}</strong>${r.team ? ' on ' + esc(r.team.name) : ''}.` }
        : { kind: 'bad', html: `<strong>${esc(r.uid)}</strong> isn't bound to anyone.${r.warning ? '<br>' + esc(r.warning) : ''}` };
    } catch (e) { ui.lastResult = { kind: 'bad', html: esc(e.message) }; }
    return render();
  }
  try {
    const r = await api('POST', '/api/cards/bind', { personId: next.id, raw });
    ui.bindPerson = null;
    ui.lastResult = { kind: 'good', html: `✓ <strong>${esc(r.card.uid)}</strong> → ${esc(r.person.name)}${r.unchanged ? ' (already bound)' : ''}${r.replaced ? ` · old card ${esc(r.replaced)} marked lost` : ''}${r.warning ? '<br>' + esc(r.warning) : ''}` };
    await refresh();
  } catch (e) {
    if (e.status === 409 && e.data?.ownerId) {
      const owner = personById(e.data.ownerId);
      ui.lastResult = { kind: 'bad', html: `${esc(e.message)}. <button class="small" data-force="${esc(raw)}">Move it to ${esc(next.name)}</button>` };
    } else ui.lastResult = { kind: 'bad', html: esc(e.message) };
    render();
  }
}

// ----- Settings -----
function renderSettings() {
  const s = S.settings;
  const labels = { auto: 'Auto-detect', hex: 'Hex', 'hex-reversed': 'Hex, bytes reversed', decimal: 'Decimal', 'decimal-reversed': 'Decimal, bytes reversed' };
  $('#tab-settings').innerHTML = `
    <div class="two">
      <div class="panel">
        <h3>Card reader</h3>
        <div class="row">
          <label>Reader types IDs as <select id="uid-format">${S.uidFormats.map(f => `<option value="${f}"${s.uidFormat === f ? ' selected' : ''}>${labels[f]}</option>`).join('')}</select></label>
          <label>ID length <select id="uid-bytes">${[4, 7, 10].map(b => `<option value="${b}"${s.uidBytes === b ? ' selected' : ''}>${b} bytes${b === 7 ? ' (NTAG215)' : ''}</option>`).join('')}</select></label>
        </div>
        <p class="hint">Test: tap a card. The ID shown must match what the ball reads for the same card. If it doesn't, try another format.</p>
        <input id="uid-test" class="scan-box mono" placeholder="Tap a card to test" autocomplete="off" autocapitalize="off" spellcheck="false">
        <div class="result" id="uid-test-result"></div>
      </div>
      <div class="panel">
        <h3>Export</h3>
        <p><a href="/api/export/roster.json">Ball roster (JSON)</a><br><span class="hint">Everyone's name, team and card ID, for loading onto the balls.</span></p>
        <p><a href="/api/export/people.csv">People and teams (CSV)</a><br><span class="hint">Opens in Excel or Numbers; good for printing team lists.</span></p>
        <p><a href="/api/export/backup.json">Full backup (JSON)</a><br><span class="hint">Everything. Keep a copy before camp.</span></p>
      </div>
    </div>`;
}

// ---------- events ----------
document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('button, a, .chip');
  if (!t) return;

  if (t.dataset.tab) { ui.tab = t.dataset.tab; ui.lastResult = null; return render(); }

  // People
  if (t.id === 'csv-import') {
    const file = $('#csv-file').files[0];
    const csv = file ? await file.text() : $('#csv-text').value;
    if (!csv.trim()) return toast('Choose a file or paste some rows first', true);
    return act(() => api('POST', '/api/people/import', { csv }), r =>
      `Added ${r.added}${r.skipped.length ? `, skipped ${r.skipped.length} already listed` : ''}${r.errors.length ? `, ${r.errors.length} problems: ${r.errors.slice(0, 3).join('; ')}` : ''}`);
  }
  if (t.dataset.delPerson) {
    const p = personById(t.dataset.delPerson);
    if (confirm(`Delete ${p.name}?`)) return act(() => api('DELETE', `/api/people/${p.id}`), `Deleted ${p.name}`);
    return;
  }

  // Teams
  if (t.id === 'make-teams') return act(() => api('POST', '/api/teams/generate', { count: Number($('#team-count').value) }), r => r.created ? `Made ${r.created} teams` : 'Already have that many teams');
  if (t.id === 'autofill') return act(() => api('POST', '/api/autofill'), r => `Placed ${r.moved} people`);
  if (t.dataset.lock) { const tm = teamById(t.dataset.lock); return act(() => api('PATCH', `/api/teams/${tm.id}`, { locked: !tm.locked })); }
  if (t.dataset.delTeam) {
    const tm = teamById(t.dataset.delTeam);
    if (confirm(`Delete ${tm.name}? Its members go back to Unassigned.`)) return act(() => api('DELETE', `/api/teams/${tm.id}`), `Deleted ${tm.name}`);
    return;
  }
  if (t.classList.contains('chip')) {
    const id = t.dataset.chip;
    ui.selected.has(id) ? ui.selected.delete(id) : ui.selected.add(id);
    return render();
  }
  if (t.id === 'sel-clear') { ui.selected.clear(); return render(); }
  if ('move' in t.dataset) {
    const ids = [...ui.selected];
    ui.selected.clear();
    return act(() => api('POST', '/api/assign', { personIds: ids, teamId: t.dataset.move || null }), r => `Moved ${r.moved}`).catch(() => {});
  }

  // Cards
  if (t.id === 'skip') { const n = nextToBind(); if (n) ui.bindSkip.add(n.id); ui.bindPerson = null; ui.lastResult = null; return render(); }
  if (t.dataset.bindPerson) { ev.preventDefault(); ui.bindPerson = t.dataset.bindPerson; ui.bindSkip.delete(ui.bindPerson); ui.lastResult = null; return render(); }
  if (t.dataset.force) {
    const next = nextToBind();
    try {
      const r = await api('POST', '/api/cards/bind', { personId: next.id, raw: t.dataset.force, force: true });
      ui.bindPerson = null;
      ui.lastResult = { kind: 'good', html: `✓ Moved <strong>${esc(r.card.uid)}</strong> to ${esc(r.person.name)}` };
      return refresh();
    } catch (e) { return toast(e.message, true); }
  }
  if (t.dataset.release) return act(() => api('POST', `/api/cards/${encodeURIComponent(t.dataset.release)}/release`, { status: t.dataset.status }), t.dataset.status === 'lost' ? 'Card marked lost' : 'Card unbound');
});

document.addEventListener('submit', (ev) => {
  if (ev.target.id !== 'add-person') return;
  ev.preventDefault();
  const f = new FormData(ev.target);
  const body = Object.fromEntries(f.entries());
  act(() => api('POST', '/api/people', body), `Added ${body.name}`).then(() => {
    const form = $('#add-person');
    form.role.value = body.role; form.ward.value = body.ward; form.ageGroup.value = body.ageGroup;
    form.name.focus();
  }).catch(() => {});
});

document.addEventListener('change', (ev) => {
  const el = ev.target;
  const row = el.closest('tr[data-pid]');
  if (row && el.dataset.field) return act(() => api('PATCH', `/api/people/${row.dataset.pid}`, { [el.dataset.field]: el.value }));
  if (el.dataset.teamName) return act(() => api('PATCH', `/api/teams/${el.dataset.teamName}`, { name: el.value }));
  if (el.dataset.teamColor) return act(() => api('PATCH', `/api/teams/${el.dataset.teamColor}`, { color: el.value }));
  if (el.dataset.teamBall) return act(() => api('PATCH', `/api/teams/${el.dataset.teamBall}`, { ballId: el.value }));
  if (el.id === 'bind-team') { ui.bindTeam = el.value; ui.bindPerson = null; ui.bindSkip.clear(); ui.lastResult = null; return render(); }
  if (el.id === 'uid-format') return act(() => api('PATCH', '/api/settings', { uidFormat: el.value }), 'Saved');
  if (el.id === 'uid-bytes') return act(() => api('PATCH', '/api/settings', { uidBytes: Number(el.value) }), 'Saved');
});

document.addEventListener('input', (ev) => {
  if (ev.target.id === 'people-filter') {
    ui.peopleFilter = ev.target.value;
    const pos = ev.target.selectionStart;
    renderPeople();
    const box = $('#people-filter'); box.focus(); box.setSelectionRange(pos, pos);
  }
});

// Keyboard-style readers type the ID and press Enter.
document.addEventListener('keydown', async (ev) => {
  if (ev.key !== 'Enter') return;
  if (ev.target.id === 'scan') {
    ev.preventDefault();
    const raw = ev.target.value; ev.target.value = '';
    if (raw.trim()) await handleScan(raw);
  }
  if (ev.target.id === 'uid-test') {
    ev.preventDefault();
    const raw = ev.target.value; ev.target.value = '';
    const out = $('#uid-test-result');
    try {
      const r = await api('POST', '/api/cards/lookup', { raw });
      out.className = `result show ${r.warning ? 'bad' : 'good'}`;
      out.innerHTML = `Reader typed <span class="mono">${esc(raw.trim())}</span> → card ID <strong class="mono">${esc(r.uid)}</strong> (read as ${esc(r.detected)})${r.person ? `<br>Belongs to ${esc(r.person.name)}` : ''}${r.warning ? `<br>${esc(r.warning)}` : ''}`;
    } catch (e) { out.className = 'result show bad'; out.textContent = e.message; }
  }
});

// Drag and drop for laptops (tap-to-select works everywhere).
document.addEventListener('dragstart', (ev) => {
  const c = ev.target.closest?.('.chip'); if (!c) return;
  if (!ui.selected.has(c.dataset.chip)) { ui.selected.clear(); ui.selected.add(c.dataset.chip); }
  ev.dataTransfer.setData('text/plain', [...ui.selected].join(','));
});
document.addEventListener('dragover', (ev) => { const col = ev.target.closest?.('.col'); if (col) { ev.preventDefault(); col.classList.add('drop'); } });
document.addEventListener('dragleave', (ev) => { ev.target.closest?.('.col')?.classList.remove('drop'); });
document.addEventListener('drop', (ev) => {
  const col = ev.target.closest?.('.col'); if (!col) return;
  ev.preventDefault();
  const ids = ev.dataTransfer.getData('text/plain').split(',').filter(Boolean);
  ui.selected.clear();
  act(() => api('POST', '/api/assign', { personIds: ids, teamId: col.dataset.team || null }), r => `Moved ${r.moved}`).catch(() => {});
});

refresh().catch(e => toast(`Can't reach the server: ${e.message}`, true));
