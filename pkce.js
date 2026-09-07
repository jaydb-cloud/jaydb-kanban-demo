/**
 * pkce.js — Authorization Code + PKCE flow against a JayDB tenant issuer.
 *
 * A static page cannot hold a client secret, so PKCE is the only correct client
 * authentication: a random verifier is kept locally, its S256 hash goes out on
 * the authorize request, and only the verifier's holder can redeem the code.
 * No secret is ever in this file or on the wire.
 *
 * The token this yields is sent as `Authorization: Bearer` on data calls, and
 * the server authorizes by its scopes (jaydb-cloud#58). That is the difference
 * between this and the identity-only Google button: this token actually gates
 * data access.
 */

const VERIFIER_KEY = 'jaydb_pkce_verifier';
const STATE_KEY = 'jaydb_pkce_state';
const RETURN_KEY = 'jaydb_pkce_return'; // connect-form values to restore post-redirect
const TOKENS_KEY = 'jaydb_oidc_tokens';

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

function randomString(bytes = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function s256(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(digest);
}

/** The issuer's endpoints. Discovery is the source of truth, so fetch it. */
async function discover(issuer) {
  const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`OIDC discovery failed (${res.status}) at ${url}`);
  return res.json();
}

/** The redirect URI is this page itself, no query or fragment. */
function redirectUri() {
  return window.location.origin + window.location.pathname;
}

/**
 * Begin sign-in: build the authorize URL and navigate to it. `context` (the
 * connect-form values) is stashed so the board can reopen after the redirect
 * returns.
 */
export async function beginLogin({ issuer, clientId, scopes, idp, context }) {
  const cfg = await discover(issuer);

  const verifier = randomString(32);
  const state = randomString(16);
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);
  if (context) sessionStorage.setItem(RETURN_KEY, JSON.stringify(context));

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri(),
    scope: scopes.join(' '),
    state,
    code_challenge: await s256(verifier),
    code_challenge_method: 'S256',
  });
  // idp selects the upstream provider (google / github) registered on the tenant.
  if (idp) params.set('idp', idp);

  // Remember the issuer's token endpoint for the callback, which runs on a fresh
  // page load with no closure to carry it.
  sessionStorage.setItem('jaydb_pkce_token_endpoint', cfg.token_endpoint);

  window.location.assign(`${cfg.authorization_endpoint}?${params}`);
}

/**
 * Complete sign-in when the page loads with `?code=...&state=...`. Returns the
 * stashed connect-form context on success, or null when this is not a callback.
 * Throws on a real error (state mismatch, exchange failure).
 */
export async function completeLoginIfCallback({ clientId }) {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    cleanUrl();
    throw new Error(`sign-in failed: ${error}${url.searchParams.get('error_description') ? ` — ${url.searchParams.get('error_description')}` : ''}`);
  }
  if (!code) return null; // not a callback

  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  const expectedState = sessionStorage.getItem(STATE_KEY);
  const tokenEndpoint = sessionStorage.getItem('jaydb_pkce_token_endpoint');
  cleanUrl(); // strip code/state from the address bar regardless of outcome

  if (!verifier || !expectedState) throw new Error('sign-in state is missing — start again');
  if (returnedState !== expectedState) throw new Error('sign-in state mismatch — possible CSRF, aborted');
  if (!tokenEndpoint) throw new Error('sign-in lost the token endpoint — start again');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    client_id: clientId,
    code_verifier: verifier,
  });
  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    mode: 'cors',
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`token exchange failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }

  const tokens = await res.json();
  storeTokens(tokens, tokenEndpoint, clientId);

  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);

  const ret = sessionStorage.getItem(RETURN_KEY);
  sessionStorage.removeItem(RETURN_KEY);
  return ret ? JSON.parse(ret) : {};
}

/** Remove code/state/error from the URL without a reload. */
function cleanUrl() {
  const url = new URL(window.location.href);
  ['code', 'state', 'error', 'error_description', 'iss'].forEach((p) => url.searchParams.delete(p));
  window.history.replaceState({}, document.title, url.pathname + (url.search || '') + url.hash);
}

function storeTokens(tokens, tokenEndpoint, clientId) {
  const expiresAt = tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : 0;
  sessionStorage.setItem(
    TOKENS_KEY,
    JSON.stringify({
      accessToken: tokens.access_token ?? null,
      refreshToken: tokens.refresh_token ?? null,
      idToken: tokens.id_token ?? null,
      expiresAt,
      tokenEndpoint,
      clientId,
    }),
  );
}

function loadTokens() {
  try {
    return JSON.parse(sessionStorage.getItem(TOKENS_KEY) ?? 'null');
  } catch {
    return null;
  }
}

/** Are we currently signed in with a usable (or refreshable) session? */
export function isSignedIn() {
  const t = loadTokens();
  return Boolean(t?.accessToken);
}

/** Decode the id_token's display claims (name, email, picture). Display only. */
export function identityClaims() {
  const t = loadTokens();
  if (!t?.idToken) return null;
  try {
    const [, payload] = t.idToken.split('.');
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

/** Forget the session. */
export function signOut() {
  sessionStorage.removeItem(TOKENS_KEY);
}

let refreshInFlight = null;

/**
 * Return a currently-valid access token, refreshing it first when it is within
 * 30s of expiry and a refresh token is available. Returns null when there is no
 * session or the refresh fails (the caller then treats the user as signed out).
 *
 * This is the function handed to the JayDB client as `getToken` — but note it is
 * async, so callers that need a fresh token must await ensureToken() and pass a
 * plain sync getter that reads the last-known token. See app.js.
 */
export async function ensureToken() {
  let t = loadTokens();
  if (!t?.accessToken) return null;

  const stale = t.expiresAt && Date.now() > t.expiresAt - 30_000;
  if (!stale) return t.accessToken;

  if (!t.refreshToken) {
    // No way to refresh silently; the caller must send the user back through login.
    return null;
  }
  // Coalesce concurrent refreshes.
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: t.refreshToken,
        client_id: t.clientId,
      });
      const res = await fetch(t.tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        mode: 'cors',
      });
      if (!res.ok) {
        signOut();
        return null;
      }
      const tokens = await res.json();
      // A rotating issuer may not re-send the refresh token; keep the old one then.
      if (!tokens.refresh_token) tokens.refresh_token = t.refreshToken;
      storeTokens(tokens, t.tokenEndpoint, t.clientId);
      return tokens.access_token ?? null;
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/** The current access token without refreshing — for the sync getToken path. */
export function currentToken() {
  return loadTokens()?.accessToken ?? null;
}
