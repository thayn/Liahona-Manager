// Cloud request handling, free of AWS SDK imports so it can be tested with
// fakes. lib/cloud/lambda.js wires in the real S3 and Cognito clients.
//
// The whole manager lives in one S3 object (the "workspace document"):
//   { version, files: {path: {text, mtime}}, media: {folder: [names]},
//     meta: { lock, syncKeys, lastCheckin } }
// Each request loads it, runs the shared route, and if anything changed writes
// it back only if nobody else wrote in between (S3 If-Match). On a clash the
// request simply runs again on the fresh copy. Bucket versioning keeps history.

import { MemoryVfs, IndexMedia } from '../vfs.js';
import { routes, runRoute, openData } from '../app.js';
import { verifyCognitoToken, makeUser, ANONYMOUS, ROLES } from '../auth.js';
import { cloudCamp } from '../camp.js';
import { HttpError } from '../store.js';

export const emptyDoc = () => ({ version: 1, files: {}, media: {}, meta: { lock: null, syncKeys: [] } });

const MEDIA_NAME = /^[^/\\]+$/;
const MEDIA_TYPES = /\.(mp4|mp3|wav|m4a|aac|jpg|jpeg|png|gif|txt|json)$/i;

/**
 * deps: {
 *   storage: { load() -> {doc, etag}, save(doc, etag) -> etag (throws {conflict:true}) },
 *   auth:    { region, userPoolId, clientId, domain, jwks? },
 *   users:   Cognito user admin (lib/cloud/users.js) or a fake,
 *   media:   { presignGet(folder, name), presignPut(folder, name, type), remove(folder, name) }
 * }
 */
