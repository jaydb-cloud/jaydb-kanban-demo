/**
 * store.js — the board's data layer.
 *
 * Everything here is a pattern worth stealing. Five of them, each solving a
 * different concurrency problem with the same three primitives (ETag reads,
 * conditional writes, prefix lists):
 *
 *   1. Contended single document  — the board's column layout. Conditional
 *      writes, conflicts surfaced.
 *   2. Document-per-item          — one document per card, so two people editing
 *      two cards never contend at all. Concurrency granularity follows document
 *      granularity, which is the main thing to take away.
 *   3. Create-only allocation     — `If-None-Match: *` makes a client-generated
 *      id safe: a collision fails loudly instead of overwriting a stranger.
 *   4. Append-only unique keys    — the activity feed. Writes cannot conflict
 *      because no two writers ever target the same key.
 *   5. Expiry by convention       — presence. Nobody holds a connection open;
 *      staleness is judged from a timestamp and any client may reap.
 *
 * Reads are kept cheap by the sync loop: a list returns each key's ETag, so only
 * documents whose ETag actually moved get re-read.
 */

import { ConflictError, NotFoundError, AuthError } from './jaydb.js';

/** A presence record older than this is treated as gone. */
const PRESENCE_TTL_MS = 30_000;
/** A presence record older than this may be deleted by anyone. */
const PRESENCE_REAP_MS = 120_000;
/** Activity entries retained in the feed. */
const ACTIVITY_PAGE = 30;
/** Concurrent document reads per sync pass. */
const READ_CONCURRENCY = 6;

const DEFAULT_COLUMNS = [
  { id: 'todo', title: 'To do' },
  { id: 'doing', title: 'In progress' },
  { id: 'done', title: 'Done' },
];

/** Short, URL-safe, collision-resistant enough to pair with a create-only write. */
function newId(prefix = '') {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  const body = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return prefix ? `${prefix}_${body}` : body;
}

