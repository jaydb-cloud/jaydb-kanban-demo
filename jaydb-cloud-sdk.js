// JayDB Cloud SDK — Standalone Bundle
/**
 * errors.js — Typed error hierarchy for JayDB Cloud.
 */

/**
 * Base class for all errors raised by the JayDB Cloud SDK.
 */
export class JayDBError extends Error {
  /**
   * @param {string} message - Human-readable error description.
   * @param {object} [opts]
   * @param {number} [opts.status=0] - HTTP status code if originated from an HTTP request.
   * @param {string|null} [opts.key=null] - Document key involved in the operation.
   * @param {any} [opts.body=null] - Response body or raw error payload.
   */
  constructor(message, { status = 0, key = null, body = null } = {}) {
    super(message);
    this.name = 'JayDBError';
    this.status = status;
    this.key = key;
    this.body = body;
  }
}

/**
 * Precondition Failed (HTTP 412).
 * Raised when an `ifMatch` conditional write lost a race with a concurrent update,
 * or when a `createOnly` write found the key already occupied.
 *
 * Typical resolution: re-read the latest document revision (`get()`), re-apply your
 * mutations to the new state, and write again with the updated ETag.
 */
export class ConflictError extends JayDBError {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'ConflictError';
  }
}

/**
 * Document or Namespace Not Found (HTTP 404).
 */
export class NotFoundError extends JayDBError {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'NotFoundError';
  }
}

/**
 * Authentication or Authorization failure (HTTP 401 / 403).
 * Raised when credentials (API key or Bearer token) are missing, invalid, expired,
 * or lack permissions for the requested path or action.
 */
export class AuthError extends JayDBError {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'AuthError';
  }
}

/**
 * treeacl.js — Cryptographic stateless invite token generator and verifier for JayDB Cloud.
 *
 * Implements HMAC-SHA256 signed payloads carrying tree path delegation claims:
 *   - tree_path: e.g. "boards/{boardId}/**"
 *   - role: "read" | "write" | "own"
 *   - inviter_id / inviter
 *   - exp: timestamp
 *
 * Generates and verifies 100% client-side with zero server calls.
 */

const DEFAULT_SECRET = 'jaydb-kanban-tree-acl-signing-key-2026';

function getCrypto() {
  if (typeof globalThis !== 'undefined' && globalThis.crypto) {
    return globalThis.crypto;
  }
  throw new Error('Web Cryptography API (crypto.subtle) is required.');
}

