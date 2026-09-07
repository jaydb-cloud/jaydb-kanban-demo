/**
 * jaydb.js — a dependency-free browser client for the JayDB Cloud document API.
 *
 * There is no build step and no server: this file talks straight to
 * https://{tenant}.jaydb.com/v1/n/{namespace}/docs/{key} over fetch().
 *
 * The only concept worth internalising is the ETag. Every document carries one,
 * every read hands it back, and every write can demand it — which is how several
 * browsers mutate the same data without a coordinating backend.
 */

/** Base class for every error this client raises. */
export class JayDBError extends Error {
  constructor(message, { status = 0, key = null, body = null } = {}) {
    super(message);
    this.name = 'JayDBError';
    this.status = status;
    this.key = key;
    this.body = body;
  }
}

/**
 * A precondition failed (HTTP 412). Either an `ifMatch` write lost a race, or a
 * `createOnly` write found the key already taken.
 *
 * This is the error you are meant to handle rather than avoid: re-read the
 * document, re-apply your change to the winning version, and write again.
 */
export class ConflictError extends JayDBError {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'ConflictError';
  }
}

/** The document or namespace does not exist (HTTP 404). */
export class NotFoundError extends JayDBError {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'NotFoundError';
  }
}

/** Credential missing, invalid, or not permitted here (HTTP 401 / 403). */
export class AuthError extends JayDBError {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'AuthError';
  }
}

/**
 * Percent-encode a document key without destroying its hierarchy.
 *
 * Keys are paths — `cards/abc123` is two segments, not a single opaque string —
 * so each segment is encoded independently and the separators are preserved.
 */
function encodeKey(key) {
  return String(key)
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .map(encodeURIComponent)
    .join('/');
}

/**
 * Strip the transport quoting from an ETag header (`"abc"` -> `abc`).
 *
 * The API returns the quoted form and accepts either, but an unquoted value is
 * easier to compare and cache against, so this client normalises on read.
 */
