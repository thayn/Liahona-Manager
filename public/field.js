// Field dashboard: talks to the XIAO base station over USB from the browser (Web Serial,
// Chrome or Edge). Shows every ball's last report, plots GPS positions, sends leader
// messages and commands, and keeps a delivery log. Works fully offline.

import { parseLine, buildCommand, newField, apply, describeSend, freshness, ago, signal,
         utf8Len, MSG_MAX_BYTES } from '/shared/field.js';
import * as L from '/vendor/leaflet/leaflet-src.esm.js';

const STORE_KEY = 'liahona-field-v1';
const ESPRESSIF_VID = 0x303a;            // XIAO ESP32-S3 USB

let ctx = null;                          // { esc, toast, state }
let F = loadField();
const link = { port: null, reader: null, writer: null, closed: null, status: 'off', autoTried: false };
const ui = { to: 'all', root: null };
const map = { m: null, layers: {}, auto: true, lastFit: '', tilesOk: null };   // auto: keep every ball in view until the leader pans or zooms
let tick = null;

export function initField(c) { ctx = c; }

// ---------- persistence (light: survives a page reload on this laptop) ----------
function loadField() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved?.balls) return { ...newField(), balls: saved.balls, log: saved.log || [] };
  } catch { /* storage off or corrupt: start fresh */ }
  return newField();
}
let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ balls: F.balls, log: F.log.slice(0, 200) })); } catch { /* ignore */ }
  }, 500);
}

// ---------- serial link ----------
const serialOk = () => 'serial' in navigator;

async function connect(port) {
  try {
    port = port || await navigator.serial.requestPort({ filters: [{ usbVendorId: ESPRESSIF_VID }] });
  } catch { return; }                                    // chooser closed
  setStatus('connecting');
  try {
    await port.open({ baudRate: 115200 });
    try { await port.setSignals({ dataTerminalReady: false, requestToSend: false }); } catch { /* not all drivers */ }
  } catch (e) {
    setStatus('off');
    ctx.toast(/open|busy|access/i.test(e.message)
      ? 'The base station is busy. Close the Serial Monitor or ESP-IDF monitor, then try again.'
      : `Couldn't open the base station: ${e.message}`, true);
    return;
  }
  link.port = port;
  link.writer = port.writable.getWriter();
  const decoder = new TextDecoderStream();
  link.closed = port.readable.pipeTo(decoder.writable).catch(() => {});
  link.reader = decoder.readable.getReader();
  setStatus('on');
  send('info');
  readLoop();
}

async function readLoop() {
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await link.reader.read();
      if (done) break;
      buf += value;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        handle(parseLine(line));
      }
      if (buf.length > 4000) buf = '';                   // runaway noise
    }
  } catch { /* unplugged */ }
  await disconnect(true);
}

async function disconnect(lost = false) {
  const { port, reader, writer, closed } = link;
  link.port = link.reader = link.writer = link.closed = null;
  try { await reader?.cancel(); } catch { /* already gone */ }
  try { await closed; } catch { /* ignore */ }
  try { writer?.releaseLock(); } catch { /* ignore */ }
  try { await port?.close(); } catch { /* ignore */ }
  if (link.status !== 'off') {
    setStatus('off');
    if (lost) ctx.toast('Base station disconnected', true);
  }
}

async function send(kind, to, extra = {}) {
  let line;
  try { line = buildCommand(kind, to, extra); } catch (e) { ctx.toast(e.message, true); return false; }
  if (!link.writer) { ctx.toast('Connect the base station first', true); return false; }
  const labelled = kind !== 'info' && kind !== 'power';      // these get a "sent" reply
  if (labelled) pendingDescriptions.push(describeSend(kind, extra));
  try { await link.writer.write(new TextEncoder().encode(line + '\n')); }
  catch (e) { if (labelled) pendingDescriptions.pop(); ctx.toast(`Send failed: ${e.message}`, true); return false; }
  return true;
}

// The base answers each send with {"ev":"sent"}; label it with what the leader asked for.
const pendingDescriptions = [];

function handle(ev) {
  if (!ev) return;
  const entry = apply(F, ev);
  if (ev.ev === 'sent' && entry) entry.text = pendingDescriptions.shift() || entry.text;
  if (ev.ev === 'hello') pendingDescriptions.length = 0;
  saveSoon();
  update();
}

function setStatus(s) { link.status = s; update(); }

// ---------- rendering ----------
const teamForBall = (n) => (ctx.state()?.teams || []).find(t => String(t.ballId || '').trim() === String(n));

function ballLabel(n) {
  const t = teamForBall(n);
  return t ? `Ball ${n} · ${t.name}` : `Ball ${n}`;
}