export function makeCloudHandler(deps) {
  const authConfig = { kind: 'cognito', region: deps.auth.region, userPoolId: deps.auth.userPoolId,
    clientId: deps.auth.clientId, domain: deps.auth.domain };

  const cloudRoutes = [
    // ----- users (admin) -----
    ['GET', '/api/users', 'admin', () => deps.users.list(), { lockOk: true }],
    ['POST', '/api/users', 'admin', (c, _, b) => deps.users.invite(b, c.user), { lockOk: true }],
    ['PATCH', '/api/users/:username', 'admin', (c, p, b) => deps.users.update(p.username, b, c.user), { lockOk: true }],
    ['DELETE', '/api/users/:username', 'admin', (c, p) => deps.users.remove(p.username, c.user), { lockOk: true }],

    // ----- media (planner) -----
    ['POST', '/api/media/:folder/upload-url', 'plan', async (c, p, b) => {
      const name = String(b.name || '');
      if (!MEDIA_NAME.test(p.folder) || !MEDIA_NAME.test(name) || name.startsWith('.')) throw new HttpError(400, 'Bad file name');
      if (!MEDIA_TYPES.test(name)) throw new HttpError(400, 'Media must be MP4, MP3, WAV, M4A, AAC, JPG, PNG, GIF, TXT or JSON');
      return { url: await deps.media.presignPut(p.folder, name, b.type || ''), folder: p.folder, name };
    }],
    ['POST', '/api/media/:folder/uploaded', 'plan', (c, p, b) => {
      const name = String(b.name || '');
      if (!MEDIA_NAME.test(p.folder) || !MEDIA_NAME.test(name)) throw new HttpError(400, 'Bad file name');
      c.media.add(p.folder, name);
      return { files: c.media.files(p.folder) };
    }],
    ['GET', '/api/media/:folder/:name', 'read', async (c, p) => ({ url: await deps.media.presignGet(p.folder, p.name) }), { lockOk: true }],
    ['DELETE', '/api/media/:folder/:name', 'plan', async (c, p) => {
      await deps.media.remove(p.folder, p.name);
      c.media.remove(p.folder, p.name);
      return { files: c.media.files(p.folder) };
    }],

    // ----- camp laptop (admin in the browser) -----
    ['GET', '/api/camp/status', 'admin', (c) => cloudCamp.status(c.doc), { lockOk: true }],
    ['POST', '/api/camp/keys', 'admin', (c, _, b) => { c.metaDirty = true; return cloudCamp.createKey(c.doc, c.user, b.label); }, { lockOk: true }],
    ['DELETE', '/api/camp/keys/:id', 'admin', (c, p) => {
      c.doc.meta.syncKeys = (c.doc.meta.syncKeys || []).filter(k => k.id !== p.id);
      c.metaDirty = true;
      return cloudCamp.status(c.doc);
    }, { lockOk: true }],
    ['POST', '/api/camp/unlock', 'admin', (c) => {
      c.doc.meta.lock = null;
      c.metaDirty = true;
      return cloudCamp.status(c.doc);
    }, { lockOk: true }],

    // ----- camp laptop (the laptop itself, with a sync key) -----
    ['POST', '/api/camp/checkout', 'sync', async (c, _, b) => {
      const r = await cloudCamp.checkout(c.doc, c.keyRec, { force: !!b.force, laptop: b.laptop }, deps.media.presignGet);
      c.metaDirty = true;
      return r;
    }, { lockOk: true }],
    ['POST', '/api/camp/media-urls', 'sync', (c, _, b) => cloudCamp.mediaUrls(c.doc, b.files, deps.media.presignPut), { lockOk: true }],
    ['POST', '/api/camp/checkin', 'sync', (c, _, b) => {
      const r = cloudCamp.checkin(c.doc, b, { force: !!b.force });
      c.replaced = true;
      c.metaDirty = true;
      return r;
    }, { lockOk: true }]
  ];
  const table = [...cloudRoutes, ...routes];

  async function identify(headers, doc) {
    const key = headers['x-liahona-sync-key'];
    if (key) {
      const rec = cloudCamp.keyUser(doc, key);
      if (!rec) throw new HttpError(401, 'That sync key isn\'t valid any more. Create a new one in the cloud (Settings → Camp laptop).');
      const u = makeUser({ email: rec.createdBy, name: `Camp laptop (${rec.label || rec.id})`, roles: [], via: 'sync' });
      u.perms = ['sync'];
      u.can = (p) => p === 'sync';
      return { user: u, keyRec: rec };
    }
    const auth = headers.authorization || '';
    if (auth.startsWith('Bearer ')) return { user: await verifyCognitoToken(auth.slice(7), deps.auth) };
    return { user: ANONYMOUS };
  }

  /** req: { method, path, query, headers (lower-case), body (object), ip } */
  return async function handle(req) {
    for (let attempt = 0; attempt < 4; attempt++) {
      let { doc, etag } = await deps.storage.load();
      doc ||= emptyDoc();
      doc.meta ||= { lock: null, syncKeys: [] };
      let who;
      try { who = await identify(req.headers || {}, doc); }
      catch (e) { return { status: e.status || 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: e.message }) }; }

      const vfs = new MemoryVfs(doc.files);
      const media = new IndexMedia(doc.media || {});
      const { store, journeys } = openData({ vfs, media });
      const c = { store, journeys, media, vfs, doc, user: who.user, keyRec: who.keyRec, mode: 'cloud', lock: doc.meta.lock,
        cloud: { authConfig }, req: { ip: req.ip } };
      const out = await runRoute(table, c, req);

      const changed = out.status < 400 && (c.replaced || vfs.dirty || media.dirty || c.metaDirty);
      if (!changed) return out;
      if (!c.replaced) { doc.files = vfs.files; doc.media = media.index(); }
      try {
        await deps.storage.save(doc, etag);
        return out;
      } catch (e) {
        if (!e.conflict) throw e;
        // Someone else saved first: run this request again on their version.
      }
    }
    return { status: 503, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Busy right now, please try again' }) };
  };
}

export { ROLES };
