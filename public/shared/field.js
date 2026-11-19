// Field dashboard logic with no browser APIs, so it runs in Node tests too.
// The XIAO base station speaks one JSON object per line over USB
// (see base_station/README.md in the Liahona repo).

export const MSG_MAX_BYTES = 48;          // radio packet limit for leader messages
export const STALE_S = 90;                // amber after this long without a report
export const LOST_S = 180;                // red after this long
export const COMMANDS = ['unlock', 'skip', 'dim', 'restore', 'update'];

export const utf8Len = (s) => new TextEncoder().encode(String(s ?? '')).length;

/** Parse one line from the base station. Returns an event object, or null for noise. */
export function parseLine(line) {
  const s = String(line ?? '').trim();
  if (!s.startsWith('{')) return null;          // boot messages, partial lines
  try {
    const ev = JSON.parse(s);
    return ev && typeof ev.ev === 'string' ? ev : null;
  } catch { return null; }
}

/** Target: a ball number 1-254, or 'all'. */
function target(to) {
  if (to === 'all' || to === 255) return 'all';
  const n = Number(to);
  if (!Number.isInteger(n) || n < 1 || n > 254) throw new Error('Choose a ball (1-254) or All');
  return n;
}

/** Build the command line to send to the base station (without the newline). */
export function buildCommand(kind, to, extra = {}) {
  if (kind === 'info') return JSON.stringify({ cmd: 'info' });
  if (kind === 'power') {
    const dbm = Number(extra.dbm);
    if (!Number.isInteger(dbm) || dbm < -9 || dbm > 22) throw new Error('Power is -9 to 22 dBm');
    return JSON.stringify({ cmd: 'power', dbm });
  }
  const t = target(to);
  if (kind === 'ping') return JSON.stringify({ cmd: 'ping', to: t });
  if (kind === 'msg') {
    const text = String(extra.text ?? '').trim();
    if (!text) throw new Error('Type a message first');
    if (utf8Len(text) > MSG_MAX_BYTES) throw new Error(`Messages fit ${MSG_MAX_BYTES} bytes; this one is ${utf8Len(text)}`);
    return JSON.stringify({ cmd: 'msg', to: t, text });
  }
  if (kind === 'stage') {
    const stage = Number(extra.stage);
    if (!Number.isInteger(stage) || stage < 0 || stage > 255) throw new Error('Step is a number 0-255');
    return JSON.stringify({ cmd: 'stage', to: t, stage });
  }
  if (COMMANDS.includes(kind)) return JSON.stringify({ cmd: kind, to: t });
  throw new Error(`Unknown command ${kind}`);
}

/**
 * Field state: balls heard, sends waiting for an ACK, and a log.
 * apply(ev, nowMs) updates it and returns a log entry (or null).
 */
export function newField() {
  return { base: null, balls: {}, sends: {}, log: [] };
}

const LOG_MAX = 300;
const TRAIL_MAX = 40;

function addLog(f, entry) {
  f.log.unshift(entry);
  if (f.log.length > LOG_MAX) f.log.length = LOG_MAX;
  return entry;
}

export function apply(f, ev, now = Date.now()) {
  if (!ev) return null;
  switch (ev.ev) {
    case 'hello':
      f.base = { fw: ev.fw, freq: ev.freq, bw: ev.bw, sf: ev.sf, power: ev.power, tcxo: ev.tcxo, at: now };
      return addLog(f, { at: now, kind: 'base', text: `Base station ready: ${(ev.freq / 1e6).toFixed(1)} MHz, SF${ev.sf}/${ev.bw} kHz, ${ev.power} dBm` });
    case 'info':
      if (f.base && ev.power !== undefined) f.base.power = ev.power;
      return addLog(f, { at: now, kind: 'base', text: `Base power ${ev.power} dBm` });
    case 'status': {
      const b = f.balls[ev.ball] || (f.balls[ev.ball] = { id: ev.ball, trail: [], reports: 0 });
      b.reports++;
      b.at = now;
      b.batt = ev.batt; b.lowBatt = !!ev.low_batt; b.lid = ev.lid; b.stage = ev.stage;
      b.heading = ev.heading; b.rssi = ev.rssi; b.snr = ev.snr; b.fix = !!ev.fix;
      if (ev.fix && Number.isFinite(ev.lat) && Number.isFinite(ev.lon)) {
        b.lat = ev.lat; b.lon = ev.lon; b.fixAt = now;
        const last = b.trail[b.trail.length - 1];
        if (!last || last.lat !== ev.lat || last.lon !== ev.lon) {
          b.trail.push({ lat: ev.lat, lon: ev.lon, at: now });
          if (b.trail.length > TRAIL_MAX) b.trail.shift();
        }
      }
      return null;                                  // statuses update the table, not the log
    }
    case 'checkin':
      return addLog(f, { at: now, kind: 'checkin', ball: ev.ball, text: `Checked in at station ${ev.station} (tag ${ev.uid})` });
    case 'sent': {
      const key = `${ev.to}:${ev.seq}`;
      const what = ev.type === 'msg' ? 'Message' : ev.type === 'ping' ? 'Ping' : 'Command';
      const entry = addLog(f, { at: now, kind: 'sent', ball: ev.to === 255 ? 'all' : ev.to, text: `${what} sent`,
        state: ev.ok ? (ev.to === 255 || ev.type === 'ping' ? 'sent' : 'waiting') : 'failed', key });
      if (ev.ok && ev.to !== 255 && ev.type !== 'ping') f.sends[key] = entry;
      return entry;
    }
    case 'ack': {
      const key = `${ev.ball}:${ev.ack_seq}`;
      const s = f.sends[key];
      if (s) { s.state = ev.ok ? 'delivered' : 'refused'; delete f.sends[key]; }
      const b = f.balls[ev.ball];
      if (b) { b.at = now; b.rssi = ev.rssi; b.snr = ev.snr; }
      return null;
    }
    case 'timeout': {
      const key = `${ev.to}:${ev.seq}`;
      const s = f.sends[key];
      if (s) { s.state = 'no answer'; delete f.sends[key]; }
      return null;
    }
    case 'update': {
      const b = f.balls[ev.ball] || (f.balls[ev.ball] = { id: ev.ball, trail: [], reports: 0 });
      b.at = now; b.rssi = ev.rssi; b.snr = ev.snr;
      b.update = { state: ev.state, done: ev.done, total: ev.total, detail: ev.detail, error: ev.error, version: ev.version, at: now };
      if (ev.version) b.version = ev.version;
      const text = updateText(b.update);
      // progress lines update the table; the start and the outcome go in the log too
      if (['wifi', 'done', 'current', 'failed', 'reboot'].includes(ev.state)) {
        return addLog(f, { at: now, kind: ev.state === 'failed' ? 'error' : 'update', ball: ev.ball, text });
      }
      return null;
    }
    case 'error':
      return addLog(f, { at: now, kind: 'error', text: ev.msg || 'Base station error' });
    default:
      return null;
  }
}

