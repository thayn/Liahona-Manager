// Sign-in for the manager.
//   Cloud:  Cognito's hosted sign-in page (OAuth code flow with PKCE). Tokens
//           live in this browser; the ID token goes with every API call.
//   Laptop: the person at the laptop is already Admin; phones and iPads on
//           the camp Wi-Fi sign in with their email and their role's code.

const T = 'liahona.tokens';
let cfg = null;
let tokens = null;

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomString = (n = 48) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const jwtExp = (t) => { try { return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp * 1000; } catch { return 0; } };
const redirectUri = () => `${location.origin}/`;
const authBase = () => `https://${cfg.auth.domain}`;

function loadTokens() { try { tokens = JSON.parse(localStorage.getItem(T)); } catch { tokens = null; } }
function saveTokens(t) { tokens = t; if (t) localStorage.setItem(T, JSON.stringify(t)); else localStorage.removeItem(T); }

async function tokenRequest(params) {
  const res = await fetch(`${authBase()}/oauth2/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.auth.clientId, ...params })
  });
  if (!res.ok) throw new Error('Sign-in expired');
  return res.json();
}

async function startCloudSignIn() {
  const verifier = randomString(48);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = randomString(16);
  sessionStorage.setItem('liahona.pkce', JSON.stringify({ verifier, state, back: location.hash }));
  const q = new URLSearchParams({ response_type: 'code', client_id: cfg.auth.clientId, redirect_uri: redirectUri(),
    scope: 'openid email profile', code_challenge_method: 'S256', code_challenge: challenge, state });
  location.assign(`${authBase()}/oauth2/authorize?${q}`);
  return new Promise(() => {});   // the page is leaving
}

async function finishCloudSignIn() {
  const q = new URLSearchParams(location.search);
  const code = q.get('code');
  if (!code) return false;
  const saved = JSON.parse(sessionStorage.getItem('liahona.pkce') || '{}');
  sessionStorage.removeItem('liahona.pkce');
  history.replaceState(null, '', `/${saved.back || ''}`);
  if (!saved.verifier || saved.state !== q.get('state')) return false;
  const r = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: saved.verifier });
  saveTokens({ id: r.id_token, refresh: r.refresh_token, exp: jwtExp(r.id_token) });
  return true;
}

async function freshIdToken() {
  if (!tokens) return null;
  if (tokens.exp - Date.now() > 120000) return tokens.id;
  if (!tokens.refresh) return null;
  try {
    const r = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh });
    saveTokens({ ...tokens, id: r.id_token, exp: jwtExp(r.id_token) });
    return tokens.id;
  } catch { saveTokens(null); return null; }
}

/** fetch() with sign-in attached. Signs in again if the session ran out. */
export async function authFetch(url, init = {}) {
  const headers = { ...(init.headers || {}) };
  if (cfg?.mode === 'cloud') {
    const id = await freshIdToken();
    if (!id) return startCloudSignIn();
    headers.Authorization = `Bearer ${id}`;
  }
  const res = await fetch(url, { ...init, headers, credentials: 'same-origin' });
  if (res.status === 401 && cfg?.mode === 'cloud') { saveTokens(null); return startCloudSignIn(); }
  if (res.status === 401 && cfg?.mode === 'local') { showLocalSignIn(); }
  return res;
}

export async function signOut() {
  if (cfg.mode === 'cloud') {
    saveTokens(null);
    const q = new URLSearchParams({ client_id: cfg.auth.clientId, logout_uri: redirectUri() });
    location.assign(`${authBase()}/logout?${q}`);
  } else {
    await fetch('/api/local/signout', { method: 'POST' });
    location.reload();
  }
}

function showLocalSignIn(message = '') {
  if (document.getElementById('signin')) return;
  document.body.insertAdjacentHTML('beforeend', `
    <div id="signin" class="signin-cover">
      <form class="panel signin-box" id="signin-form">
        <div class="brand"><span class="orb" aria-hidden="true"></span>${cfg?.event?.name ? cfg.event.name.replace(/[<>&]/g, '') : 'Liahona Manager'}</div>
        <p class="hint">Sign in with your email and the code the camp leaders gave you.</p>
        <input name="email" type="email" placeholder="Your email" required autocomplete="email">
        <input name="code" type="password" placeholder="Sign-in code" required autocomplete="current-password">
        <button class="primary">Sign in</button>
        <p class="hint" id="signin-msg">${message}</p>
      </form>
    </div>`);
  document.getElementById('signin-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(ev.target).entries());
    const res = await fetch('/api/local/signin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f) });
    const d = await res.json().catch(() => ({}));
    if (res.ok) location.reload();
    else document.getElementById('signin-msg').textContent = d.error || 'Couldn\'t sign in';
  });
}

/** Make sure someone is signed in. Resolves with { cfg, me } once they are. */
export async function initAuth() {
  cfg = await (await fetch('/api/config')).json();
  if (cfg.mode === 'cloud') {
    loadTokens();
    try { await finishCloudSignIn(); } catch { saveTokens(null); }
    if (!tokens) await startCloudSignIn();
  }
  const res = await authFetch('/api/me');
  if (!res.ok) {
    if (cfg.mode === 'local') { showLocalSignIn(); return new Promise(() => {}); }
    throw new Error('Sign-in failed');
  }
  return { cfg, me: await res.json() };
}

// Download links (exports, ball files) need the sign-in too, so fetch them here.
document.addEventListener('click', async (ev) => {
  const a = ev.target.closest('a[href^="/api/"]');
  if (!a || cfg?.mode !== 'cloud') return;
  ev.preventDefault();
  const res = await authFetch(a.getAttribute('href'));
  if (!res.ok) { alert((await res.json().catch(() => ({}))).error || 'Download failed'); return; }
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || 'download';
  const url = URL.createObjectURL(await res.blob());
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});
