// Moving the manager between the cloud and the camp laptop.
//
//   Download for camp (laptop)  -> cloud /api/camp/checkout
//       The cloud copy is locked (read-only) and the laptop gets every file
//       and the Journey media. The laptop is now the copy everyone edits.
//   Upload after camp (laptop)  -> cloud /api/camp/media-urls, /api/camp/checkin
//       The laptop's files become the cloud copy again (earlier versions stay
//       in S3 history), new media goes up, and the lock is lifted. Sign-ups
//       that arrived in the cloud while the laptop had it are kept.
//
// The laptop proves who it is with a sync key an Admin creates in the cloud
// (Settings -> Camp laptop). Keys are stored hashed and expire.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpError } from './store.js';

/** Which files travel between cloud and laptop. Never local-auth.json or camp-link.json. */
export const isWorkspaceFile = (p) => p === 'liahona.json' || /^journeys\/[a-z0-9][a-z0-9-]*\.yaml$/.test(p);

export const pickWorkspace = (files) => Object.fromEntries(Object.entries(files).filter(([k]) => isWorkspaceFile(k)));

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const KEY_DAYS = 30;

// ===================================================================== cloud

/** Cloud-side camp operations on the S3 workspace document. */
export const cloudCamp = {
  createKey(doc, user, label = '') {
    const key = `lhk_${crypto.randomBytes(24).toString('base64url')}`;
    const rec = { id: crypto.randomBytes(4).toString('hex'), hash: sha(key), label: String(label).slice(0, 60),
      createdBy: user.email, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + KEY_DAYS * 86400000).toISOString() };
    doc.meta.syncKeys = [...(doc.meta.syncKeys || []).filter(k => new Date(k.expiresAt) > new Date()), rec];
    return { key, id: rec.id, expiresAt: rec.expiresAt };
  },

  keyUser(doc, key) {
    if (!key) return null;
    const h = sha(key);
    const rec = (doc.meta.syncKeys || []).find(k => k.hash === h);
    if (!rec || new Date(rec.expiresAt) < new Date()) return null;
    return rec;
  },

  status(doc) {
    return {
      lock: doc.meta.lock || null,
      keys: (doc.meta.syncKeys || []).map(({ hash: _h, ...k }) => ({ ...k, expired: new Date(k.expiresAt) < new Date() }))
    };
  },

  /** Lock the cloud copy and hand everything to the laptop. presignGet(folder, name) -> url */
  async checkout(doc, keyRec, { force = false, laptop = '' } = {}, presignGet) {
    if (doc.meta.lock && !force) {
      throw new HttpError(409, `Already checked out to ${doc.meta.lock.laptop || 'a laptop'} since ${doc.meta.lock.at}. Upload from that laptop first, or download again with "take over".`, { lock: doc.meta.lock });
    }
    const lock = { id: crypto.randomBytes(8).toString('hex'), at: new Date().toISOString(), by: keyRec.createdBy,
      key: keyRec.id, laptop: String(laptop).slice(0, 60) };
    doc.meta.lock = lock;
    const files = pickWorkspace(Object.fromEntries(Object.entries(doc.files).map(([k, v]) => [k, v.text])));
    const media = [];
    for (const [folder, names] of Object.entries(doc.media || {})) {
      for (const name of names) media.push({ folder, name, url: await presignGet(folder, name) });
    }
    return { lockId: lock.id, lockedAt: lock.at, files, media };
  },

  /** Signed upload links for media the cloud doesn't have yet. presignPut(folder, name) -> url */
  async mediaUrls(doc, wanted, presignPut) {
    const have = doc.media || {};
    const out = [];
    for (const { folder, name } of (wanted || []).slice(0, 2000)) {
      if (!/^[^/\\]+$/.test(folder || '') || !/^[^/\\]+$/.test(name || '') || name.startsWith('.')) continue;
      if ((have[folder] || []).includes(name)) continue;
      out.push({ folder, name, url: await presignPut(folder, name) });
    }
    return { uploads: out };
  },

  /** The laptop's copy becomes the cloud copy; the lock is lifted. */
  checkin(doc, { lockId, files, media }, { force = false } = {}) {
    const lock = doc.meta.lock;
    if (!lock && !force) throw new HttpError(409, 'The cloud copy isn\'t checked out, so there\'s nothing to upload into. Download for camp first.');
    if (lock && lock.id !== lockId && !force) throw new HttpError(409, 'This laptop no longer holds the camp copy (someone downloaded it again since). Ask an Admin before overwriting.');
    const incoming = pickWorkspace(files || {});
    if (!incoming['liahona.json']) throw new HttpError(400, 'Upload is missing the data file');
    let db;
    try { db = JSON.parse(incoming['liahona.json']); } catch { throw new HttpError(400, 'Upload data file is damaged'); }

    // Keep sign-ups that reached the cloud while the laptop had the data.
    let kept = 0;
    const cloudDb = doc.files['liahona.json'] ? JSON.parse(doc.files['liahona.json'].text) : { registrations: [] };
    const since = lock?.at || '0';
    const ids = new Set((db.registrations || []).map(r => r.id));
    for (const r of cloudDb.registrations || []) {
      if (r.submittedAt > since && !ids.has(r.id)) { (db.registrations ||= []).push(r); kept++; }
    }
    incoming['liahona.json'] = JSON.stringify(db, null, 2);

    const nowIso = new Date().toISOString();
    const next = {};
    for (const [k, v] of Object.entries(doc.files)) if (!isWorkspaceFile(k)) next[k] = v;
    for (const [k, text] of Object.entries(incoming)) next[k] = { text, mtime: nowIso };
    doc.files = next;
    // Media: anything the laptop has that was uploaded, plus what the cloud had.
    const merged = { ...(doc.media || {}) };
    for (const [folder, names] of Object.entries(media || {})) merged[folder] = [...new Set([...(merged[folder] || []), ...names])].sort();
    doc.media = merged;
    doc.meta.lock = null;
    doc.meta.lastCheckin = { at: nowIso, lockId: lockId || null, keptSignups: kept };
    return { ok: true, keptSignups: kept, journeys: Object.keys(incoming).filter(k => k.startsWith('journeys/')).length };
  }
};

