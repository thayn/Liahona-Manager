// Screens added for the cloud manager: Sign-ups, Users, Event settings,
// the camp laptop panel, sign-in codes, person details, and media uploads.

let H = null;           // helpers from app.js: api, act, toast, esc, state, me, cfg, can, refresh, rerender
const X = {
  signupFilter: 'pending',
  openSignup: null,
  users: null,          // cloud user list, loaded on demand
  usersError: '',
  camp: null,           // cloud: {lock, keys} | laptop: {link, codes}
  newKey: null          // a sync key shown once after it's created
};
export function initExtra(helpers) { H = helpers; }

const $ = (sel, root = document) => root.querySelector(sel);
const fmt = (iso) => iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
const fieldLabel = (key) => (H.state().form || []).find(f => f.key === key)?.label?.split('(')[0].trim() || key;

// ================================================================ Sign-ups

export function renderSignups(root) {
  const S = H.state(), esc = H.esc;
  const regs = [...S.registrations].sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
  const counts = { pending: 0, approved: 0, rejected: 0 };
  for (const r of regs) counts[r.status]++;
  const shown = regs.filter(r => X.signupFilter === 'all' || r.status === X.signupFilter);
  const ev = S.settings.event || {};
  const link = `${location.origin}/register`;
  root.innerHTML = `
    <div class="panel">
      <div class="row" style="justify-content:space-between">
        <h3>Sign-ups</h3>
        <div class="row">
          ${[['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Not accepted'], ['all', 'All']].map(([k, label]) => `<button class="small${X.signupFilter === k ? ' primary' : ''}" data-sfilter="${k}">${label}${k === 'all' ? '' : ` (${counts[k]})`}</button>`).join('')}
        </div>
      </div>
      <p class="hint">The sign-up form is ${ev.registrationOpen ? '<strong>open</strong>' : '<strong>closed</strong>'}: <a href="/register" target="_blank" rel="noopener">${esc(link)}</a>.
        ${H.can('admin') ? 'Open or close it in Settings → Event.' : ''} Approving a sign-up adds the youth to People.</p>
      ${shown.length ? `<table>
        <thead><tr><th>Youth</th><th>Ward</th><th>Parent</th><th>Sent</th><th>Status</th><th></th></tr></thead>
        <tbody>${shown.map(r => `
          <tr>
            <td><button class="linklike" data-signup="${r.id}">${esc(r.answers.firstName)} ${esc(r.answers.lastName)}</button>${r.duplicateOf ? ' <span class="tag warn" title="Same name and birth date as another sign-up">possible duplicate</span>' : ''}</td>
            <td>${esc(r.answers.ward)}</td>
            <td>${esc(r.answers.parentName)}<br><span class="hint">${esc(r.answers.parentPhone)}</span></td>
            <td class="nowrap">${fmt(r.submittedAt)}</td>
            <td>${r.status === 'pending' ? '<span class="tag">pending</span>' : r.status === 'approved' ? '<span class="tag ok">approved</span>' : '<span class="tag warn">not accepted</span>'}</td>
            <td class="nowrap">${r.status === 'pending' ? `<button class="small primary" data-approve="${r.id}">Approve</button> <button class="small" data-reject="${r.id}">Don't accept</button>` : ''}</td>
          </tr>
          ${X.openSignup === r.id ? `<tr class="expanded"><td colspan="6">${answersHtml(r)}</td></tr>` : ''}`).join('')}
        </tbody></table>` : `<p class="hint">No ${X.signupFilter === 'all' ? '' : X.signupFilter + ' '}sign-ups.</p>`}
    </div>`;
}

function answersHtml(r) {
  const esc = H.esc;
  const form = H.state().form || [];
  const rows = [];
  for (const f of form) {
    if (f.type === 'heading') { rows.push(`<dt class="sect">${esc(f.label)}</dt>`); continue; }
    const v = r.answers[f.key];
    if (v === undefined || v === '' || v === false && f.type !== 'agree') continue;
    rows.push(`<dt>${esc(f.label.length > 60 ? f.label.slice(0, 58) + '…' : f.label)}</dt><dd>${v === true ? 'Yes' : v === false ? 'No' : esc(v)}</dd>`);
  }
  rows.push(`<dt>Signed by</dt><dd>${esc(r.signedBy)} · ${fmt(r.signedAt)}</dd>`);
  if (r.decidedBy) rows.push(`<dt>${r.status === 'approved' ? 'Approved' : 'Not accepted'} by</dt><dd>${esc(r.decidedBy)} · ${fmt(r.decidedAt)}${r.reason ? ` · ${esc(r.reason)}` : ''}</dd>`);
  return `<dl class="answers">${rows.join('')}</dl>`;
}

// ================================================================ Users

export function renderUsers(root) {
  const esc = H.esc, S = H.state();
  if (!X.users && !X.usersError) {
    root.innerHTML = '<div class="panel"><p class="hint">Loading users…</p></div>';
    H.api('GET', '/api/users').then(u => { X.users = u; H.rerender(); }).catch(e => { X.usersError = e.message; H.rerender(); });
    return;
  }
  const roleBoxes = (u) => S.roles.map(r => `<label class="nowrap"><input type="checkbox" data-user-role="${esc(u.username)}" value="${r.id}"${u.roles.includes(r.id) ? ' checked' : ''}> ${r.label}</label>`).join(' ');
  root.innerHTML = `
    <div class="two">
      <div class="panel">
        <h3>Invite someone</h3>
        <form id="invite-user" class="stack">
          <input name="email" type="email" placeholder="Email" required>
          <input name="name" placeholder="Name">
          <div class="row">${S.roles.map(r => `<label class="nowrap"><input type="checkbox" name="roles" value="${r.id}"${r.id === 'planner' ? ' checked' : ''}> ${r.label}</label>`).join(' ')}</div>
          <button class="primary">Send invite</button>
        </form>
        <p class="hint">They get an email with a temporary password and choose their own on first sign-in. Leaders also need the same email on their People entry, so they see their own team.</p>
      </div>
      <div class="panel">
        <h3>What each role can do</h3>
        <dl class="answers">
          <dt>Admin</dt><dd>Everything: users, event settings, deleting data, the camp laptop</dd>
          <dt>Planner</dt><dd>Journeys, places, media, teams, cards. Sees names, ward, age and team, not private details</dd>
          <dt>Registrar</dt><dd>Sign-ups and full participant details (contacts, health, permission)</dd>
          <dt>Leader</dt><dd>Read-only. Sees private details only for their own team</dd>
        </dl>
      </div>
    </div>
    <div class="panel">
      <div class="row" style="justify-content:space-between"><h3>${X.users ? X.users.length : ''} users</h3><button class="small" id="users-reload">Reload</button></div>
      ${X.usersError ? `<p class="error-text">${esc(X.usersError)}</p>` : `<table>
        <thead><tr><th>Name</th><th>Email</th><th>Roles</th><th>Status</th><th></th></tr></thead>
        <tbody>${X.users.map(u => `
          <tr class="${u.enabled ? '' : 'muted'}">
            <td>${esc(u.name)}</td><td>${esc(u.email)}</td>
            <td>${roleBoxes(u)}</td>
            <td>${!u.enabled ? 'Disabled' : u.status === 'FORCE_CHANGE_PASSWORD' ? 'Invited' : 'Active'}</td>
            <td class="nowrap">
              ${u.status === 'FORCE_CHANGE_PASSWORD' ? `<button class="small" data-user-resend="${esc(u.username)}">Resend invite</button>` : ''}
              <button class="small" data-user-enable="${esc(u.username)}" data-on="${u.enabled ? '0' : '1'}">${u.enabled ? 'Disable' : 'Enable'}</button>
              <button class="small danger" data-user-del="${esc(u.username)}" title="Delete">✕</button>
            </td>
          </tr>`).join('')}</tbody></table>`}
    </div>`;
}

const reloadUsers = async () => { X.users = null; X.usersError = ''; H.rerender(); };

// ================================================================ Settings panels

export function renderAdminPanels(root) {
  const S = H.state(), esc = H.esc;
  const e = S.settings.event || {};
  const local = S.mode === 'local';
  root.innerHTML = `
    <div class="two">
      <div class="panel">
        <h3>Event</h3>
        <form id="event-form" class="stack">
          <label>Name <input name="name" value="${esc(e.name)}" placeholder="e.g. Covenant Path"></label>
          <label>Tagline <input name="tagline" value="${esc(e.tagline)}" placeholder="e.g. Make promises · Keep promises"></label>
          <div class="row">
            <label class="grow">Dates shown <input name="dates" value="${esc(e.dates)}" placeholder="July 12–15, 2027"></label>
            <label>First day <input name="startDate" type="date" value="${esc(e.startDate || '')}"></label>
          </div>
          <label>Location <input name="location" value="${esc(e.location)}"></label>
          <label>Sign-up page message <textarea name="intro">${esc(e.intro)}</textarea></label>
          <div class="row">
            <label>Colour <input name="color" type="color" value="${esc(e.color || '#B98F3E')}"></label>
            <label class="nowrap"><input name="registrationOpen" type="checkbox"${e.registrationOpen ? ' checked' : ''}> Sign-up form is open</label>
          </div>
          <button class="primary">Save event</button>
        </form>
        <p class="hint">The theme can change any time: these settings feed the sign-up page and the header. Ages on sign-ups are worked out for the first day.</p>
      </div>
      <div class="panel" id="camp-panel">${local ? laptopCampHtml() : cloudCampHtml()}</div>
    </div>
    ${local ? `<div class="panel" id="codes-panel">${codesHtml()}</div>` : ''}`;
  if (!X.camp) loadCamp();
}

async function loadCamp() {
  try {
    if (H.state().mode === 'local') {
      const [link, codes] = await Promise.all([H.api('GET', '/api/camp/link'), H.api('GET', '/api/local/codes')]);
      X.camp = { link, codes };
    } else {
      X.camp = await H.api('GET', '/api/camp/status');
    }
  } catch (e) { X.camp = { error: e.message }; }
  if (H.state() && document.getElementById('camp-panel')) H.rerender();
}

function cloudCampHtml() {
  const esc = H.esc;
  if (!X.camp) return '<h3>Camp laptop</h3><p class="hint">Loading…</p>';
  if (X.camp.error) return `<h3>Camp laptop</h3><p class="error-text">${esc(X.camp.error)}</p>`;
  const { lock, keys } = X.camp;
  return `
    <h3>Camp laptop</h3>
    <p class="hint">Before camp, the laptop downloads everything and this cloud copy becomes read-only, so all changes happen on the laptop (it works with no internet). After camp it uploads, and this copy opens again.</p>
    ${lock ? `<div class="result show bad">Checked out to <strong>${esc(lock.laptop || 'a laptop')}</strong> since ${fmt(lock.at)}.<br>
      <button class="small" id="camp-unlock">Unlock without the laptop</button> <span class="hint">Only if the laptop is lost or broken: its camp changes won't come back.</span></div>`
      : '<div class="result show good">Not checked out. This is the live copy.</div>'}
    <h4>Sync keys</h4>
    <p class="hint">The laptop needs a key to download and upload. Create one, then paste it into the laptop's Settings. Keys last 30 days.</p>
    ${X.newKey ? `<div class="result show good">New key (shown once, copy it now):<br><code class="mono selectable">${esc(X.newKey)}</code><br>Cloud address: <code class="mono selectable">${esc(location.origin)}</code></div>` : ''}
    <div class="row"><input id="key-label" placeholder="Which laptop? e.g. HP laptop"><button class="small primary" id="key-create">Create key</button></div>
    ${keys.length ? `<table><tbody>${keys.map(k => `<tr class="${k.expired ? 'muted' : ''}"><td>${esc(k.label || k.id)}</td><td class="hint">by ${esc(k.createdBy)}, ${k.expired ? 'expired' : `until ${fmt(k.expiresAt)}`}</td><td><button class="small danger" data-key-del="${esc(k.id)}">Remove</button></td></tr>`).join('')}</tbody></table>` : ''}`;
}

function laptopCampHtml() {
  const esc = H.esc;
  if (!X.camp) return '<h3>Cloud</h3><p class="hint">Loading…</p>';
  if (X.camp.error) return `<h3>Cloud</h3><p class="error-text">${esc(X.camp.error)}</p>`;
  const l = X.camp.link;
  return `
    <h3>Cloud</h3>
    <p class="hint">Connect this laptop to the cloud manager. An Admin creates a sync key in the cloud (Settings → Camp laptop).</p>
    <form id="link-form" class="stack">
      <label>Cloud address <input name="cloudUrl" value="${esc(l.cloudUrl || '')}" placeholder="https://d123abc.cloudfront.net"></label>
      <label>Sync key <input name="key" type="password" placeholder="${l.hasKey ? 'saved (paste a new one to replace it)' : 'lhk_…'}" autocomplete="off"></label>
      <button class="small">Save</button>
    </form>
    ${l.lockId
      ? `<div class="result show good">This laptop has the camp copy (downloaded ${fmt(l.checkedOutAt)}). Edit freely here; upload when camp is over.</div>
         <button class="primary" id="camp-upload">Upload after camp</button>`
      : `<button class="primary" id="camp-download"${l.cloudUrl && l.hasKey ? '' : ' disabled'}>Download for camp</button>
         <p class="hint">Replaces what's on this laptop with the cloud copy (a backup is kept), fetches the Journey media, and makes the cloud read-only until you upload.</p>
         <details class="hint"><summary>First-time setup: move this laptop's data into the cloud</summary>
           <p>Use this once, to start the cloud from what's already on this laptop (people, teams, cards, places, Journeys and media). It replaces whatever the cloud has.</p>
           <button class="small" id="camp-seed"${l.cloudUrl && l.hasKey ? '' : ' disabled'}>Copy this laptop to the cloud</button>
         </details>`}
    ${l.lastUploadAt ? `<p class="hint">Last upload ${fmt(l.lastUploadAt)}.</p>` : ''}
    <div class="result" id="camp-result"></div>`;
}

function codesHtml() {
  const S = H.state(), esc = H.esc;
  const codes = X.camp?.codes || {};
  return `
    <h3>Sign-in codes for phones and iPads</h3>
    <p class="hint">Whoever uses this laptop is an Admin. Other devices on the camp Wi-Fi sign in with their email and one of these codes, which decides their role. Leaders see their own team (their email must be on their People entry).</p>
    <table><tbody>${S.roles.map(r => `
      <tr><td>${r.label}</td><td>${codes[r.id] ? '<span class="tag ok">set</span>' : '<span class="hint">none</span>'}</td>
        <td><input type="password" id="code-${r.id}" placeholder="New code (6+ characters)" autocomplete="new-password"></td>
        <td class="nowrap"><button class="small" data-code-set="${r.id}">Set</button>${codes[r.id] ? ` <button class="small" data-code-clear="${r.id}">Remove</button>` : ''}</td></tr>`).join('')}
    </tbody></table>`;
}

// ================================================================ Person details

export function personDialog(pid) {
  const S = H.state(), esc = H.esc;
  const p = S.people.find(x => x.id === pid);
  if (!p) return;
  const form = S.form || [];
  const canEdit = H.can('people');
  const canSee = H.can('private') || (S.me.teamId && p.teamId === S.me.teamId);
  const rows = [];
  for (const f of form) {
    if (f.type === 'heading') { rows.push(`<h4>${esc(f.label)}</h4>`); continue; }
    if (['firstName', 'lastName', 'ward'].includes(f.key)) continue;
    const src = f.private ? p.private : p.profile;
    if (f.private && !canSee) continue;
    const v = src?.[f.key];
    if (!canEdit) { if (v !== undefined && v !== '') rows.push(`<p><span class="hint">${esc(f.label.split('(')[0])}</span><br>${v === true ? 'Yes' : esc(v)}</p>`); continue; }
    if (['agree', 'signature', 'checkbox'].includes(f.type)) { if (v !== undefined) rows.push(`<p><span class="hint">${esc(f.label.split('(')[0])}</span><br>${v === true ? 'Yes' : esc(v)}</p>`); continue; }
    const name = `${f.private ? 'private' : 'profile'}.${f.key}`;
    const input = f.type === 'textarea' ? `<textarea name="${name}">${esc(v ?? '')}</textarea>`
      : f.options ? `<select name="${name}"><option value=""></option>${f.options.map(o => `<option${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`
      : `<input name="${name}" type="${f.type === 'date' ? 'date' : f.type === 'email' ? 'email' : 'text'}" value="${esc(v ?? '')}">`;
    rows.push(`<label>${esc(f.label.split('(')[0])} ${input}</label>`);
  }
  if (canSee && p.private?.signedBy) rows.push(`<p class="hint">Permission signed by ${esc(p.private.signedBy)} on ${fmt(p.private.signedAt)}</p>`);
  const team = S.teams.find(t => t.id === p.teamId);
  const d = document.getElementById('dialog');
  d.innerHTML = `
    <form method="dialog" id="person-form" data-pid="${p.id}" class="stack">
      <div class="row" style="justify-content:space-between"><h3>${esc(p.name)}</h3><button value="close" class="small">Close</button></div>
      <p class="hint">${p.role === 'leader' ? 'Leader' : `Youth${p.age ? `, ${p.age}` : ''}`}${p.ward ? ` · ${esc(p.ward)}` : ''}${team ? ` · ${esc(team.name)}` : ''}</p>
      ${!canSee ? '<p class="hint">Contact and health details are only shown to Registrars, Admins and this person\'s team leaders.</p>' : ''}
      ${rows.join('') || '<p class="hint">No details yet.</p>'}
      ${canEdit ? '<button class="primary" value="save">Save details</button>' : ''}
    </form>`;
  d.showModal();
}

// ================================================================ Media (cloud)

export async function uploadMedia(input) {
  const folder = input.dataset.folder;
  const files = [...input.files];
  input.value = '';
  if (!folder) return H.toast('Set the Journey\'s media folder name first, and save', true);
  let done = 0;
  for (const f of files) {
    try {
      H.toast(`Uploading ${f.name}…`);
      const { url } = await H.api('POST', `/api/media/${encodeURIComponent(folder)}/upload-url`, { name: f.name, type: f.type });
      const res = await fetch(url, { method: 'PUT', body: f, headers: f.type ? { 'Content-Type': f.type } : {} });
      if (!res.ok) throw new Error(`upload failed (${res.status})`);
      await H.api('POST', `/api/media/${encodeURIComponent(folder)}/uploaded`, { name: f.name });
      done++;
    } catch (e) { H.toast(`${f.name}: ${e.message}`, true); }
  }
  if (done) { H.toast(`Uploaded ${done} file${done > 1 ? 's' : ''}`); document.dispatchEvent(new CustomEvent('media-uploaded')); }
}

// ================================================================ Events

export async function extraClick(t) {
  const S = H.state();
  if (t.dataset.sfilter) { X.signupFilter = t.dataset.sfilter; H.rerender(); return true; }
  if (t.dataset.signup) { X.openSignup = X.openSignup === t.dataset.signup ? null : t.dataset.signup; H.rerender(); return true; }
  if (t.dataset.approve) {
    await H.act(() => H.api('POST', `/api/registrations/${t.dataset.approve}/approve`), r => `${r.person.name} added to People`).catch(() => {});
    return true;
  }
  if (t.dataset.reject) {
    const reason = prompt('Not accepting this sign-up. Reason (optional, only leaders see it):');
    if (reason === null) return true;
    await H.act(() => H.api('POST', `/api/registrations/${t.dataset.reject}/reject`, { reason }), 'Marked as not accepted').catch(() => {});
    return true;
  }

  // users
  if (t.id === 'users-reload') { await reloadUsers(); return true; }
  if (t.dataset.userEnable) {
    await H.api('PATCH', `/api/users/${encodeURIComponent(t.dataset.userEnable)}`, { enabled: t.dataset.on === '1' }).catch(e => H.toast(e.message, true));
    await reloadUsers(); return true;
  }
  if (t.dataset.userResend) {
    await H.api('PATCH', `/api/users/${encodeURIComponent(t.dataset.userResend)}`, { resendInvite: true }).then(() => H.toast('Invite sent again')).catch(e => H.toast(e.message, true));
    return true;
  }
  if (t.dataset.userDel) {
    if (!confirm(`Delete the account for ${t.dataset.userDel}? They won't be able to sign in.`)) return true;
    await H.api('DELETE', `/api/users/${encodeURIComponent(t.dataset.userDel)}`).catch(e => H.toast(e.message, true));
    await reloadUsers(); return true;
  }

  // camp: cloud
  if (t.id === 'key-create') {
    const r = await H.api('POST', '/api/camp/keys', { label: $('#key-label').value }).catch(e => { H.toast(e.message, true); });
    if (r) { X.newKey = r.key; X.camp = null; await loadCamp(); }
    return true;
  }
  if (t.dataset.keyDel) { X.camp = await H.api('DELETE', `/api/camp/keys/${t.dataset.keyDel}`); X.newKey = null; H.rerender(); return true; }
  if (t.id === 'camp-unlock') {
    if (!confirm('Unlock the cloud copy without the laptop? Anything changed on the laptop at camp will NOT come back if you do this.')) return true;
    X.camp = await H.api('POST', '/api/camp/unlock'); await H.refresh(); return true;
  }

  // camp: laptop
  if (t.id === 'camp-seed') {
    if (!confirm('Copy everything on this laptop to the cloud? Whatever the cloud has now is replaced (it stays in the cloud history).')) return true;
    const out = $('#camp-result');
    out.className = 'result show'; out.textContent = 'Copying… media can take a few minutes.';
    try {
      const r = await H.api('POST', '/api/camp/upload', { force: true });
      out.className = `result show ${r.mediaFailed.length ? 'bad' : 'good'}`;
      out.innerHTML = `Done: ${r.journeys} Journeys and ${r.mediaUploaded} media files copied. Open the cloud address to check.${r.mediaFailed.length ? `<br>Failed: ${H.esc(r.mediaFailed.join(', '))}` : ''}`;
      X.camp = null;
    } catch (e) { out.className = 'result show bad'; out.textContent = e.message; }
    return true;
  }
  if (t.id === 'camp-download' || t.id === 'camp-upload') {
    const down = t.id === 'camp-download';
    if (down && !confirm('Download the cloud copy onto this laptop? What\'s on the laptop now is replaced (a backup is kept), and the cloud becomes read-only until you upload.')) return true;
    if (!down && !confirm('Upload this laptop\'s copy to the cloud? It becomes the cloud copy (earlier versions are kept in the cloud history).')) return true;
    const out = $('#camp-result');
    t.disabled = true;
    out.className = 'result show'; out.textContent = down ? 'Downloading… media can take a few minutes.' : 'Uploading…';
    try {
      const r = await H.api('POST', down ? '/api/camp/download' : '/api/camp/upload', {});
      out.className = `result show ${(r.mediaFailed || []).length ? 'bad' : 'good'}`;
      out.innerHTML = down
        ? `Done: ${r.files} files, ${r.mediaFetched} media downloaded (${r.mediaAlreadyHere} already here).${r.mediaFailed.length ? `<br>Failed: ${H.esc(r.mediaFailed.join(', '))}` : ''}`
        : `Done. The cloud is editable again.${r.keptSignups ? ` ${r.keptSignups} sign-up(s) that arrived during camp were kept.` : ''} ${r.mediaUploaded} new media file(s) uploaded.${r.mediaFailed.length ? `<br>Failed: ${H.esc(r.mediaFailed.join(', '))}` : ''}`;
      X.camp = null;
      await H.refresh();
    } catch (e) {
      out.className = 'result show bad';
      out.textContent = e.message;
      if (e.status === 409 && down && e.data?.lock && confirm(`${e.message}\n\nTake it over anyway? Changes on the other laptop would be lost.`)) {
        await H.api('POST', '/api/camp/download', { force: true }).then(() => { X.camp = null; return H.refresh(); }).catch(err => H.toast(err.message, true));
      }
    } finally { t.disabled = false; }
    return true;
  }
  if (t.dataset.codeSet || t.dataset.codeClear) {
    const role = t.dataset.codeSet || t.dataset.codeClear;
    const code = t.dataset.codeSet ? $(`#code-${role}`).value : '';
    try { X.camp.codes = await H.api('PUT', '/api/local/codes', { role, code }); H.toast(code ? 'Code set' : 'Code removed'); H.rerender(); }
    catch (e) { H.toast(e.message, true); }
    return true;
  }
  void S;
  return false;
}

export function extraChange(el) {
  if (el.dataset.userRole) {
    const username = el.dataset.userRole;
    const roles = [...document.querySelectorAll(`input[data-user-role="${CSS.escape(username)}"]:checked`)].map(i => i.value);
    H.api('PATCH', `/api/users/${encodeURIComponent(username)}`, { roles }).then(() => H.toast('Roles saved')).catch(e => { H.toast(e.message, true); reloadUsers(); });
    return true;
  }
  return false;
}

export function extraSubmit(ev) {
  const f = ev.target;
  if (f.id === 'invite-user') {
    ev.preventDefault();
    const fd = new FormData(f);
    const body = { email: fd.get('email'), name: fd.get('name'), roles: fd.getAll('roles') };
    H.api('POST', '/api/users', body).then(() => { H.toast(`Invite sent to ${body.email}`); reloadUsers(); }).catch(e => H.toast(e.message, true));
    return true;
  }
  if (f.id === 'event-form') {
    ev.preventDefault();
    const fd = new FormData(f);
    const body = Object.fromEntries(fd.entries());
    body.registrationOpen = fd.has('registrationOpen');
    H.act(() => H.api('PATCH', '/api/event', body), 'Event saved').catch(() => {});
    return true;
  }
  if (f.id === 'link-form') {
    ev.preventDefault();
    const fd = Object.fromEntries(new FormData(f).entries());
    if (!fd.key) delete fd.key;
    H.api('PUT', '/api/camp/link', fd).then(link => { X.camp.link = link; H.toast('Saved'); H.rerender(); }).catch(e => H.toast(e.message, true));
    return true;
  }
  if (f.id === 'person-form') {
    if (ev.submitter?.value !== 'save') return false;
    ev.preventDefault();
    const body = { profile: {}, private: {} };
    for (const [k, v] of new FormData(f).entries()) {
      const [group, key] = k.split('.');
      body[group][key] = v;
    }
    H.act(() => H.api('PATCH', `/api/people/${f.dataset.pid}`, body), 'Details saved').then(() => document.getElementById('dialog').close()).catch(() => {});
    return true;
  }
  return false;
}