/** Run `worker` over `items` with a bounded number of requests in flight. */
async function mapLimit(items, limit, worker) {
  const results = [];
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export class BoardStore extends EventTarget {
  /**
   * @param {import('./jaydb.js').JayDB} db
   * @param {string} boardId  Board slug; becomes part of every key.
   * @param {{clientId: string, name: string}} identity
   * @param {'own' | 'write' | 'read'} [role='own']
   */
  constructor(db, boardId, identity, role = 'own') {
    super();
    this.db = db;
    this.boardId = boardId;
    this.identity = identity;
    this.role = role || 'own';

    /** @type {{name: string, columns: Array<{id: string, title: string}>} | null} */
    this.meta = null;
    this.metaETag = null;

    /**
     * Local mirror of the cards, keyed by card id.
     * @type {Map<string, {id: string, data: object, etag: string}>}
     */
    this.cards = new Map();

    /** @type {Map<string, {clientId: string, name: string, lastSeen: number}>} */
    this.presence = new Map();

    /** @type {Array<{key: string, data: object}>} */
    this.activity = [];

    /** Sync-loop bookkeeping, surfaced in the stats panel. */
    this.syncStats = { passes: 0, cardsFetched: 0, cardsSkipped: 0, lastSyncMs: 0 };

    this.polling = false;
    this.#pollTimer = null;
    this.#heartbeatTimer = null;
  }

  #pollTimer;
  #heartbeatTimer;

  // --- Key layout -----------------------------------------------------------
  //
  // Keys are hierarchical paths, which is what makes prefix listing useful.
  // Everything for one board sits under `boards/{boardId}/`.

  get metaKey() {
    return `boards/${this.boardId}/meta`;
  }
  get cardsPrefix() {
    return `boards/${this.boardId}/cards/`;
  }
  cardKey(id) {
    return `${this.cardsPrefix}${id}`;
  }
  get presencePrefix() {
    return `boards/${this.boardId}/presence/`;
  }
  presenceKey(clientId) {
    return `${this.presencePrefix}${clientId}`;
  }
  get activityPrefix() {
    return `boards/${this.boardId}/activity/`;
  }

  #emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  canWrite() {
    return this.role === 'own' || this.role === 'write';
  }

  canAdmin() {
    return this.role === 'own';
  }

  // --- Pattern 1 & 3: the board document ------------------------------------

  /**
   * Load the board, creating it on first visit.
   *
   * The create uses `createOnly`, so two people opening a fresh board URL at the
   * same moment cannot overwrite each other: the loser gets a ConflictError and
   * simply reads what the winner wrote.
   */
  async open() {
    const existing = await this.db.get(this.metaKey);
    if (existing) {
      this.meta = existing.data;
      this.metaETag = existing.etag;
      if (this.meta.ownerId && this.meta.ownerId === this.identity.clientId) {
        this.role = 'own';
      }
      this.#emit('meta');
      return { created: false };
    }

    const fresh = {
      name: this.boardId,
      columns: DEFAULT_COLUMNS,
      createdAt: new Date().toISOString(),
      createdBy: this.identity.name,
      ownerId: this.identity.clientId,
    };

    try {
      const written = await this.db.put(this.metaKey, fresh, { createOnly: true });
      this.meta = fresh;
      this.metaETag = written.etag;
      this.role = 'own';
      this.#emit('meta');
      return { created: true };
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      // Someone created it in the gap between our read and our write.
      const winner = await this.db.get(this.metaKey);
      this.meta = winner.data;
      this.metaETag = winner.etag;
      this.#emit('meta');
      return { created: false, raced: true };
    }
  }

  /**
   * Rename a column. A contended single document, so the write is conditional
   * and a lost race is reported rather than papered over.
   */
  async renameColumn(columnId, title) {
    if (!this.canWrite()) throw new AuthError('Read-only: cannot rename columns');
    const next = structuredClone(this.meta);
    const column = next.columns.find((c) => c.id === columnId);
    if (!column) throw new Error(`no such column: ${columnId}`);
    column.title = title;

    const written = await this.db.put(this.metaKey, next, { ifMatch: this.metaETag });
    this.meta = next;
    this.metaETag = written.etag;
    this.#emit('meta');
  }

  // --- Pattern 2: one document per card -------------------------------------

  async createCard({ column, title }) {
    if (!this.canWrite()) throw new AuthError('Read-only: cannot create cards');
    const id = newId('card');
    const data = {
      id,
      title: title.trim(),
      notes: '',
      column,
      // Sparse ordering: leaves room to insert between two cards without
      // rewriting either of them.
      order: Date.now(),
      createdBy: this.identity.name,
      updatedBy: this.identity.name,
      updatedAt: new Date().toISOString(),
    };

    const written = await this.db.put(this.cardKey(id), data, { createOnly: true });
    this.cards.set(id, { id, data, etag: written.etag });
    this.#emit('cards');
    this.logActivity(`added “${data.title}”`);
    return id;
  }

  async deleteCard(id) {
    if (!this.canWrite()) throw new AuthError('Read-only: cannot delete cards');
    const record = this.cards.get(id);
    if (!record) return;

    try {
      // Conditional delete: if someone edited this card since our last read, the
      // delete fails rather than discarding their change unseen.
      await this.db.delete(this.cardKey(id), { ifMatch: record.etag });
    } catch (error) {
      if (error instanceof ConflictError) {
        const fresh = await this.#fetchCard(id);
        this.#emit('conflict', {
          kind: 'delete',
          cardId: id,
          theirs: fresh?.data ?? null,
          message: 'That card was edited elsewhere while you were deleting it.',
        });
        return;
      }
      throw error;
    }

    this.cards.delete(id);
    this.#emit('cards');
    this.logActivity(`deleted “${record.data.title}”`);
  }

  /**
   * Move a card, auto-merging on conflict.
   *
   * A move touches only `column` and `order`, so re-applying it to whatever
   * version won the race is well defined — the mutation is replayed against
   * fresh data rather than blindly overwriting it. This is the difference
   * between "handling a conflict" and "ignoring a conflict".
   */
  async moveCard(id, { column, order }) {
    if (!this.canWrite()) throw new AuthError('Read-only: cannot move cards');
    return this.#mutateCard(id, (data) => ({ ...data, column, order }), {
      description: 'move',
    });
  }

  /**
   * Edit a card's text, surfacing conflicts instead of merging them.
   *
   * Two people rewriting the same sentence is not mechanically resolvable, so
   * the losing writer is shown both versions and chooses. Compare with
   * `moveCard`: same primitive, different policy, because the intent differs.
   */
  async editCard(id, { title, notes }) {
    if (!this.canWrite()) throw new AuthError('Read-only: cannot edit cards');
    const record = this.cards.get(id) ?? (await this.#fetchCard(id));
    if (!record) throw new NotFoundError('card no longer exists', { key: this.cardKey(id) });

    const next = {
      ...record.data,
      title: title ?? record.data.title,
      notes: notes ?? record.data.notes,
      updatedBy: this.identity.name,
      updatedAt: new Date().toISOString(),
    };

    try {
      const written = await this.db.put(this.cardKey(id), next, { ifMatch: record.etag });
      this.cards.set(id, { id, data: next, etag: written.etag });
      this.#emit('cards');
      this.logActivity(`edited “${next.title}”`);
      return { ok: true };
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;

      const theirs = await this.#fetchCard(id);
      this.#emit('conflict', {
        kind: 'edit',
        cardId: id,
        mine: next,
        theirs: theirs?.data ?? null,
        message: 'Someone else saved this card first.',
      });
      return { ok: false, conflict: true };
    }
  }

  /** Resolve an edit conflict by overwriting with the local version. */
  async forceCard(id, data) {
    if (!this.canWrite()) throw new AuthError('Read-only: cannot edit cards');
    const record = this.cards.get(id) ?? (await this.#fetchCard(id));
    const written = await this.db.put(
      this.cardKey(id),
      { ...data, updatedBy: this.identity.name, updatedAt: new Date().toISOString() },
      { ifMatch: record?.etag },
    );
    this.cards.set(id, { id, data, etag: written.etag });
    this.#emit('cards');
  }

  /**
   * Read-modify-write with bounded retry, re-applying `mutate` to the freshest
   * version each attempt.
   */
  async #mutateCard(id, mutate, { retries = 4, description = 'update' } = {}) {
    let record = this.cards.get(id) ?? (await this.#fetchCard(id));

    for (let attempt = 0; ; attempt++) {
      if (!record) throw new NotFoundError('card no longer exists', { key: this.cardKey(id) });

      const next = {
        ...mutate(structuredClone(record.data)),
        updatedBy: this.identity.name,
        updatedAt: new Date().toISOString(),
      };

      try {
        const written = await this.db.put(this.cardKey(id), next, { ifMatch: record.etag });
        this.cards.set(id, { id, data: next, etag: written.etag });
        this.#emit('cards');
        return { ok: true, attempts: attempt + 1 };
      } catch (error) {
        if (!(error instanceof ConflictError) || attempt >= retries) throw error;

        this.#emit('retry', { cardId: id, attempt: attempt + 1, description });
        record = await this.#fetchCard(id); // re-read the winner, then replay
        if (!record) return { ok: false, gone: true };
      }
    }
  }

  async #fetchCard(id) {
    const doc = await this.db.get(this.cardKey(id));
    if (!doc) {
      this.cards.delete(id);
      return null;
    }
    const record = { id, data: doc.data, etag: doc.etag };
    this.cards.set(id, record);
    return record;
  }

  // --- Pattern 4: append-only activity --------------------------------------

  /**
   * Append to the feed. The key embeds a timestamp and a random suffix, so two
   * writers never target the same document and a conditional write is
   * unnecessary — the cheapest kind of concurrent write there is.
   *
   * Fire-and-forget: the feed is decoration, and a failure here must not fail
   * the board action that triggered it.
   */
  logActivity(text) {
    const stamp = String(Date.now()).padStart(14, '0');
    const key = `${this.activityPrefix}${stamp}_${newId()}`;
    const entry = { text, actor: this.identity.name, at: new Date().toISOString() };
    this.db.put(key, entry, { createOnly: true }).catch(() => {
      /* the feed is not worth interrupting the user for */
    });
  }

  /** Newest entries. Keys sort lexicographically by timestamp, so this is just a tail. */
  async loadActivity() {
    const { items } = await this.db.list({ prefix: this.activityPrefix, limit: 1000 });
    const newest = items.sort((a, b) => (a.key < b.key ? 1 : -1)).slice(0, ACTIVITY_PAGE);

    const loaded = await mapLimit(newest, READ_CONCURRENCY, async (item) => {
      const doc = await this.db.get(item.key);
      return doc ? { key: item.key, data: doc.data } : null;
    });

    this.activity = loaded.filter(Boolean);
    this.#emit('activity');
  }

  // --- Pattern 5: presence, expiring by convention --------------------------

  /**
   * Announce this client. Deliberately unconditional: presence is
   * last-writer-wins by nature, and only this client ever writes this key.
   */
  async heartbeat() {
    await this.db.put(this.presenceKey(this.identity.clientId), {
      clientId: this.identity.clientId,
      name: this.identity.name,
      at: new Date().toISOString(),
    });
  }

  /** Best-effort withdrawal, so a closing tab disappears promptly. */
  async leave() {
    this.stopPolling();
    try {
      await this.db.delete(this.presenceKey(this.identity.clientId));
    } catch {
      /* the reaper will collect it soon enough */
    }
  }

  async #syncPresence() {
    const { items } = await this.db.list({ prefix: this.presencePrefix, limit: 200 });
    const now = Date.now();
    const next = new Map();
    const reap = [];

    await mapLimit(items, READ_CONCURRENCY, async (item) => {
      const modified = Date.parse(item.mod_time);
      const age = Number.isNaN(modified) ? 0 : now - modified;

      // Nothing expires server-side, so anyone may collect abandoned records.
      if (age > PRESENCE_REAP_MS) {
        reap.push(item);
        return;
      }
      if (age > PRESENCE_TTL_MS) return; // stale, but not yet ours to delete

      const doc = await this.db.get(item.key);
      if (doc?.data?.clientId) {
        next.set(doc.data.clientId, { ...doc.data, lastSeen: modified });
      }
    });

    this.presence = next;
    this.#emit('presence');

    for (const item of reap) {
      this.db.delete(item.key, { ifMatch: item.etag }).catch(() => {});
    }
  }

  // --- The sync loop --------------------------------------------------------

  /**
   * One sync pass.
   *
   * The efficient part: a list returns every key's ETag, so a card is re-read
   * only when its ETag differs from the copy already in memory. A quiet board
   * costs one list request per pass regardless of how many cards it holds.
   */
  async sync() {
    const startedAt = performance.now();

    const { items } = await this.db.list({ prefix: this.cardsPrefix, limit: 1000 });
    const seen = new Set();
    const stale = [];

    for (const item of items) {
      const id = item.key.slice(this.cardsPrefix.length);
      if (!id) continue;
      seen.add(id);

      const known = this.cards.get(id);
      if (known && known.etag === item.etag) this.syncStats.cardsSkipped++;
      // Carry the listed ETag: if the response header turns out to be
      // unreadable, this spares the client a recovery request per card.
      else stale.push({ id, key: item.key, etag: item.etag });
    }

    await mapLimit(stale, READ_CONCURRENCY, async ({ id, key, etag }) => {
      const doc = await this.db.get(key, { knownETag: etag });
      if (doc) {
        this.cards.set(id, { id, data: doc.data, etag: doc.etag });
        this.syncStats.cardsFetched++;
      }
    });

    // Anything absent from the listing was deleted by someone else.
    for (const id of [...this.cards.keys()]) {
      if (!seen.has(id)) this.cards.delete(id);
    }

    // Cheap to re-read, and it is what reveals a remote column rename.
    const meta = await this.db.get(this.metaKey);
    if (meta && meta.etag !== this.metaETag) {
      this.meta = meta.data;
      this.metaETag = meta.etag;
      this.#emit('meta');
    }

    await this.#syncPresence();

    this.syncStats.passes++;
    this.syncStats.lastSyncMs = Math.round(performance.now() - startedAt);
    this.#emit('cards');
    this.#emit('synced');
  }

  /**
   * Poll, because the API is request/response — there is no server holding a
   * socket open. Backs off on failure instead of hammering a sick endpoint.
   */
  startPolling({ intervalMs = 2500, heartbeatMs = 10_000 } = {}) {
    if (this.polling) return;
    this.polling = true;

    let backoff = intervalMs;
    const tick = async () => {
      if (!this.polling) return;
      try {
        await this.sync();
        backoff = intervalMs;
      } catch (error) {
        backoff = Math.min(backoff * 2, 30_000);
        this.#emit('error', { error, phase: 'sync', retryInMs: backoff });
      }
      if (this.polling) this.#pollTimer = setTimeout(tick, backoff);
    };
    this.#pollTimer = setTimeout(tick, intervalMs);

    const beat = async () => {
      if (!this.polling) return;
      try {
        await this.heartbeat();
      } catch {
        /* presence is not worth reporting */
      }
      if (this.polling) this.#heartbeatTimer = setTimeout(beat, heartbeatMs);
    };
    this.#heartbeatTimer = setTimeout(beat, heartbeatMs);
  }

  stopPolling() {
    this.polling = false;
    clearTimeout(this.#pollTimer);
    clearTimeout(this.#heartbeatTimer);
  }

  /** Cards for one column, in display order. */
  cardsIn(columnId) {
    return [...this.cards.values()]
      .filter((record) => record.data.column === columnId)
      .sort((a, b) => (a.data.order ?? 0) - (b.data.order ?? 0));
  }
}

export { newId, PRESENCE_TTL_MS };
