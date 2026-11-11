// Public sign-up form. Built from the field list the manager sends, so it
// changes when the form does. No sign-in needed.

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const main = document.getElementById('main');
const started = Date.now();
let FORM = [];
const KEEP = ['ward', 'parentName', 'parentEmail', 'parentPhone', 'parent2Name', 'parent2Phone', 'emergencyName', 'emergencyPhone', 'emergencyRelation', 'insurance', 'signature'];

function control(f, value = '') {
  const id = `f-${f.key}`;
  const req = f.required ? ' required' : '';
  const v = esc(value);
  switch (f.type) {
    case 'textarea': return `<textarea id="${id}" name="${f.key}"${req}>${v}</textarea>`;
    case 'select': return `<select id="${id}" name="${f.key}"${req}><option value="">Choose…</option>${f.options.map(o => `<option${o === value ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    case 'radio': return `<div class="opts" role="radiogroup">${f.options.map(o => `<label><input type="radio" name="${f.key}" value="${esc(o)}"${o === value ? ' checked' : ''}${req}> ${esc(o)}</label>`).join('')}</div>`;
    case 'agree': return '';
    case 'signature': return `<input id="${id}" name="${f.key}" type="text" class="sig" autocomplete="name"${req} value="${v}">`;
    default: return `<input id="${id}" name="${f.key}" type="${f.type === 'date' ? 'date' : f.type === 'email' ? 'email' : f.type === 'tel' ? 'tel' : 'text'}"${req} value="${v}"${f.type === 'email' ? ' autocomplete="email"' : f.type === 'tel' ? ' autocomplete="tel"' : ''}>`;
  }
}

function question(f, value) {
  if (f.type === 'heading') return `<h2>${esc(f.label)}</h2>${f.help ? `<p class="help">${esc(f.help)}</p>` : ''}`;
  const star = f.required ? '<span class="req" aria-hidden="true">*</span>' : '';
  if (f.type === 'agree') {
    return `<div class="q" data-q="${f.key}"><label class="agree"><input type="checkbox" name="${f.key}"${f.required ? ' required' : ''}><span>${esc(f.label)}${star}</span></label><div class="err"></div></div>`;
  }
  const lab = f.type === 'radio' ? `<span class="label">${esc(f.label)}${star}</span>` : `<label for="f-${f.key}">${esc(f.label)}${star}</label>`;
  return `<div class="q" data-q="${f.key}">${lab}${f.help ? `<p class="help">${esc(f.help)}</p>` : ''}${control(f, value)}<div class="err"></div></div>`;
}

function showForm(ev, keep = {}) {
  main.innerHTML = `
    ${ev.intro ? `<p class="intro">${esc(ev.intro)}</p>` : ''}
    <form id="reg" novalidate>
      ${FORM.map(f => question(f, keep[f.key])).join('')}
      <div class="trap" aria-hidden="true"><label>Website <input name="website" tabindex="-1" autocomplete="off"></label></div>
      <div id="banner"></div>
      <button id="send">Send sign-up</button>
    </form>`;
  document.getElementById('reg').addEventListener('submit', submit);
}

async function submit(e) {
  e.preventDefault();
  const form = e.target;
  const answers = {};
  for (const f of FORM) {
    if (f.type === 'heading') continue;
    if (f.type === 'agree' || f.type === 'checkbox') answers[f.key] = form.elements[f.key]?.checked || false;
    else answers[f.key] = form.elements[f.key]?.value?.trim?.() ?? form.elements[f.key]?.value ?? '';
  }
  document.querySelectorAll('.q').forEach(q => { q.classList.remove('bad'); q.querySelector('.err').textContent = ''; });
  // Quick check here; the server checks everything again.
  const missing = FORM.filter(f => f.required && f.type !== 'heading' && (answers[f.key] === '' || answers[f.key] === false));
  if (missing.length) return showErrors(missing.map(f => ({ key: f.key, message: 'Required' })));
  const btn = document.getElementById('send');
  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const res = await fetch('/api/public/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers, website: form.elements.website.value, _started: started }) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { if (d.errors) showErrors(d.errors); else banner(d.error || 'Something went wrong. Please try again.'); return; }
    done(d, answers);
  } catch {
    banner('Couldn\'t send. Check your internet connection and try again.');
  } finally { btn.disabled = false; btn.textContent = 'Send sign-up'; }
}

function showErrors(errors) {
  for (const er of errors) {
    const q = document.querySelector(`.q[data-q="${er.key}"]`);
    if (!q) continue;
    q.classList.add('bad');
    q.querySelector('.err').textContent = er.message;
  }
  const first = document.querySelector('.q.bad');
  if (first) { first.scrollIntoView({ behavior: 'smooth', block: 'center' }); first.querySelector('input,select,textarea')?.focus({ preventScroll: true }); }
  banner(`Please check the ${errors.length} highlighted question${errors.length > 1 ? 's' : ''}.`);
}
function banner(msg) { document.getElementById('banner').innerHTML = `<p class="banner">${esc(msg)}</p>`; }

function done(d, answers) {
  window.scrollTo(0, 0);
  main.innerHTML = `
    <div class="notice">
      <h2>Thank you!</h2>
      <p><strong>${esc(d.name)}</strong> is signed up. The camp leaders will review it and be in touch.</p>
      ${d.duplicate ? '<p class="help">We already had a sign-up with this name and birth date, so the leaders will check for a duplicate.</p>' : ''}
      <button class="secondary" id="another">Sign up another youth</button>
    </div>`;
  document.getElementById('another').addEventListener('click', () => {
    const keep = Object.fromEntries(KEEP.filter(k => answers[k]).map(k => [k, answers[k]]));
    showForm(window.__ev, keep);
    window.scrollTo(0, 0);
  });
}

(async function start() {
  try {
    const { event: ev, form } = await (await fetch('/api/public/event')).json();
    window.__ev = ev;
    FORM = form;
    document.title = `${ev.name} · Sign-up`;
    document.getElementById('ev-name').textContent = ev.name;
    document.getElementById('ev-tagline').textContent = ev.tagline || '';
    document.getElementById('ev-meta').textContent = [ev.dates, ev.location].filter(Boolean).join(' · ');
    if (/^#[0-9a-f]{6}$/i.test(ev.color || '')) document.documentElement.style.setProperty('--accent', ev.color);
    if (!ev.registrationOpen) {
      main.innerHTML = '<div class="notice"><h2>Sign-ups aren\'t open</h2><p>Please check back later, or contact the camp leaders.</p></div>';
      return;
    }
    showForm(ev);
  } catch {
    main.innerHTML = '<div class="notice"><h2>Couldn\'t load the form</h2><p>Check your connection and refresh the page.</p></div>';
  }
})();
