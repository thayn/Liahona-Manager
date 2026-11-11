// Journey files: one YAML file per Journey in <data>/journeys/<id>.yaml.
// Media for a Journey lives in <data>/media/<journey.media>/ on the laptop, or
// in the media bucket in the cloud. Files go through lib/vfs.js.

import path from 'node:path';
import { LocalVfs, LocalMedia } from './vfs.js';
import yaml from '../public/vendor/js-yaml.mjs';
import { validateJourney, compileJourney, newJourney, slugify } from '../public/shared/journey.js';
import { HttpError } from './store.js';

const YAML_OPTS = { lineWidth: 100, noRefs: true, flowLevel: -1 };

export function parseYaml(text) {
  try {
    const obj = yaml.load(text);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('expected id, title and stages at the top');
    return obj;
  } catch (e) {
    const where = e.mark ? ` (line ${e.mark.line + 1})` : '';
    throw new HttpError(400, `That isn't valid Journey YAML${where}: ${e.reason || e.message}`);
  }
}

export function toYaml(j) {
  // Keep a readable key order at the top of the file.
  const order = ['id', 'title', 'description', 'penalties', 'hint_after', 'media', 'stages', 'routes'];
  const sorted = {};
  for (const k of order) if (k in j) sorted[k] = j[k];
  for (const k of Object.keys(j)) if (!(k in sorted)) sorted[k] = j[k];
  return yaml.dump(sorted, YAML_OPTS);
}

export class JourneyStore {
  /**
   * new JourneyStore(dataDir, store)                   laptop: folders on disk
   * new JourneyStore({ vfs, media }, store)            any storage from lib/vfs.js
   */
  constructor(where, store) {
    if (typeof where === 'string') {
      this.vfs = new LocalVfs(where);
      this.media = new LocalMedia(path.join(where, 'media'));
    } else {
      this.vfs = where.vfs;
      this.media = where.media;
    }
    this.dir = this.vfs.abs ? this.vfs.abs('journeys') : 'journeys';
    this.mediaRoot = this.media.root || 'media';
    this.store = store;
  }

