// Over-the-air updates for the balls.
//
// A ball joins Wi-Fi (liahona/wifi.json on its SD card), asks the Manager for its
// package, downloads whatever changed into liahona/ on the SD card, and installs new
// firmware into its spare app slot. The Manager side is here:
//
//   settings.ball = { journeyId, key, firmware: { name, version, sha256, size, at } }
//
//   GET /api/ball/package?ball=N&key=K   manifest (ball key, no sign-in)
//   GET /api/ball/file/journey.json      the compiled Ball file for settings.ball.journeyId
//   GET /api/ball/file/roster.json       the ball roster
//   media + firmware URLs come from the storage: presigned S3 links in the cloud,
//   /api/ball/media/... on the laptop (served by server.js).
//
// Rev strings let the ball skip files it already has: sha256 for the generated JSON,
// the S3 ETag (cloud) or size + mtime (laptop) for media.

import crypto from 'node:crypto';
import { HttpError } from './store.js';

export const FIRMWARE_FOLDER = '_firmware';
export const LOG_FOLDER = '_ball-logs';
const LOG_MAX = 64 * 1024;          // bytes of text kept per upload
const LOG_KEEP = 60;                // newest entries listed
const FIRMWARE_MAX = 8 * 1024 * 1024;

export function ballSettings(store) {
  const s = store.db.settings;
  s.ball ||= { journeyId: null, key: null, firmware: null };
  return s.ball;
}

/** What the Settings page shows. Only admins see the key itself. */
export function ballView(store, user) {
  const b = ballSettings(store);
  return { journeyId: b.journeyId, firmware: b.firmware, hasKey: !!b.key, key: user.can('admin') ? b.key : undefined, logs: b.logs || [] };
}

export function setBallJourney(store, journeys, journeyId) {
  const b = ballSettings(store);
  if (journeyId) {
    if (!journeys.list().some(j => j.id === journeyId)) throw new HttpError(404, 'No such Journey');
    journeys.compiled(journeyId);           // throws 409 if it has errors
  }
  b.journeyId = journeyId || null;
  store.save();
  return b;
}

export function newBallKey(store) {
  const b = ballSettings(store);
  b.key = crypto.randomBytes(18).toString('base64url');
  store.save();
  return b.key;
}

export function checkBallKey(store, key) {
  const b = ballSettings(store);
  const k = String(key || '');
  if (!b.key || k.length !== b.key.length || !crypto.timingSafeEqual(Buffer.from(k), Buffer.from(b.key))) {
    throw new HttpError(401, 'Ball key not accepted');
  }
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * The version string inside an ESP-IDF app image (esp_app_desc_t.version): the image
 * header (24 bytes) and first segment header (8) come first, then the descriptor,
 * whose magic word is 0xABCD5432 and whose version field starts 16 bytes in.
 */
export function firmwareInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 32 + 256) throw new HttpError(400, 'That file is too small to be ball firmware');
  if (buf[0] !== 0xE9) throw new HttpError(400, 'That isn\'t an ESP32 firmware image (use build/liahona_fw.bin)');
  if (buf.readUInt32LE(32) !== 0xABCD5432) throw new HttpError(400, 'No app description in that image (use build/liahona_fw.bin, not the bootloader)');
  const version = buf.subarray(48, 80).toString('latin1').replace(/\0.*$/s, '');
  const project = buf.subarray(80, 112).toString('latin1').replace(/\0.*$/s, '');
  return { version, project, sha256: sha256(buf), size: buf.length };
}

/**
 * Save uploaded firmware. put(folder, name, buffer) stores it (S3 or the laptop's
 * media folder). The previous build stays in storage, but only the newest is offered.
 */
export async function saveFirmware(store, put, { name, data }) {
  const buf = Buffer.from(String(data || ''), 'base64');
  if (buf.length > FIRMWARE_MAX) throw new HttpError(413, 'Firmware is over 8 MB');
  const info = firmwareInfo(buf);
  if (info.project && info.project !== 'liahona_fw') throw new HttpError(400, `That's firmware for "${info.project}", not the ball (liahona_fw)`);
  const file = `liahona_fw-${info.version.replace(/[^\w.-]+/g, '_') || 'build'}-${info.sha256.slice(0, 8)}.bin`;
  await put(FIRMWARE_FOLDER, file, buf);
  const b = ballSettings(store);
  b.firmware = { name: file, original: String(name || '').slice(0, 120), version: info.version, sha256: info.sha256, size: info.size, at: new Date().toISOString() };
  store.save();
  return b.firmware;
}