function unquoteETag(value) {
  if (!value) return null;
  return value.replace(/^W\//, '').replace(/^"/, '').replace(/"$/, '');
}

export class JayDB {
  /**
   * @param {object}   opts
   * @param {string}   opts.baseUrl    Tenant origin, e.g. "https://acme.jaydb.com".
   * @param {string}   opts.namespace  Namespace name, e.g. "default".
   * @param {string}   opts.apiKey     A `jcloud_sec_*` key. See the README's
   *                                   security note — this is a read-write
   *                                   credential and the browser can read it.
   */
  constructor({ baseUrl, namespace, apiKey }) {
    if (!baseUrl) throw new Error('jaydb: baseUrl is required');
    if (!namespace) throw new Error('jaydb: namespace is required');
    if (!apiKey) throw new Error('jaydb: apiKey is required');

    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.namespace = namespace;
    this.apiKey = apiKey;

    /** Request counters, surfaced in the demo's stats panel. */
    this.stats = { reads: 0, writes: 0, deletes: 0, lists: 0, conflicts: 0 };
  }

  #docsUrl(key = '') {
    const base = `${this.baseUrl}/v1/n/${encodeURIComponent(this.namespace)}/docs`;
    const encoded = encodeKey(key);
    return encoded ? `${base}/${encoded}` : base;
  }

  async #request(method, url, { headers = {}, body, signal } = {}, key = null) {
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: { 'X-JayDB-API-Key': this.apiKey, ...headers },
        body,
        signal,
        // The API authenticates on an explicit header, so ambient cookies are
        // never wanted. The gateway does not send Access-Control-Allow-Credentials.
        credentials: 'omit',
        mode: 'cors',
      });
    } catch (cause) {
      if (cause?.name === 'AbortError') throw cause;
      // A CORS rejection is indistinguishable from a network failure here, and
      // it is by far the likelier cause during first-time setup.
      throw new JayDBError(
        `Network or CORS failure calling ${method} ${url}. If the server is up, ` +
          `check that this page's origin is listed in JAYDB_CORS_ALLOWED_ORIGINS.`,
        { key, body: String(cause?.message ?? cause) },
      );
    }
    return response;
  }

  /** Parse an error response body, which is `{"error": "..."}` on every failure. */
  async #errorFrom(response, key) {
    let message = `${response.status} ${response.statusText}`;
    let body = null;
    try {
      body = await response.json();
      if (body?.error) message = body.error;
    } catch {
      /* a non-JSON error body is not worth failing over */
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

  /**
   * Read one document.
   *
   * @returns {Promise<{key: string, data: any, etag: string} | null>}
   *          `null` when the document does not exist — absence is a normal
   *          answer here, not an exception.
   */
  async get(key, { signal } = {}) {
    this.stats.reads++;
    const response = await this.#request('GET', this.#docsUrl(key), { signal }, key);

    if (response.status === 404) return null;
    if (!response.ok) throw await this.#errorFrom(response, key);

    return {
      key,
      data: await response.json(),
      etag: unquoteETag(response.headers.get('ETag')),
    };
  }

  /**
   * Write one document.
   *
   * @param {object}  opts
   * @param {string} [opts.ifMatch]     Only write if the stored ETag still
   *                                    matches — compare-and-swap. A losing
   *                                    write raises ConflictError instead of
   *                                    silently overwriting someone.
   * @param {boolean}[opts.createOnly]  Only write if the key is unused, via
   *                                    `If-None-Match: *`. Use this to allocate
   *                                    an id without risking a clobber.
   *
   * `ifMatch` wins if both are supplied — the server checks it first.
   */
  async put(key, data, { ifMatch, createOnly, signal } = {}) {
    this.stats.writes++;

    const headers = { 'Content-Type': 'application/json' };
    if (ifMatch) headers['If-Match'] = `"${unquoteETag(ifMatch)}"`;
    else if (createOnly) headers['If-None-Match'] = '*';

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

    // The header is authoritative; the body repeats it for convenience.
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
   * @param {object}  opts
   * @param {string} [opts.ifMatch]  Only delete if the stored ETag matches, so
   *                                 an edit that landed after your last read is
   *                                 not thrown away.
   * @returns {Promise<boolean>} `false` if the document was already gone.
   */
  async delete(key, { ifMatch, signal } = {}) {
    this.stats.deletes++;

    const headers = {};
    if (ifMatch) headers['If-Match'] = `"${unquoteETag(ifMatch)}"`;

    const response = await this.#request('DELETE', this.#docsUrl(key), { headers, signal }, key);

    if (response.status === 404) return false;
    if (!response.ok) {
      if (response.status === 412) this.stats.conflicts++;
      throw await this.#errorFrom(response, key);
    }
    return true;
  }

  /**
   * List keys under a prefix.
   *
   * Listing returns metadata only — `key`, `etag`, `mod_time`, `size` — never
   * document bodies. That is the feature the sync loop in `store.js` is built
   * on: the ETags let it decide what actually needs re-reading.
   *
   * @returns {Promise<{items: Array, nextCursor: string|null}>}
   */
  async list({ prefix = '', limit = 100, cursor, signal } = {}) {
    this.stats.lists++;

    const params = new URLSearchParams({ list: '1' });
    if (prefix) params.set('prefix', prefix);
    if (limit) params.set('limit', String(limit)); // server caps this at 1000
    if (cursor) params.set('cursor', cursor);

    const url = `${this.#docsUrl()}?${params}`;
    const response = await this.#request('GET', url, { signal }, prefix);

    if (!response.ok) throw await this.#errorFrom(response, prefix);

    const payload = await response.json();
    return {
      // The JSON `etag` field carries the storage layer's canonical form, which
      // has the quotes embedded in the value, while the ETag response header
      // does not. Normalise here so a caller can compare a listed ETag against
      // one from `get()` without tripping over the difference.
      items: (payload.items ?? []).map((item) => ({ ...item, etag: unquoteETag(item.etag) })),
      // Absent when the listing is complete.
      nextCursor: payload.next_cursor ?? null,
    };
  }

  /** Page through `list` until the cursor runs out. */
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