  file(id) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id || '')) throw new HttpError(400, 'Bad Journey ID');
    return `journeys/${id}.yaml`;
  }

  exists(id) { return this.vfs.exists(this.file(id)); }

  read(id) {
    const f = this.file(id);
    if (!this.vfs.exists(f)) throw new HttpError(404, `No Journey "${id}"`);
    const text = this.vfs.read(f);
    return { journey: parseYaml(text), yaml: text, modified: this.vfs.mtime(f) };
  }

  mediaFiles(j) {
    if (!j?.media || typeof j.media !== 'string') return new Set();
    return new Set(this.media.files(j.media));
  }

  context(j) {
    return { places: this.store.placeMap(), teams: this.store.db.teams.map(t => t.name), mediaFiles: this.mediaFiles(j) };
  }

  check(j) {
    const issues = validateJourney(j, this.context(j));
    return { issues, errors: issues.filter(i => i.level === 'error').length, warnings: issues.filter(i => i.level === 'warning').length };
  }

  list() {
    const out = [];
    for (const name of this.vfs.list('journeys').filter(f => f.endsWith('.yaml'))) {
      const id = name.slice(0, -5);
      try {
        const { journey, modified } = this.read(id);
        const c = this.check(journey);
        out.push({ id, title: journey.title || id, description: journey.description || '', stages: journey.stages?.length || 0,
          errors: c.errors, warnings: c.warnings, modified });
      } catch (e) {
        out.push({ id, title: id, stages: 0, errors: 1, warnings: 0, broken: e.message });
      }
    }
    return out;
  }

  get(id) {
    const r = this.read(id);
    return { ...r, ...this.check(r.journey), file: this.vfs.abs ? this.vfs.abs(this.file(id)) : this.file(id),
      mediaFiles: [...this.mediaFiles(r.journey)].sort(),
      mediaFolder: r.journey.media ? this.media.folder(String(r.journey.media)) : null };
  }

  /**
   * Save a Journey. `previousId` is the ID it was opened under, so renaming the
   * ID renames the file. Saving with errors is allowed (work in progress);
   * the errors come back to show in the designer.
   */
  save(j, { previousId, overwrite = true } = {}) {
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new HttpError(400, 'Nothing to save');
    if (!j.id || !/^[a-z0-9][a-z0-9-]*$/.test(j.id)) throw new HttpError(400, 'The Journey ID must be lowercase letters, numbers and dashes before it can be saved');
    const target = this.file(j.id);
    const renaming = previousId && previousId !== j.id;
    if ((renaming || !overwrite) && this.vfs.exists(target)) throw new HttpError(409, `A Journey with ID "${j.id}" already exists`);
    this.vfs.write(target, toYaml(j));
    if (renaming && this.exists(previousId)) this.vfs.remove(this.file(previousId));
    return this.get(j.id);
  }

  create(title) {
    const j = newJourney(title || 'New Journey');
    j.id = this.freeId(j.id);
    return this.save(j, { overwrite: false });
  }

  importYaml(text, { replace = false } = {}) {
    const j = parseYaml(text);
    const originalId = j.id;
    if (!j.id || !/^[a-z0-9][a-z0-9-]*$/.test(j.id)) j.id = slugify(j.title) || 'imported-journey';
    if (!replace) j.id = this.freeId(j.id);
    if (j.id === originalId) {
      // ID unchanged: keep the file exactly as written, comments included.
      this.vfs.write(this.file(j.id), text.endsWith('\n') ? text : `${text}\n`);
      return this.get(j.id);
    }
    return this.save(j, { overwrite: replace });
  }

  duplicate(id) {
    const { journey } = this.read(id);
    journey.id = this.freeId(`${id}-copy`);
    journey.title = `${journey.title} (copy)`;
    return this.save(journey, { overwrite: false });
  }

  remove(id) {
    const f = this.file(id);
    if (!this.vfs.exists(f)) throw new HttpError(404, `No Journey "${id}"`);
    if (this.vfs.supportsBackups) {
      const stamp = new Date().toLocaleString('sv-SE').replace(/[: ]/g, '-');
      this.vfs.rename(f, `backups/deleted-journeys/${id}-${stamp}.yaml`);
    } else {
      this.vfs.remove(f);   // cloud: earlier versions stay in S3 history
    }
  }

  freeId(base) {
    const b = (base || 'journey').slice(0, 44);
    if (!this.exists(b)) return b;
    for (let i = 2; ; i++) if (!this.exists(`${b}-${i}`)) return `${b}-${i}`;
  }

  compiled(id) {
    const { journey } = this.read(id);
    const c = this.check(journey);
    if (c.errors) throw new HttpError(409, `Fix the ${c.errors} error${c.errors > 1 ? 's' : ''} in this Journey first`);
    return compileJourney(journey, this.context(journey));
  }

  /** Place keys reached by written directions in any Journey (so: indoors, tag-only). */
  directionsPlaces() {
    const keys = new Set();
    for (const { id } of this.list()) {
      try {
        for (const s of this.read(id).journey.stages || []) {
          for (const tr of [s?.travel, ...(s?.tasks || []).map(t => t?.travel)]) if (tr?.mode === 'directions' && tr.to) keys.add(tr.to);
        }
      } catch { /* skip broken files */ }
    }
    return keys;
  }

  /** Every place key used by any Journey, with which Journeys use it. */
  placeUsage() {
    const usage = {};
    for (const { id } of this.list()) {
      try {
        const { journey } = this.read(id);
        for (const s of journey.stages || []) {
          const keys = new Set();
          if (s?.travel?.to) keys.add(s.travel.to);
          for (const t of s?.tasks || []) {
            if (t?.travel?.to) keys.add(t.travel.to);
            for (const k of [...(t?.tags || []), ...(t?.decoys || [])]) keys.add(k);
          }
          for (const k of keys) (usage[k] ||= new Set()).add(journey.title || id);
        }
      } catch { /* broken file shows in list() */ }
    }
    return Object.fromEntries(Object.entries(usage).map(([k, v]) => [k, [...v]]));
  }
}