/** A ball's Wi-Fi update progress in words. */
export function updateText(u) {
  if (!u) return '';
  switch (u.state) {
    case 'wifi': return 'Update: joining Wi-Fi';
    case 'check': return 'Update: asking the Manager';
    case 'files': return `Update: files ${u.done}/${u.total}`;
    case 'firmware': return `Update: firmware ${u.detail}%`;
    case 'reboot': return `Update: firmware ${u.version} installed, restarting`;
    case 'done': return `Updated: ${u.done} file${u.done === 1 ? '' : 's'}${u.version ? `, firmware ${u.version}` : ''}`;
    case 'current': return `Already up to date${u.version ? ` (firmware ${u.version})` : ''}`;
    case 'failed': return `Update failed: ${u.error || 'unknown reason'}`;
    default: return `Update: ${u.state}`;
  }
}

/** Attach a description to a sent log entry (what the leader typed). */
export function describeSend(kind, extra = {}) {
  if (kind === 'msg') return `Message: "${extra.text}"`;
  if (kind === 'stage') return `Jump to step ${extra.stage}`;
  if (kind === 'ping') return 'Ping';
  if (kind === 'update') return 'Update over Wi-Fi';
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

/** How fresh a ball's last report is: 'ok' | 'stale' | 'lost'. */
export function freshness(b, now = Date.now()) {
  if (!b?.at) return 'lost';
  const age = (now - b.at) / 1000;
  return age > LOST_S ? 'lost' : age > STALE_S ? 'stale' : 'ok';
}

export function ago(ms, now = Date.now()) {
  if (!ms) return 'never';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s ago`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
}

/** Signal quality from SNR (LoRa at SF10 decodes down to about -15 dB). */
export function signal(snr) {
  if (!Number.isFinite(snr)) return { bars: 0, label: '—' };
  const bars = snr >= 5 ? 4 : snr >= 0 ? 3 : snr >= -6 ? 2 : snr >= -11 ? 1 : 0;
  return { bars, label: ['edge', 'weak', 'fair', 'good', 'strong'][bars] };
}

/**
 * Fit lat/lon points into a width x height box, north up, with equal metres on both axes.
 * Returns { project(lat, lon) -> [x, y], metresPerPx } or null if there are no points.
 */
export function fitPlot(points, width, height, pad = 30) {
  const pts = points.filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (!pts.length) return null;
  const lat0 = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
  const mPerLat = 111320, mPerLon = 111320 * Math.cos(lat0 * Math.PI / 180);
  const xy = pts.map(p => [p.lon * mPerLon, p.lat * mPerLat]);
  const minX = Math.min(...xy.map(v => v[0])), maxX = Math.max(...xy.map(v => v[0]));
  const minY = Math.min(...xy.map(v => v[1])), maxY = Math.max(...xy.map(v => v[1]));
  const spanX = Math.max(maxX - minX, 50), spanY = Math.max(maxY - minY, 50);   // at least 50 m across
  const metresPerPx = Math.max(spanX / (width - 2 * pad), spanY / (height - 2 * pad));
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  return {
    metresPerPx,
    project(lat, lon) {
      const x = lon * mPerLon, y = lat * mPerLat;
      return [width / 2 + (x - cx) / metresPerPx, height / 2 - (y - cy) / metresPerPx];
    }
  };
}

/** A round scale-bar length (m) about a fifth of the plot width. */
export function scaleBar(metresPerPx, width) {
  const target = metresPerPx * width / 5;
  const steps = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
  const m = steps.find(s => s >= target) || steps[steps.length - 1];
  return { metres: m, px: m / metresPerPx, label: m >= 1000 ? `${m / 1000} km` : `${m} m` };
}
