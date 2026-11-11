// Storage for the manager's files (the data file and Journey YAML).
//
// The laptop keeps real files in the data folder (LocalVfs). The cloud keeps
// the same files inside one JSON document in S3, loaded per request into a
// MemoryVfs; whatever changed is written back as a whole (see lib/cloud/).
// Both expose the same small synchronous API, so Store and JourneyStore don't
// care where they run.

import fs from 'node:fs';
import path from 'node:path';

const safe = (rel) => {
  const r = String(rel).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!r || r.split('/').some(p => p === '..' || p === '')) throw new Error(`Bad file path "${rel}"`);
  return r;
};

export class LocalVfs {
  constructor(root) {
    this.root = root;
    this.kind = 'local';
    fs.mkdirSync(root, { recursive: true });
  }
  abs(rel) { return path.join(this.root, safe(rel)); }
  exists(rel) { return fs.existsSync(this.abs(rel)); }
  read(rel) { return fs.readFileSync(this.abs(rel), 'utf8'); }
  mtime(rel) { return fs.statSync(this.abs(rel)).mtime.toISOString(); }
  write(rel, text) {
    const f = this.abs(rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, f);
  }
  remove(rel) { if (this.exists(rel)) fs.unlinkSync(this.abs(rel)); }
  rename(from, to) {
    const t = this.abs(to);
    fs.mkdirSync(path.dirname(t), { recursive: true });
    fs.renameSync(this.abs(from), t);
  }
  /** File names (not paths) directly inside a folder. */
  list(dir) {
    try { return fs.readdirSync(this.abs(dir), { withFileTypes: true }).filter(d => d.isFile()).map(d => d.name).sort(); }
    catch { return []; }
  }
  /** Every file under the root as {path: text}, for the camp upload. Skips backups. */
  snapshot() {
    const out = {};
    const walk = (rel) => {
      const dir = rel ? this.abs(rel) : this.root;
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        const r = rel ? `${rel}/${d.name}` : d.name;
        if (d.isDirectory()) { if (!['backups', 'media'].includes(r)) walk(r); }
        else if (/\.(json|yaml)$/.test(d.name)) out[r] = fs.readFileSync(path.join(dir, d.name), 'utf8');
      }
    };
    walk('');
    return out;
  }
  get supportsBackups() { return true; }
}

export class MemoryVfs {
  /** files: {path: {text, mtime}} */
  constructor(files = {}) {
    this.files = {};
    for (const [k, v] of Object.entries(files)) this.files[safe(k)] = typeof v === 'string' ? { text: v, mtime: new Date().toISOString() } : { ...v };
    this.kind = 'memory';
    this.dirty = false;
  }
  exists(rel) { return safe(rel) in this.files; }
  read(rel) {
    const f = this.files[safe(rel)];
    if (!f) { const e = new Error(`ENOENT: ${rel}`); e.code = 'ENOENT'; throw e; }
    return f.text;
  }
  mtime(rel) { return this.files[safe(rel)]?.mtime || new Date(0).toISOString(); }
  write(rel, text) { this.files[safe(rel)] = { text: String(text), mtime: new Date().toISOString() }; this.dirty = true; }
  remove(rel) { if (delete this.files[safe(rel)]) this.dirty = true; }
  rename(from, to) { this.files[safe(to)] = this.files[safe(from)]; delete this.files[safe(from)]; this.dirty = true; }
  list(dir) {
    const prefix = `${safe(dir)}/`;
    return Object.keys(this.files).filter(k => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
      .map(k => k.slice(prefix.length)).sort();
  }
  snapshot() { return Object.fromEntries(Object.entries(this.files).map(([k, v]) => [k, v.text])); }
  /** Cloud history comes from S3 versioning, so no backup copies inside the document. */
  get supportsBackups() { return false; }
}

/**
 * Media files for Journeys. The laptop lists a folder on disk; the cloud keeps
 * an index (folder -> file names) because the files themselves live in S3.
 */
export class LocalMedia {
  constructor(root) { this.root = root; this.kind = 'local'; fs.mkdirSync(root, { recursive: true }); }
  folder(name) { return path.join(this.root, String(name).replace(/[\\/]+/g, '-')); }
  files(name) { try { return fs.readdirSync(this.folder(name)).filter(f => !f.startsWith('.')).sort(); } catch { return []; } }
  index() {
    const out = {};
    try { for (const d of fs.readdirSync(this.root, { withFileTypes: true })) if (d.isDirectory()) out[d.name] = this.files(d.name); } catch { /* none */ }
    return out;
  }
}

export class IndexMedia {
  constructor(index = {}) { this.idx = index; this.kind = 'index'; this.dirty = false; }
  folderName(name) { return String(name).replace(/[\\/]+/g, '-'); }
  folder(name) { return `media/${this.folderName(name)}`; }
  files(name) { return [...(this.idx[this.folderName(name)] || [])].sort(); }
  add(name, file) {
    const k = this.folderName(name);
    const set = new Set(this.idx[k] || []);
    set.add(file);
    this.idx[k] = [...set].sort();
    this.dirty = true;
  }
  remove(name, file) {
    const k = this.folderName(name);
    this.idx[k] = (this.idx[k] || []).filter(f => f !== file);
    if (!this.idx[k].length) delete this.idx[k];
    this.dirty = true;
  }
  index() { return JSON.parse(JSON.stringify(this.idx)); }
}