export function clearFirmware(store) {
  ballSettings(store).firmware = null;
  store.save();
  return { ok: true };
}

/**
 * The two generated files a ball needs: { name: { text, rev } }. The rev ignores the
 * compile time, so a ball only re-downloads when the content changes.
 */
export function ballFiles(store, journeys) {
  const b = ballSettings(store);
  const file = (obj) => {
    const { compiledAt: _t, ...stable } = obj;
    return { text: JSON.stringify(obj, null, 1), rev: sha256(Buffer.from(JSON.stringify(stable))).slice(0, 16) };
  };
  const out = { 'roster.json': file(store.ballRoster()) };
  if (b.journeyId) out['journey.json'] = file(journeys.compiled(b.journeyId));
  return out;
}

/**
 * Build the manifest. links = {
 *   media(folder, name)  -> url (absolute, or a path the ball resolves against the Manager)
 *   rev(folder, name)    -> string that changes when the file does ('' if unknown)
 *   size(folder, name)?  -> bytes, if known
 * }
 */
export async function ballPackage(store, journeys, links, { key, ball } = {}) {
  checkBallKey(store, key);
  const b = ballSettings(store);
  const q = `?key=${encodeURIComponent(key)}${ball ? `&ball=${encodeURIComponent(ball)}` : ''}`;
  const files = [];
  const gen = ballFiles(store, journeys);
  for (const [name, f] of Object.entries(gen)) {
    files.push({ path: name, url: `/api/ball/file/${name}${q}`, rev: f.rev, size: Buffer.byteLength(f.text) });
  }
  let journeyTitle = null;
  if (b.journeyId) {
    const { journey } = journeys.read(b.journeyId);
    journeyTitle = journey.title || b.journeyId;
    if (journey.media && typeof journey.media === 'string') {
      for (const name of journeys.mediaFiles(journey)) {
        if (!/\.(mp3|wav|jpe?g)$/i.test(name)) continue;    // the ball plays MP3 / 16-bit WAV and shows JPEG
        const rev = await links.rev(journey.media, name);
        const size = links.size ? await links.size(journey.media, name) : undefined;
        files.push({ path: `media/${name}`, url: await links.media(journey.media, name, q), rev: rev || name, ...(size != null ? { size } : {}) });
      }
    }
  }
  let firmware = null;
  if (b.firmware) {
    firmware = { version: b.firmware.version, sha256: b.firmware.sha256, size: b.firmware.size,
      url: await links.media(FIRMWARE_FOLDER, b.firmware.name, q) };
  }
  return { manifest: 1, journey: b.journeyId, journeyTitle, generated: new Date().toISOString(), files, firmware };
}

/**
 * A ball uploads a log (POST /api/ball/log?key&ball, body { name, reason, text }).
 * Crash logs keep their own file; "now.txt" (a snapshot of the current run)
 * replaces the ball's previous snapshot.
 */
export async function saveBallLog(store, put, { key, ball } = {}, body = {}) {
  checkBallKey(store, key);
  const id = Number.parseInt(ball, 10);
  if (!Number.isInteger(id) || id < 0 || id > 999) throw new HttpError(400, 'Bad ball number');
  const name = String(body.name || 'log.txt').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
  const text = String(body.text || '').slice(-LOG_MAX);
  const file = `ball-${id}-${name}`;
  await put(LOG_FOLDER, file, Buffer.from(text, 'utf8'));
  const b = ballSettings(store);
  const entry = { file, ball: id, name, reason: String(body.reason || '').slice(0, 30), size: Buffer.byteLength(text), at: new Date().toISOString(),
    crash: name !== 'now.txt' };
  b.logs = [entry, ...(b.logs || []).filter(l => l.file !== file)].slice(0, LOG_KEEP);
  store.save();
  return { ok: true };
}

/** A link a signed-in planner can open to read one ball log. */
export async function ballLogLink(store, links, file) {
  const b = ballSettings(store);
  if (!(b.logs || []).some(l => l.file === file)) throw new HttpError(404, 'No such log');
  return { url: await links.media(LOG_FOLDER, file, `?key=${encodeURIComponent(b.key || '')}`) };
}
