// Who is asking, and what may they do.
//
// Roles (a person can be in more than one; permissions add up):
//   admin      everything: users, event settings, deleting data, camp download/upload
//   planner    journeys, places, media, teams, cards. Sees names/ward/age/team, not private details
//   registrar  sign-ups and full participant profiles (contacts, health, permission)
//   leader     read-only; sees private details only for their own team's members
//
// Cloud: Cognito ID tokens (groups = roles), checked here with node:crypto.
// Laptop: whoever sits at the laptop (localhost) is admin; phones and iPads on
// the camp Wi-Fi sign in with their email and the code for their role, which
// an admin sets in Settings.

import crypto from 'node:crypto';
import { HttpError } from './store.js';

export const ROLES = ['admin', 'planner', 'registrar', 'leader'];

const PERMS = {
  admin: ['read', 'plan', 'people', 'private', 'admin'],
  planner: ['read', 'plan'],
  registrar: ['read', 'people', 'private'],
  leader: ['read']
};

export const ROLE_LABELS = {
  admin: 'Admin', planner: 'Planner', registrar: 'Registrar', leader: 'Leader'
};

/** Build the user object every route sees. */
export function makeUser({ email = '', name = '', roles = [], via = '' }) {
  const rs = roles.filter(r => ROLES.includes(r));
  const perms = new Set(rs.flatMap(r => PERMS[r]));
  return { email: String(email).toLowerCase(), name, roles: rs, perms: [...perms], via, can: (p) => perms.has(p) };
}

export const ANONYMOUS = makeUser({ via: 'anonymous' });

export function requirePerm(user, perm) {
  if (!perm || perm === 'public') return;
  if (!user || user.via === 'anonymous') throw new HttpError(401, 'Please sign in');
  if (!user.can(perm)) throw new HttpError(403, 'Your role can\'t do that');
}

// ---------------------------------------------------------------- Cognito

const jwksCache = new Map();   // url -> {keys, at}

async function getJwks(url, fetchImpl = fetch) {
  const hit = jwksCache.get(url);
  if (hit && Date.now() - hit.at < 6 * 3600 * 1000) return hit.keys;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Couldn't load sign-in keys (${res.status})`);
  const { keys } = await res.json();
  jwksCache.set(url, { keys, at: Date.now() });
  return keys;
}

const b64urlJson = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

/**
 * Check a Cognito ID token and return the user. Throws 401 if anything is off.
 * cfg: { region, userPoolId, clientId, jwks? (for tests), fetch? }
 */
export async function verifyCognitoToken(token, cfg) {
  const fail = (why) => { const e = new HttpError(401, 'Please sign in again'); e.why = why; throw e; };
  const parts = String(token || '').split('.');
  if (parts.length !== 3) fail('malformed');
  let header, claims;
  try { header = b64urlJson(parts[0]); claims = b64urlJson(parts[1]); } catch { fail('malformed'); }
  if (header.alg !== 'RS256') fail('alg');
  const issuer = `https://cognito-idp.${cfg.region}.amazonaws.com/${cfg.userPoolId}`;
  const keys = cfg.jwks || await getJwks(`${issuer}/.well-known/jwks.json`, cfg.fetch);
  const jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) fail('kid');
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
  if (!ok) fail('signature');
  const nowS = Math.floor(Date.now() / 1000);
  if (claims.iss !== issuer) fail('issuer');
  if (claims.token_use !== 'id') fail('token_use');
  if (claims.aud !== cfg.clientId) fail('audience');
  if (!(claims.exp > nowS - 30)) fail('expired');
  return makeUser({
    email: claims.email || '',
    name: claims.name || claims.given_name || claims.email || '',
    roles: claims['cognito:groups'] || [],
    via: 'cognito'
  });
}

// ---------------------------------------------------------------- Laptop

const hash = (code, salt) => crypto.scryptSync(String(code).trim(), salt, 32).toString('hex');

/**
 * Local sign-in state, kept in local-auth.json in the data folder. It never
 * goes to the cloud. { secret, codes: { leader: {salt, hash}, ... } }
 */
export class LocalAuth {
  constructor(vfs, file = 'local-auth.json') {
    this.vfs = vfs;
    this.file = file;
    this.cfg = vfs.exists(file) ? JSON.parse(vfs.read(file)) : {};
    if (!this.cfg.secret) { this.cfg.secret = crypto.randomBytes(32).toString('hex'); this.cfg.codes = {}; this.save(); }
    this.cfg.codes ||= {};
  }
  save() { this.vfs.write(this.file, JSON.stringify(this.cfg, null, 2)); }

  /** Which roles have a code set (never the codes themselves). */
  status() { return Object.fromEntries(ROLES.map(r => [r, !!this.cfg.codes[r]])); }

  setCode(role, code) {
    if (!ROLES.includes(role)) throw new HttpError(400, 'Unknown role');
    if (!code) { delete this.cfg.codes[role]; this.save(); return; }
    if (String(code).trim().length < 6) throw new HttpError(400, 'Use at least 6 characters for a sign-in code');
    const salt = crypto.randomBytes(16).toString('hex');
    this.cfg.codes[role] = { salt, hash: hash(code, salt) };
    this.save();
  }

  /** Returns the role the code belongs to, or null. */
  roleForCode(code) {
    for (const [role, c] of Object.entries(this.cfg.codes)) {
      const h = Buffer.from(hash(code, c.salt), 'hex');
      if (crypto.timingSafeEqual(h, Buffer.from(c.hash, 'hex'))) return role;
    }
    return null;
  }

  /** Signed session cookie value: base64url(json).hmac */
  issue(payload, days = 7) {
    const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + days * 86400000 })).toString('base64url');
    const mac = crypto.createHmac('sha256', this.cfg.secret).update(body).digest('base64url');
    return `${body}.${mac}`;
  }

  read(cookieValue) {
    const [body, mac] = String(cookieValue || '').split('.');
    if (!body || !mac) return null;
    const want = crypto.createHmac('sha256', this.cfg.secret).update(body).digest('base64url');
    if (want.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(mac))) return null;
    try {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      return p.exp > Date.now() ? p : null;
    } catch { return null; }
  }
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const isLoopback = (ip) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(ip || ''));