export function b64url(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let str = '';
  for (let i = 0; i < bytes.length; i++) {
    str += String.fromCharCode(bytes[i]);
  }
  return btoa(str)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function fromB64url(str) {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

async function getHmacKey(secret = DEFAULT_SECRET) {
  const cryptoObj = getCrypto();
  const enc = new TextEncoder();
  return cryptoObj.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/**
 * TreeACL provides stateless invite signing and verification for hierarchical resources.
 */
export class TreeACL {
  /**
   * Sign a stateless invite token for a tree path or board ID.
   *
   * @param {object} opts
   * @param {string} [opts.treePath] - e.g. "boards/my-board/**"
   * @param {string} [opts.boardId] - Board identifier (convenience shorthand for treePath "boards/{boardId}/**")
   * @param {'read' | 'write' | 'own'} opts.role - Permission granted by this invite
   * @param {string} [opts.inviterName='Admin'] - Name or display tag of the inviting user
   * @param {number} [opts.expiresInMs=604800000] - Lifetime in ms (defaults to 7 days)
   * @param {string} [opts.secret] - Shared signing key (defaults to standard tenant key)
   * @returns {Promise<string>} URL-safe signed token string (payload.signature)
   */
  static async signInvite({
    treePath,
    boardId,
    role,
    inviterName = 'Admin',
    expiresInMs = 7 * 24 * 60 * 60 * 1000,
    secret = DEFAULT_SECRET,
  }) {
    if (!['read', 'write', 'own'].includes(role)) {
      throw new Error(`invalid role: ${role}`);
    }

    const path = treePath || (boardId ? `boards/${boardId}/**` : null);
    if (!path) {
      throw new Error('treePath or boardId is required');
    }

    const cryptoObj = getCrypto();
    const nonce = b64url(cryptoObj.getRandomValues(new Uint8Array(12)));
    const payload = {
      type: 'tree_invite',
      tree_path: path,
      role,
      inviter: inviterName,
      exp: Date.now() + expiresInMs,
      nonce,
    };
    if (boardId) {
      payload.board_id = boardId;
    }

    const enc = new TextEncoder();
    const payloadB64 = b64url(enc.encode(JSON.stringify(payload)));

    const key = await getHmacKey(secret);
    const sigBuffer = await cryptoObj.subtle.sign('HMAC', key, enc.encode(payloadB64));
    const sigB64 = b64url(sigBuffer);

    return `${payloadB64}.${sigB64}`;
  }

  /**
   * Verify a stateless invite token.
   *
   * @param {string} rawToken - Signed invite token (payload.signature)
   * @param {object} [opts]
   * @param {string} [opts.secret] - Shared signing key
   * @returns {Promise<{treePath: string, boardId?: string, role: string, inviter: string, exp: number} | null>}
   *          Parsed invite claims or null if invalid or expired.
   */
  static async verifyInvite(rawToken, { secret = DEFAULT_SECRET } = {}) {
    if (!rawToken || typeof rawToken !== 'string') return null;

    const parts = rawToken.trim().split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

    const [payloadB64, sigB64] = parts;

    try {
      const cryptoObj = getCrypto();
      const key = await getHmacKey(secret);
      const enc = new TextEncoder();
      const sigBytes = fromB64url(sigB64);

      const valid = await cryptoObj.subtle.verify(
        'HMAC',
        key,
        sigBytes,
        enc.encode(payloadB64),
      );
      if (!valid) return null;

      const payloadBytes = fromB64url(payloadB64);
      const dec = new TextDecoder();
      const payload = JSON.parse(dec.decode(payloadBytes));

      if (payload.type !== 'tree_invite') return null;
      if (payload.exp && Date.now() > payload.exp) {
        return null; // Expired
      }

      return {
        treePath: payload.tree_path,
        boardId: payload.board_id || null,
        role: payload.role,
        inviter: payload.inviter,
        exp: payload.exp,
      };
    } catch {
      return null;
    }
  }
}

/** Shorthand for board invite generation, backwards compatible with Kanban demo. */
export async function signBoardInvite(opts) {
  return TreeACL.signInvite(opts);
}

/** Shorthand for board invite verification, backwards compatible with Kanban demo. */
export async function verifyBoardInvite(rawToken, opts) {
  return TreeACL.verifyInvite(rawToken, opts);
}

/**
 * auth.js — OIDC Authorization Code + PKCE flow for JayDB Cloud.
 *
 * Implements public-client OAuth2/OIDC without client secrets:
 *   1. Authorize: Random S256 verifier and challenge -> /oauth/v2/authorize
 *   2. Token Exchange: Exchange code + verifier -> /oauth/v2/token
 *   3. Token Lifecycle: Transparent background refresh with request coalescing
 *   4. Session: Stored in sessionStorage or custom storage adapter
 */


const STORAGE_PREFIX = 'jaydb_pkce_';
const VERIFIER_KEY = `${STORAGE_PREFIX}verifier`;
const STATE_KEY = `${STORAGE_PREFIX}state`;
const RETURN_KEY = `${STORAGE_PREFIX}return`;
const TOKENS_KEY = 'jaydb_oidc_tokens';
const TOKEN_ENDPOINT_KEY = `${STORAGE_PREFIX}token_endpoint`;

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    this.map.set(k, String(v));
  }
  removeItem(k) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}

function resolveStorage(customStorage) {
  if (customStorage) return customStorage;
  if (typeof window !== 'undefined' && window.sessionStorage) {
    return window.sessionStorage;
  }
  return new MemoryStorage();
}

function getCrypto() {
  if (typeof globalThis !== 'undefined' && globalThis.crypto) {
    return globalThis.crypto;
  }
  throw new Error('Web Cryptography API (crypto.subtle) is required for PKCE.');
}

function b64url(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let str = '';
  for (let i = 0; i < arr.length; i++) {
    str += String.fromCharCode(arr[i]);
  }
  return btoa(str)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function randomString(bytes = 32) {
  const cryptoObj = getCrypto();
  return b64url(cryptoObj.getRandomValues(new Uint8Array(bytes)));
}

async function s256(verifier) {
  const cryptoObj = getCrypto();
  const digest = await cryptoObj.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(digest);
}

function defaultRedirectUri() {
  if (typeof window !== 'undefined' && window.location) {
    return window.location.origin + window.location.pathname;
  }
  return 'http://localhost';
}

function cleanUrl() {
  if (typeof window === 'undefined' || !window.location || !window.history) return;
  try {
    const url = new URL(window.location.href);
    ['code', 'state', 'error', 'error_description', 'iss'].forEach((p) => url.searchParams.delete(p));
    window.history.replaceState({}, document.title, url.pathname + (url.search || '') + url.hash);
  } catch {
    /* ignore in non-standard window mocks */
  }
}

/**
 * JayDBAuth manages OIDC PKCE authentication against a JayDB Cloud tenant.
 */
export class JayDBAuth {
  /**
   * @param {object} [opts]
   * @param {string} [opts.issuer] - Tenant OIDC issuer, e.g. "https://acme.jaydb.com"
   * @param {string} [opts.clientId] - Registered public application client ID
   * @param {string} [opts.redirectUri] - OAuth redirect URI (defaults to current page origin+path)
   * @param {string[]} [opts.scopes=['openid', 'profile', 'email']] - Default requested scopes
   * @param {Storage} [opts.storage] - Storage provider (defaults to window.sessionStorage)
   */
  constructor({ issuer, clientId, redirectUri, scopes = ['openid', 'profile', 'email'], storage } = {}) {
    this.issuer = issuer ? String(issuer).replace(/\/+$/, '') : null;
    this.clientId = clientId || null;
    this.redirectUri = redirectUri || null;
    this.scopes = scopes;
    this.storage = resolveStorage(storage);
    this.#refreshInFlight = null;
  }

  #refreshInFlight;

  /**
   * Fetch OIDC discovery document from the tenant issuer.
   *
   * @param {string} [issuer]
   */
  async discover(issuer = this.issuer) {
    const iss = issuer ? String(issuer).replace(/\/+$/, '') : this.issuer;
    if (!iss) throw new AuthError('OIDC issuer is required for discovery.');

    const url = `${iss}/.well-known/openid-configuration`;
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) {
      throw new AuthError(`OIDC discovery failed (${res.status}) at ${url}`, { status: res.status });
    }
    return res.json();
  }

  /**
   * Initiate PKCE authorization.
   *
   * @param {object} [opts]
   * @param {string} [opts.issuer]
   * @param {string} [opts.clientId]
   * @param {string[]} [opts.scopes]
   * @param {string} [opts.redirectUri]
   * @param {'google' | 'github' | 'microsoft' | string} [opts.idp] - Upstream provider configured on tenant
   * @param {any} [opts.context] - Arbitrary state to preserve and restore after the redirect
   * @param {boolean} [opts.autoRedirect=true] - If true, automatically navigates window.location
   * @returns {Promise<{authorizeUrl: string, state: string}>}
   */
  async signIn({
    issuer = this.issuer,
    clientId = this.clientId,
    scopes = this.scopes,
    redirectUri = this.redirectUri || defaultRedirectUri(),
    idp,
    context,
    autoRedirect = true,
  } = {}) {
    if (!issuer) throw new AuthError('issuer is required for signIn');
    if (!clientId) throw new AuthError('clientId is required for signIn');

    const cfg = await this.discover(issuer);
    const verifier = randomString(32);
    const state = randomString(16);

    this.storage.setItem(VERIFIER_KEY, verifier);
    this.storage.setItem(STATE_KEY, state);
    if (context !== undefined) {
      this.storage.setItem(RETURN_KEY, JSON.stringify(context));
    }
    this.storage.setItem(TOKEN_ENDPOINT_KEY, cfg.token_endpoint);

    const challenge = await s256(verifier);
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: Array.isArray(scopes) ? scopes.join(' ') : String(scopes),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    if (idp) params.set('idp', idp);

    const authorizeUrl = `${cfg.authorization_endpoint}?${params}`;

    if (autoRedirect && typeof window !== 'undefined' && window.location) {
      window.location.assign(authorizeUrl);
    }

    return { authorizeUrl, state };
  }

  /** Alias for signIn to support existing Kanban call sites. */
  async beginLogin(opts) {
    return this.signIn(opts);
  }

  /**
   * Complete sign-in when the application page loads with callback query parameters (?code=...&state=...).
   *
   * @param {object} [opts]
   * @param {string} [opts.clientId]
   * @param {string} [opts.redirectUri]
   * @param {string} [opts.url] - URL string (defaults to current window.location.href)
   * @returns {Promise<any|null>} The restored context object if a callback was processed, or null if not a callback.
   */
  async handleCallback({
    clientId = this.clientId,
    redirectUri = this.redirectUri || defaultRedirectUri(),
    url: rawUrl,
  } = {}) {
    const currentHref = rawUrl || (typeof window !== 'undefined' ? window.location.href : null);
    if (!currentHref) return null;

    const url = new URL(currentHref);
    const code = url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    if (error) {
      cleanUrl();
      const desc = url.searchParams.get('error_description');
      throw new AuthError(`sign-in failed: ${error}${desc ? ` — ${desc}` : ''}`);
    }

    if (!code) return null; // Not a callback

    const verifier = this.storage.getItem(VERIFIER_KEY);
    const expectedState = this.storage.getItem(STATE_KEY);
    const tokenEndpoint = this.storage.getItem(TOKEN_ENDPOINT_KEY);

    cleanUrl();

    if (!verifier || !expectedState) {
      throw new AuthError('Sign-in state is missing — please initiate login again.');
    }
    if (returnedState !== expectedState) {
      throw new AuthError('Sign-in state mismatch (possible CSRF) — login aborted.');
    }
    if (!tokenEndpoint) {
      throw new AuthError('Sign-in lost token endpoint metadata — please initiate login again.');
    }

    const cid = clientId || this.clientId;
    if (!cid) throw new AuthError('clientId is required to complete token exchange.');

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: cid,
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
      throw new AuthError(
        `Token exchange failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`,
        { status: res.status, body: detail },
      );
    }

    const tokens = await res.json();
    this.storeTokens(tokens, tokenEndpoint, cid);

    this.storage.removeItem(VERIFIER_KEY);
    this.storage.removeItem(STATE_KEY);

    const ret = this.storage.getItem(RETURN_KEY);
    this.storage.removeItem(RETURN_KEY);

    return ret ? JSON.parse(ret) : {};
  }

  /** Alias for handleCallback to support existing Kanban call sites. */
  async completeLoginIfCallback(opts) {
    return this.handleCallback(opts);
  }

  /** Store tokens and expiry timestamp into storage. */
  storeTokens(tokens, tokenEndpoint, clientId) {
    const expiresAt = tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : 0;
    this.storage.setItem(
      TOKENS_KEY,
      JSON.stringify({
        accessToken: tokens.access_token ?? null,
        refreshToken: tokens.refresh_token ?? null,
        idToken: tokens.id_token ?? null,
        expiresAt,
        tokenEndpoint: tokenEndpoint || null,
        clientId: clientId || this.clientId || null,
      }),
    );
  }

  /** Read current token record from storage. */
  getTokens() {
    try {
      const raw = this.storage.getItem(TOKENS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  /** Check if the user is currently signed in. */
  isSignedIn() {
    const t = this.getTokens();
    return Boolean(t?.accessToken);
  }

  /**
   * Decode the user identity claims from the ID token (name, email, picture, sub).
   * Display and presentation only.
   */
  getUser() {
    const t = this.getTokens();
    if (!t?.idToken) return null;
    try {
      const [, payload] = t.idToken.split('.');
      return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    } catch {
      return null;
    }
  }

  /** Alias for getUser to match existing Kanban demo. */
  identityClaims() {
    return this.getUser();
  }

  /** Sign out and clear stored tokens. */
  signOut() {
    this.storage.removeItem(TOKENS_KEY);
  }

  /**
   * Return a valid access token, automatically refreshing it if within 30s of expiration.
   * Concurrently coalesces multiple refresh calls into a single in-flight request.
   *
   * @returns {Promise<string|null>} Valid access token or null if unauthenticated.
   */
  async getToken() {
    const t = this.getTokens();
    if (!t?.accessToken) return null;

    const isStale = t.expiresAt && Date.now() > t.expiresAt - 30_000;
    if (!isStale) return t.accessToken;

    if (!t.refreshToken || !t.tokenEndpoint) {
      // Token is stale but no refresh token available
      return null;
    }

    if (!this.#refreshInFlight) {
      this.#refreshInFlight = (async () => {
        try {
          const body = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: t.refreshToken,
            client_id: t.clientId || this.clientId,
          });

          const res = await fetch(t.tokenEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
            mode: 'cors',
          });

          if (!res.ok) {
            this.signOut();
            return null;
          }

          const tokens = await res.json();
          if (!tokens.refresh_token) {
            tokens.refresh_token = t.refreshToken;
          }
          this.storeTokens(tokens, t.tokenEndpoint, t.clientId || this.clientId);
          return tokens.access_token ?? null;
        } finally {
          this.#refreshInFlight = null;
        }
      })();
    }

    return this.#refreshInFlight;
  }

  /** Alias for getToken to match existing Kanban demo. */
  async ensureToken() {
    return this.getToken();
  }

  /** Synchronous accessor for currently stored access token (without refresh check). */
  currentToken() {
    return this.getTokens()?.accessToken ?? null;
  }
}