export function renderField(root) {
  ui.root = root;
  if (!root.dataset.built) build(root);
  update();
  if (!tick) tick = setInterval(() => { if (root.classList.contains('active')) update(); }, 1000);
  if (serialOk() && !link.autoTried && link.status === 'off') {
    link.autoTried = true;                               // reconnect a base station chosen before
    navigator.serial.getPorts().then(ps => { if (ps.length === 1 && link.status === 'off') connect(ps[0]); });
  }
}

function build(root) {
  root.dataset.built = '1';
  if (!document.querySelector('link[href="/vendor/leaflet/leaflet.css"]')) {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = '/vendor/leaflet/leaflet.css';
    document.head.appendChild(css);
  }
  root.innerHTML = `
    <div class="panel field-bar">
      <div class="row">
        <span class="field-status" id="f-status"></span>
        <span class="grow muted" id="f-base"></span>
        <label class="nowrap muted">Base power
          <select id="f-power">${[2, 8, 14, 17, 20, 22].map(d => `<option value="${d}"${d === 14 ? ' selected' : ''}>${d} dBm</option>`).join('')}</select>
        </label>
        <button class="small" id="f-power-set">Set</button>
        <button class="primary" id="f-connect"></button>
      </div>
      ${serialOk() ? '' : `<p class="bad-text">This browser can't reach USB devices. Open the Manager in <strong>Chrome</strong> or <strong>Edge</strong> on the camp laptop.</p>`}
    </div>

    <div class="field-grid">
      <div class="panel">
        <h3>Send to the balls</h3>
        <div class="row">
          <label class="nowrap">To <select id="f-to"></select></label>
          <span class="grow"></span>
          <button class="small" data-f="ping">Ping</button>
        </div>
        <div class="row">
          <input id="f-msg" class="grow" maxlength="96" placeholder="Message for the screen, e.g. Head back to camp" autocomplete="off">
          <span class="muted mono" id="f-count">0/${MSG_MAX_BYTES}</span>
          <button class="primary" data-f="msg">Send</button>
        </div>
        <div class="row">
          <button data-f="unlock" title="Open the current step">Unlock</button>
          <button data-f="skip" title="Move past the current step">Skip</button>
          <button data-f="dim" title="Screen and LEDs to rest">Dim</button>
          <button data-f="restore" title="Undo dim">Restore</button>
          <span class="grow"></span>
          <label class="nowrap">Step <input id="f-stage" type="number" min="0" max="255" value="0" style="width:5em"></label>
          <button data-f="stage">Go</button>
        </div>
        <p class="hint">Messages and commands to one ball are resent until it answers. "All" isn't confirmed.</p>
      </div>
      <div class="panel field-plot-panel">
        <div class="row"><h3 class="grow">Positions <span class="muted" id="f-plot-note"></span></h3>
          <button class="small ghost" id="f-fit">Fit to balls</button></div>
        <div id="f-map" class="field-map" role="img" aria-label="Map of ball positions"></div>
      </div>
    </div>

    <div class="panel">
      <h3>Balls</h3>
      <table class="field-table">
        <thead><tr><th>Ball</th><th>Last heard</th><th>Battery</th><th>Lid</th><th>Step</th><th>GPS</th><th>Heading</th><th>Signal</th><th></th></tr></thead>
        <tbody id="f-balls"></tbody>
      </table>
    </div>

    <div class="panel">
      <div class="row"><h3 class="grow">Log</h3>
        <button class="small ghost" id="f-download">Download log</button>
        <button class="small ghost" id="f-clear">Clear</button>
      </div>
      <ol class="field-log" id="f-log"></ol>
    </div>`;

  const $ = (s) => root.querySelector(s);
  $('#f-msg').addEventListener('input', () => updateCount());
  $('#f-msg').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSend('msg'); } });
  $('#f-to').addEventListener('change', (e) => { ui.to = e.target.value; });
  root.addEventListener('click', (e) => {
    const t = e.target.closest('button, tr[data-ball]');
    if (!t) return;
    if (t.id === 'f-connect') return link.status === 'on' ? disconnect() : connect();
    if (t.id === 'f-power-set') return send('power', null, { dbm: Number($('#f-power').value) });
    if (t.id === 'f-download') return downloadLog();
    if (t.id === 'f-fit') { map.auto = true; map.lastFit = ''; return update(); }
    if (t.id === 'f-clear') {
      if (!confirm('Clear the log and the list of balls on this laptop?')) return;
      F = { ...newField(), base: F.base };
      map.auto = true; map.lastFit = '';
      saveSoon(); return update();
    }
    if (t.dataset.f) return doSend(t.dataset.f, t.dataset.ball);
    if (t.dataset.ball && t.tagName === 'TR') { ui.to = t.dataset.ball; update(); $('#f-msg').focus(); }
  });
}

function doSend(kind, ballOverride) {
  const root = ui.root;
  const to = ballOverride || ui.to;
  const extra = {};
  if (kind === 'msg') extra.text = root.querySelector('#f-msg').value;
  if (kind === 'stage') extra.stage = Number(root.querySelector('#f-stage').value);
  if (to === 'all' && ['unlock', 'skip', 'stage'].includes(kind) &&
      !confirm(`${describeSend(kind, extra)} on EVERY ball?`)) return;
  send(kind, to, extra).then(ok => {
    if (ok && kind === 'msg') { root.querySelector('#f-msg').value = ''; updateCount(); }
  });
}

function updateCount() {
  const el = ui.root?.querySelector('#f-count');
  if (!el) return;
  const n = utf8Len(ui.root.querySelector('#f-msg').value.trim());
  el.textContent = `${n}/${MSG_MAX_BYTES}`;
  el.classList.toggle('bad-text', n > MSG_MAX_BYTES);
}

function update() {
  const root = ui.root;
  if (!root?.dataset.built) return;
  const { esc } = ctx;
  const $ = (s) => root.querySelector(s);
  const now = Date.now();

  // connection bar
  const st = link.status;
  $('#f-status').innerHTML = st === 'on' ? '<span class="dot" style="background:var(--good)"></span> Base station connected'
    : st === 'connecting' ? 'Connecting…' : '<span class="dot" style="background:var(--warn)"></span> Not connected';
  $('#f-connect').textContent = st === 'on' ? 'Disconnect' : 'Connect base station';
  $('#f-connect').disabled = !serialOk() || st === 'connecting';
  const b0 = F.base;
  $('#f-base').textContent = b0 ? `${b0.fw} · ${(b0.freq / 1e6).toFixed(1)} MHz · SF${b0.sf}/${b0.bw} kHz · ${b0.power} dBm${b0.tcxo ? '' : ' · crystal'}` : '';
  if (b0 && document.activeElement !== $('#f-power')) $('#f-power').value = String(b0.power);

  // target list: All, every ball heard, every team with a ball number
  const ids = new Set(Object.keys(F.balls).map(Number));
  for (const t of ctx.state()?.teams || []) { const n = Number(t.ballId); if (Number.isInteger(n) && n >= 1 && n <= 254) ids.add(n); }
  const sorted = [...ids].sort((a, b) => a - b);
  const opts = `<option value="all">All balls</option>` + sorted.map(n => `<option value="${n}">${esc(ballLabel(n))}</option>`).join('');
  const sel = $('#f-to');
  if (sel.dataset.opts !== opts) { sel.innerHTML = opts; sel.dataset.opts = opts; }
  if (![...sel.options].some(o => o.value === String(ui.to))) ui.to = 'all';
  sel.value = String(ui.to);

  // balls table
  const rows = sorted.map(n => {
    const b = F.balls[n];
    const t = teamForBall(n);
    const fresh = freshness(b, now);
    const sig = signal(b?.snr);
    const bars = [1, 2, 3, 4].map(i => `<i class="${i <= sig.bars ? 'on' : ''}"></i>`).join('');
    return `<tr data-ball="${n}" class="${String(ui.to) === String(n) ? 'cur-row' : ''}">
      <td><strong>${n}</strong> ${t ? `<span class="dot" style="background:${esc(t.color || 'var(--gold)')}"></span>${esc(t.name)}` : '<span class="muted">no team</span>'}</td>
      <td class="fresh-${fresh}">${b ? ago(b.at, now) : 'not heard yet'}</td>
      <td class="${b?.lowBatt ? 'bad-text' : ''}">${b?.batt ? `${b.batt.toFixed(2)} V${b.lowBatt ? ' low' : ''}` : '—'}</td>
      <td>${b?.lid ?? '—'}</td>
      <td>${b ? b.stage : '—'}</td>
      <td>${b?.fix ? `<span class="mono">${b.lat.toFixed(5)}, ${b.lon.toFixed(5)}</span>` : b?.lat ? `<span class="muted">last fix ${ago(b.fixAt, now)}</span>` : '<span class="muted">no fix</span>'}</td>
      <td>${Number.isFinite(b?.heading) ? `${Math.round(b.heading)}°` : '—'}</td>
      <td title="${b ? `RSSI ${b.rssi} dBm, SNR ${b.snr} dB` : ''}"><span class="bars">${bars}</span> ${b ? sig.label : ''}</td>
      <td class="nowrap"><button class="small" data-f="ping" data-ball="${n}">Ping</button></td>
    </tr>`;
  }).join('');
  $('#f-balls').innerHTML = rows || `<tr><td colspan="9" class="muted">No balls heard yet. Balls report every 30 seconds once their radio is on. Give each team a ball number on the Teams tab to list it here.</td></tr>`;

  // map
  drawMap($('#f-map'), $('#f-plot-note'), now);

  // log
  const stateTag = (s) => s ? `<span class="tag ${s === 'delivered' ? 'ok' : s === 'waiting' || s === 'sent' ? '' : 'warn'}">${esc(s)}</span>` : '';
  $('#f-log').innerHTML = F.log.slice(0, 120).map(e => `<li class="log-${e.kind}">
      <span class="muted mono">${new Date(e.at).toLocaleTimeString()}</span>
      ${e.ball !== undefined ? `<strong>${e.ball === 'all' ? 'All balls' : esc(ballLabel(e.ball))}</strong>` : ''}
      ${esc(e.text)} ${stateTag(e.state)}</li>`).join('') || '<li class="muted">Nothing yet.</li>';
}

// ---------- map (OpenStreetMap tiles; ball markers still show when offline) ----------
function makeMap(el) {
  const m = L.map(el, { zoomControl: true, attributionControl: true }).setView([46.73, -120.95], 13);
  const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(m);
  tiles.on('tileload', () => { if (map.tilesOk !== true) { map.tilesOk = true; update(); } });
  tiles.on('tileerror', () => { if (map.tilesOk !== true) { map.tilesOk = false; update(); } });
  L.control.scale({ metric: true, imperial: true }).addTo(m);
  // Once the leader pans or zooms, stop following; "Fit to balls" turns it back on.
  const manual = () => { map.auto = false; };
  m.on('dragstart', manual);
  el.addEventListener('wheel', manual, { passive: true });
  el.addEventListener('dblclick', manual);
  el.querySelector('.leaflet-control-zoom')?.addEventListener('click', manual);
  return m;
}

function drawMap(el, note, now) {
  if (!map.m) map.m = makeMap(el);
  if (!el.offsetParent) return;                          // tab hidden: Leaflet can't measure
  map.m.invalidateSize(false);
  const { esc } = ctx;
  const balls = Object.values(F.balls).filter(b => Number.isFinite(b.lat));
  const seen = new Set();
  for (const b of balls) {
    seen.add(String(b.id));
    const t = teamForBall(b.id);
    const color = t?.color || '#c9a24a';
    const fresh = freshness(b, now);
    const label = `${b.id}${t ? ` ${t.name}` : ''}`;
    const info = `<strong>${esc(label)}</strong><br>Fix ${ago(b.fixAt, now)}<br>${b.batt ? b.batt.toFixed(2) + ' V · ' : ''}step ${b.stage} · lid ${esc(b.lid)}`;
    let lay = map.layers[b.id];
    if (!lay) {
      lay = map.layers[b.id] = {
        trail: L.polyline([], { color, weight: 3, opacity: 0.5 }).addTo(map.m),
        dot: L.circleMarker([b.lat, b.lon], { radius: 8, color: '#0e0c09', weight: 2, fillColor: color, fillOpacity: 1 })
          .bindTooltip(esc(label), { permanent: true, direction: 'right', offset: [8, 0], className: 'ball-tip' })
          .bindPopup('').addTo(map.m)
      };
    }
    lay.dot.setLatLng([b.lat, b.lon]);
    lay.dot.setStyle({ fillColor: color, fillOpacity: fresh === 'ok' ? 1 : fresh === 'stale' ? 0.6 : 0.3 });
    lay.dot.setTooltipContent(esc(label));
    lay.dot.setPopupContent(info);
    lay.trail.setStyle({ color });
    lay.trail.setLatLngs(b.trail.map(p => [p.lat, p.lon]));
  }
  for (const id of Object.keys(map.layers)) {              // balls cleared from the list
    if (!seen.has(id)) { map.layers[id].dot.remove(); map.layers[id].trail.remove(); delete map.layers[id]; }
  }
  if (balls.length && map.auto) {                          // follow: keep every ball's latest spot in view
    const pts = balls.map(b => [b.lat, b.lon]);
    const key = pts.map(p => p.join(',')).join(';');
    if (key !== map.lastFit) {
      map.lastFit = key;
      if (pts.length === 1) map.m.setView(pts[0], Math.max(map.m.getZoom(), 16), { animate: false });
      else map.m.fitBounds(L.latLngBounds(pts).pad(0.25), { maxZoom: 17, animate: false });
    }
  }
  note.textContent = !balls.length ? '· no GPS fixes yet'
    : map.tilesOk === false ? '· map needs internet; positions still update'
    : '· last known positions';
}

function downloadLog() {
  const lines = F.log.slice().reverse().map(e => JSON.stringify({ time: new Date(e.at).toISOString(), ...e }));
  const blob = new Blob([lines.join('\n') + '\n'], { type: 'application/x-ndjson' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `liahona-field-log-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.jsonl`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

if (serialOk()) {
  navigator.serial.addEventListener('disconnect', (e) => { if (e.target === link.port) disconnect(true); });
}