// ==================================================================== laptop

/** Laptop-side link to the cloud, saved in camp-link.json (never uploaded). */
export class CampLink {
  constructor(vfs, file = 'camp-link.json') {
    this.vfs = vfs;
    this.file = file;
    this.cfg = vfs.exists(file) ? JSON.parse(vfs.read(file)) : {};
  }
  save() { this.vfs.write(this.file, JSON.stringify(this.cfg, null, 2)); }
  status() {
    const { key, ...rest } = this.cfg;
    return { ...rest, hasKey: !!key };
  }
  set({ cloudUrl, key }) {
    if (cloudUrl !== undefined) {
      const u = String(cloudUrl).trim().replace(/\/+$/, '');
      if (u && !/^https?:\/\/[^\s]+$/.test(u)) throw new HttpError(400, 'Paste the full cloud address, starting with https://');
      this.cfg.cloudUrl = u;
    }
    if (key !== undefined && String(key).trim()) {
      if (!/^lhk_[A-Za-z0-9_-]{20,}$/.test(String(key).trim())) throw new HttpError(400, 'That doesn\'t look like a sync key (they start with lhk_)');
      this.cfg.key = String(key).trim();
    }
    this.save();
    return this.status();
  }

  async call(pathname, body, fetchImpl = fetch) {
    if (!this.cfg.cloudUrl || !this.cfg.key) throw new HttpError(400, 'Set the cloud address and sync key first');
    let res;
    try {
      res = await fetchImpl(`${this.cfg.cloudUrl}${pathname}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Liahona-Sync-Key': this.cfg.key },
        body: JSON.stringify(body || {})
      });
    } catch (e) {
      throw new HttpError(502, `Couldn't reach the cloud (${e.cause?.code || e.message}). Check the internet connection.`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new HttpError(res.status, data.error || `Cloud said ${res.status}`, data);
    return data;
  }

  /**
   * Download for camp. `vfs` is the laptop data folder, `mediaRoot` the media folder.
   * Keeps a backup of what was on the laptop first.
   */
  async download({ vfs, mediaRoot, force = false, laptop = '' }, fetchImpl = fetch) {
    const r = await this.call('/api/camp/checkout', { force, laptop }, fetchImpl);
    // Back up the laptop's current files before replacing them.
    const stamp = new Date().toLocaleString('sv-SE').replace(/[: ]/g, '-');
    const before = pickWorkspace(vfs.snapshot());
    for (const [k, text] of Object.entries(before)) vfs.write(`backups/before-camp-download-${stamp}/${k}`, text);
    for (const k of Object.keys(before)) if (!(k in r.files)) vfs.remove(k);
    for (const [k, text] of Object.entries(r.files)) vfs.write(k, text);

    let fetched = 0, skipped = 0;
    const failed = [];
    for (const m of r.media) {
      const dir = path.join(mediaRoot, m.folder);
      const file = path.join(dir, m.name);
      if (fs.existsSync(file)) { skipped++; continue; }
      try {
        fs.mkdirSync(dir, { recursive: true });
        const res = await fetchImpl(m.url);
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(`${file}.part`));
        fs.renameSync(`${file}.part`, file);
        fetched++;
      } catch (e) {
        failed.push(`${m.folder}/${m.name}: ${e.message}`);
      }
    }
    this.cfg.lockId = r.lockId;
    this.cfg.checkedOutAt = r.lockedAt;
    this.save();
    return { files: Object.keys(r.files).length, mediaFetched: fetched, mediaAlreadyHere: skipped, mediaFailed: failed,
      backup: `backups/before-camp-download-${stamp}` };
  }

  /** Upload after camp: media first, then the data (which lifts the lock). */
  async upload({ vfs, mediaIndex, mediaRoot, force = false }, fetchImpl = fetch) {
    if (!this.cfg.lockId && !force) throw new HttpError(409, 'This laptop hasn\'t downloaded the camp copy, so there\'s nothing to upload.');
    const wanted = [];
    for (const [folder, names] of Object.entries(mediaIndex)) for (const name of names) wanted.push({ folder, name });
    const { uploads } = await this.call('/api/camp/media-urls', { files: wanted }, fetchImpl);
    const failed = [];
    for (const u of uploads) {
      try {
        const buf = fs.readFileSync(path.join(mediaRoot, u.folder, u.name));
        const res = await fetchImpl(u.url, { method: 'PUT', body: buf });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (e) { failed.push(`${u.folder}/${u.name}: ${e.message}`); }
    }
    const okIndex = {};
    const failedSet = new Set(failed.map(f => f.split(':')[0]));
    for (const [folder, names] of Object.entries(mediaIndex)) okIndex[folder] = names.filter(n => !failedSet.has(`${folder}/${n}`));
    const r = await this.call('/api/camp/checkin', { lockId: this.cfg.lockId, files: pickWorkspace(vfs.snapshot()), media: okIndex, force }, fetchImpl);
    this.cfg.lockId = null;
    this.cfg.lastUploadAt = new Date().toISOString();
    this.save();
    return { ...r, mediaUploaded: uploads.length - failed.length, mediaFailed: failed };
  }
}