// Default singleton instance for quick usage
let defaultAuth = null;
function getDefaultAuth() {
  if (!defaultAuth) defaultAuth = new JayDBAuth();
  return defaultAuth;
}

export async function beginLogin(opts) {
  return getDefaultAuth().signIn(opts);
}

export async function completeLoginIfCallback(opts) {
  return getDefaultAuth().handleCallback(opts);
}

export function isSignedIn() {
  return getDefaultAuth().isSignedIn();
}

export function identityClaims() {
  return getDefaultAuth().getUser();
}

export async function ensureToken() {
  return getDefaultAuth().getToken();
}

export function currentToken() {
  return getDefaultAuth().currentToken();
}

export function signOut() {
  return getDefaultAuth().signOut();
}


/**
 * client.js — High-level, dependency-free client for the JayDB Cloud Document API.
 *
 * Talks directly to:
 *   https://{tenant}.jaydb.com/v1/n/{namespace}/docs/{key}
 *
 * Supports optimistic concurrency control (CAS) via standard HTTP ETags,
 * per-user OIDC PKCE tokens, API keys, and automatic request metrics.
 */


/**
 * Percent-encode a document key while preserving the hierarchy separators ('/').
 * e.g., "boards/project 1/meta" -> "boards/project%201/meta"
 */
export function encodeKey(key) {
  return String(key)
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .map(encodeURIComponent)
    .join('/');
}

/**
 * Strip transport quoting and weak indicators from an ETag header.
 * e.g., 'W/"abc123"' -> 'abc123'
 */
export function unquoteETag(value) {
  if (!value) return null;
  return String(value).replace(/^W\//, '').replace(/^"/, '').replace(/"$/, '');
}

export class JayDBClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl - Tenant origin, e.g. "https://acme.jaydb.com"
   * @param {string} opts.namespace - Namespace name, e.g. "default"
   * @param {string} [opts.apiKey] - Secret or public API key (sent as X-JayDB-API-Key)
   * @param {function} [opts.getToken] - Sync or async `() => string | null` returning an access token
   * @param {import('./auth.js').JayDBAuth} [opts.auth] - Auth client instance
   * @param {typeof fetch} [opts.fetch] - Custom fetch implementation
   */
  constructor({ baseUrl, namespace, apiKey, getToken, auth, fetch: customFetch }) {
    if (!baseUrl) throw new Error('jaydb: baseUrl is required');
    if (!namespace) throw new Error('jaydb: namespace is required');
    if (!apiKey && !getToken && !auth) {
      throw new Error('jaydb: apiKey, getToken, or auth is required');
    }

    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.namespace = namespace;
    this.apiKey = apiKey ?? null;
    this.getToken = getToken ?? null;
    this.auth = auth ?? null;
    this.fetch = customFetch || (typeof globalThis !== 'undefined' ? globalThis.fetch.bind(globalThis) : null);

    if (!this.fetch) {
      throw new Error('jaydb: fetch API is not available in this environment.');
    }

    /** Request counters and latency metrics. */
    this.stats = {
      reads: 0,
      writes: 0,
      deletes: 0,
      lists: 0,
      conflicts: 0,
      totalRequests: 0,
      totalLatencyMs: 0,
      lastLatencyMs: 0,
      avgLatencyMs: 0,
    };

    this.#warned = new Set();
  }

  #warned;

  /**
   * Build authentication headers. A Bearer token takes precedence over an API key.
   */
  async #authHeaders() {
    if (this.auth && typeof this.auth.getToken === 'function') {
      const token = await this.auth.getToken();
      if (token) return { Authorization: `Bearer ${token}` };
    }
    if (this.getToken) {
      const token = await this.getToken();
      if (token) return { Authorization: `Bearer ${token}` };
    }
    if (this.apiKey) {
      return { 'X-JayDB-API-Key': this.apiKey };
    }
    return {};
  }

  #docsUrl(key = '') {
    const base = `${this.baseUrl}/v1/n/${encodeURIComponent(this.namespace)}/docs`;
    const encoded = encodeKey(key);
    return encoded ? `${base}/${encoded}` : base;
  }

  #recordLatency(ms) {
    this.stats.totalRequests++;
    this.stats.totalLatencyMs += ms;
    this.stats.lastLatencyMs = Math.round(ms);
    this.stats.avgLatencyMs = Math.round(this.stats.totalLatencyMs / this.stats.totalRequests);
  }

  async #request(method, url, { headers = {}, body, signal } = {}, key = null) {
    const startedAt = performance.now();
    let response;
    try {
      const authHeaders = await this.#authHeaders();
      response = await this.fetch(url, {
        method,
        headers: { ...authHeaders, ...headers },
        body,
        signal,
        credentials: 'omit',
        mode: 'cors',
      });
    } catch (cause) {
      this.#recordLatency(performance.now() - startedAt);
      if (cause?.name === 'AbortError') throw cause;
      throw new JayDBError(
        `Network or CORS failure calling ${method} ${url}. If the server is reachable, ` +
          `verify that your application's origin is listed in allowed origins.`,
        { key, body: String(cause?.message ?? cause) },
      );
    }
    this.#recordLatency(performance.now() - startedAt);
    return response;
  }

  async #errorFrom(response, key) {
    let message = `${response.status} ${response.statusText}`;
    let body = null;
    try {
      body = await response.json();
      if (body?.error) message = body.error;
    } catch {
      /* non-JSON error bodies ignored */
    }

    const opts = { status: response.status, key, body };
    switch (response.status) {
      case 401:
      case 403:
        return new AuthError(message, opts);
      case 404:
        return new NotFoundError(message, opts);
      case 412:
        return new ConflictError(message, opts);
      default:
        return new JayDBError(message, opts);
    }
  }

  #warnOnce(id, message) {
    if (this.#warned.has(id)) return;
    this.#warned.add(id);
    console.warn(`[jaydb] ${message}`);
  }

  /**
   * Read one document by key.
   *
   * @template T
   * @param {string} key - Document key path
   * @param {object} [opts]
   * @param {AbortSignal} [opts.signal]
   * @param {string} [opts.knownETag] - Fallback ETag if CORS headers mask the ETag header
   * @returns {Promise<{key: string, data: T, etag: string|null} | null>}
   *          Document record or null when the key does not exist.
   */
  async get(key, { signal, knownETag } = {}) {
    this.stats.reads++;
    const response = await this.#request('GET', this.#docsUrl(key), { signal }, key);

    if (response.status === 404) return null;
    if (!response.ok) throw await this.#errorFrom(response, key);

    const data = await response.json();
    let etag = unquoteETag(response.headers.get('ETag'));

    // Fallback if ETag is not exposed via Access-Control-Expose-Headers
    if (!etag) {
      etag = knownETag ?? (await this.#etagFromListing(key, signal));
    }

    return { key, data, etag };
  }

  async #etagFromListing(key, signal) {
    try {
      const { items } = await this.list({ prefix: key, limit: 10, signal });
      return items.find((item) => item.key === key)?.etag ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Write one document.
   *
   * @template T
   * @param {string} key - Document key path
   * @param {T} data - JSON-serializable document content
   * @param {object} [opts]
   * @param {string} [opts.ifMatch] - Only write if the existing document matches this ETag (CAS).
   * @param {boolean} [opts.createOnly] - Only write if the key does not yet exist (If-None-Match: *).
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<{key: string, etag: string, modTime: string|null}>}
   */
  async put(key, data, { ifMatch, createOnly, signal } = {}) {
    this.stats.writes++;

    const headers = { 'Content-Type': 'application/json' };
    if (ifMatch) {
      headers['If-Match'] = `"${unquoteETag(ifMatch)}"`;
    } else if (createOnly) {
      headers['If-None-Match'] = '*';
    }

    const response = await this.#request(
      'PUT',
      this.#docsUrl(key),
      { headers, body: JSON.stringify(data), signal },
      key,
    );

    if (!response.ok) {
      if (response.status === 412) this.stats.conflicts++;
      throw await this.#errorFrom(response, key);
    }

    const payload = await response.json().catch(() => ({}));
    return {
      key,
      etag: unquoteETag(response.headers.get('ETag')) ?? unquoteETag(payload.etag),
      modTime: payload.mod_time ?? null,
    };
  }

  /**
   * Delete one document.
   *
   * @param {string} key - Document key path
   * @param {object} [opts]
   * @param {string} [opts.ifMatch] - Only delete if the document still matches this ETag.
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<boolean>} True if deleted, false if the document did not exist.
   */
  async delete(key, { ifMatch, signal } = {}) {
    this.stats.deletes++;

    const headers = {};
    if (ifMatch) {
      headers['If-Match'] = `"${unquoteETag(ifMatch)}"`;
    }

    const response = await this.#request('DELETE', this.#docsUrl(key), { headers, signal }, key);

    if (response.status === 404) return false;
    if (!response.ok) {
      if (response.status === 412) this.stats.conflicts++;
      throw await this.#errorFrom(response, key);
    }
    return true;
  }

  /**
   * List document metadata under a key prefix.
   *
   * @param {object} [opts]
   * @param {string} [opts.prefix=''] - Path prefix, e.g. "cards/"
   * @param {number} [opts.limit=100] - Items per page (server caps at 1000)
   * @param {string} [opts.cursor] - Continuation cursor from previous list call
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<{items: Array<{key: string, etag: string, mod_time: string, size: number}>, nextCursor: string|null}>}
   */
  async list({ prefix = '', limit = 100, cursor, signal } = {}) {
    this.stats.lists++;

    const params = new URLSearchParams({ list: '1' });
    if (prefix) params.set('prefix', prefix);
    if (limit) params.set('limit', String(limit));
    if (cursor) params.set('cursor', cursor);

    const url = `${this.#docsUrl()}?${params}`;
    const response = await this.#request('GET', url, { signal }, prefix);

    if (!response.ok) throw await this.#errorFrom(response, prefix);

    const payload = await response.json();
    return {
      items: (payload.items ?? []).map((item) => ({
        ...item,
        etag: unquoteETag(item.etag),
      })),
      nextCursor: payload.next_cursor ?? null,
    };
  }

  /**
   * List all documents under a prefix, automatically iterating through cursors.
   *
   * @param {object} [opts]
   * @param {string} [opts.prefix='']
   * @param {number} [opts.pageLimit=1000]
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<Array<{key: string, etag: string, mod_time: string, size: number}>>}
   */
  async listAll({ prefix = '', pageLimit = 1000, signal } = {}) {
    const items = [];
    let cursor;
    do {
      const page = await this.list({ prefix, limit: pageLimit, cursor, signal });
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return items;
  }
}



export {
  JayDBClient,
  JayDBClient as JayDB,
  JayDBAuth,
  JayDBAuth as Auth,
  TreeACL,
  JayDBError,
  ConflictError,
  NotFoundError,
  AuthError,
  encodeKey,
  unquoteETag,
  beginLogin,
  completeLoginIfCallback,
  isSignedIn,
  identityClaims,
  ensureToken,
  currentToken,
  signOut,
  signBoardInvite,
  verifyBoardInvite,
  b64url,
  fromB64url
};
