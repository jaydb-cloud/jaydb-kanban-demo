/**
 * app.js — UI for the shared board.
 *
 * The interesting code is in `store.js`; this file is the thin layer that turns
 * store events into DOM. Two things here are worth noting:
 *
 *   - Rendering is driven entirely by store events, so a change made in another
 *     browser lands through exactly the same path as a local one. There is no
 *     separate "remote update" branch to keep in sync.
 *   - Local edits are applied optimistically and reconciled by the next sync
 *     pass, because a poll interval is too long to wait on before redrawing.
 */

import { JayDB, AuthError, JayDBError } from './jaydb.js';
import { BoardStore, newId, PRESENCE_TTL_MS } from './store.js';
import { CONFIG } from './config.js';
import {
  beginLogin as pkceBeginLogin,
  completeLoginIfCallback as pkceCompleteCallback,
  isSignedIn as pkceSignedIn,
  identityClaims as pkceIdentityClaims,
  ensureToken as pkceEnsureToken,
  currentToken as pkceCurrentToken,
  signOut as pkceSignOut,
} from './pkce.js';

const SETTINGS_KEY = 'jaydb_kanban_settings';
const CLIENT_ID_KEY = 'jaydb_kanban_client_id';

const $ = (id) => document.getElementById(id);

const els = {
  connect: $('connect'),
  connectForm: $('connect-form'),
  connectError: $('connect-error'),
  baseUrl: $('input-base-url'),
  namespace: $('input-namespace'),
  apiKey: $('input-api-key'),
  board: $('input-board'),
  name: $('input-name'),
  googleSignin: $('google-signin'),
  githubSignin: $('github-signin'),
  signedInAs: $('signed-in-as'),
  signinBlock: $('signin-block'),
  signinLabel: $('signin-label'),
  advancedConnect: $('advanced-connect'),

  boardView: $('board'),
  boardName: $('board-name'),
  boardKey: $('board-key'),
  presence: $('presence'),
  syncPill: $('sync-pill'),
  banner: $('banner'),
  columns: $('columns'),
  toggleInspector: $('toggle-inspector'),
  disconnect: $('disconnect'),

  inspector: $('inspector'),
  activity: $('activity'),

  cardDialog: $('card-dialog'),
  cardForm: $('card-form'),
  cardTitle: $('card-title'),
  cardNotes: $('card-notes'),
  cardMeta: $('card-meta'),
  cardDelete: $('card-delete'),
  cardCancel: $('card-cancel'),

  conflictDialog: $('conflict-dialog'),
  conflictMessage: $('conflict-message'),
  conflictTheirs: $('conflict-theirs'),
  conflictMine: $('conflict-mine'),
  conflictForce: $('conflict-force'),
  conflictDiscard: $('conflict-discard'),
};

/** @type {BoardStore | null} */
let store = null;
let editingCardId = null;
let pendingConflict = null;

// --- Settings -------------------------------------------------------------
//
// The API key lives in localStorage for this browser only. That keeps it out of
// the served files and out of the URL, which is the most a page with no backend
// can do; it does not make the key secret from this page's own scripts.

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');
  } catch {
    return null;
  }
}

function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function clientId() {
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = newId('client');
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

// --- Chrome ---------------------------------------------------------------

function showBanner(message, kind = 'error') {
  els.banner.textContent = message;
  els.banner.className = `banner banner--${kind}`;
  els.banner.hidden = false;
}

function hideBanner() {
  els.banner.hidden = true;
}

function setPill(state, text) {
  els.syncPill.className = `pill pill--${state}`;
  els.syncPill.textContent = text;
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  );
}

function initials(name) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

/** Deterministic colour per client, so an avatar keeps its identity across passes. */
function hueFor(text) {
  let hash = 0;
  for (const ch of text) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return hash;
}

function relativeTime(iso) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

// --- Rendering ------------------------------------------------------------

function renderBoard() {
  if (!store?.meta) return;

  els.boardName.textContent = store.meta.name ?? store.boardId;
  els.boardKey.textContent = `${store.cardsPrefix}*`;

  const columns = store.meta.columns ?? [];
  els.columns.style.setProperty('--column-count', String(columns.length));

  els.columns.innerHTML = columns
    .map((column) => {
      const cards = store.cardsIn(column.id);
      return `
        <section class="column" data-column="${escapeHtml(column.id)}">
          <header class="column__header">
            <h2 class="column__title" data-rename="${escapeHtml(column.id)}" title="Click to rename">
              ${escapeHtml(column.title)}
            </h2>
            <span class="column__count">${cards.length}</span>
          </header>
          <div class="column__drop" data-drop="${escapeHtml(column.id)}">
            ${cards.map(renderCard).join('')}
          </div>
          <button class="column__add" type="button" data-add="${escapeHtml(column.id)}">
            + Add card
          </button>
        </section>`;
    })
    .join('');
}

function renderCard(record) {
  const { id, data, etag } = record;
  return `
    <article class="card" draggable="true" data-card="${escapeHtml(id)}">
      <h3 class="card__title">${escapeHtml(data.title)}</h3>
      ${data.notes ? `<p class="card__notes">${escapeHtml(data.notes)}</p>` : ''}
      <footer class="card__footer">
        <span class="card__author">${escapeHtml(data.updatedBy ?? data.createdBy ?? '')}</span>
        <span class="card__etag" title="ETag — the version this write must match">
          ${escapeHtml((etag ?? '').slice(0, 8))}
        </span>
      </footer>
    </article>`;
}

function renderPresence() {
  if (!store) return;
  const now = Date.now();
  const people = [...store.presence.values()].filter((p) => now - p.lastSeen < PRESENCE_TTL_MS);

  els.presence.innerHTML = people
    .map((person) => {
      const isSelf = person.clientId === store.identity.clientId;
      return `<span
          class="avatar${isSelf ? ' avatar--self' : ''}"
          style="--hue: ${hueFor(person.clientId)}"
          title="${escapeHtml(person.name)}${isSelf ? ' (you)' : ''}"
        >${escapeHtml(initials(person.name))}</span>`;
    })
    .join('');
}

function renderActivity() {
  if (!store) return;
  els.activity.innerHTML = store.activity
    .map(
      (entry) => `
      <li class="activity__item">
        <span class="activity__actor">${escapeHtml(entry.data.actor ?? '')}</span>
        <span class="activity__text">${escapeHtml(entry.data.text ?? '')}</span>
        <time class="activity__time">${escapeHtml(relativeTime(entry.data.at))}</time>
      </li>`,
    )
    .join('');
}

function renderStats() {
  if (!store) return;
  const { reads, writes, deletes, lists, conflicts } = store.db.stats;
  const { passes, cardsFetched, cardsSkipped, lastSyncMs } = store.syncStats;

  $('stat-reads').textContent = reads;
  $('stat-writes').textContent = writes;
  $('stat-deletes').textContent = deletes;
  $('stat-lists').textContent = lists;
  $('stat-conflicts').textContent = conflicts;
  $('stat-passes').textContent = passes;
  $('stat-fetched').textContent = cardsFetched;
  $('stat-skipped').textContent = cardsSkipped;
  $('stat-duration').textContent = lastSyncMs ? `${lastSyncMs} ms` : '—';
}

// --- Interaction ----------------------------------------------------------

els.columns.addEventListener('click', async (event) => {
  const addButton = event.target.closest('[data-add]');
  if (addButton) return addCard(addButton.dataset.add);

  const renameTarget = event.target.closest('[data-rename]');
  if (renameTarget) return renameColumn(renameTarget.dataset.rename);

  const cardEl = event.target.closest('[data-card]');
  if (cardEl) return openCard(cardEl.dataset.card);
});

async function addCard(column) {
  const title = prompt('Card title');
  if (!title?.trim()) return;

  try {
    await store.createCard({ column, title });
    renderBoard();
    renderStats();
  } catch (error) {
    reportError(error);
  }
}

async function renameColumn(columnId) {
  const column = store.meta.columns.find((c) => c.id === columnId);
  const title = prompt('Column name', column?.title ?? '');
  if (!title?.trim() || title === column?.title) return;

  try {
    await store.renameColumn(columnId, title.trim());
    renderBoard();
  } catch (error) {
    // The board document is a single contended document, so a rename can lose.
    if (error?.status === 412) {
      showBanner('The column layout changed elsewhere — reloaded it. Try again.', 'warn');
      await store.sync();
      renderBoard();
      return;
    }
    reportError(error);
  }
}

function openCard(id) {
  const record = store.cards.get(id);
  if (!record) return;

  editingCardId = id;
  els.cardTitle.value = record.data.title ?? '';
  els.cardNotes.value = record.data.notes ?? '';
  els.cardMeta.textContent =
    `${store.cardKey(id)} · ETag ${record.etag?.slice(0, 12) ?? '?'} · ` +
    `last touched by ${record.data.updatedBy ?? 'unknown'} ${relativeTime(record.data.updatedAt)}`;
  els.cardDialog.showModal();
}

els.cardForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = editingCardId;
  if (!id) return;

  els.cardDialog.close();
  try {
    await store.editCard(id, { title: els.cardTitle.value, notes: els.cardNotes.value });
    renderBoard();
    renderStats();
  } catch (error) {
    reportError(error);
  }
});

els.cardCancel.addEventListener('click', () => els.cardDialog.close());

els.cardDelete.addEventListener('click', async () => {
  const id = editingCardId;
  if (!id) return;
  els.cardDialog.close();
  try {
    await store.deleteCard(id);
    renderBoard();
    renderStats();
  } catch (error) {
    reportError(error);
  }
});

// --- Drag and drop --------------------------------------------------------

let draggingId = null;

els.columns.addEventListener('dragstart', (event) => {
  const card = event.target.closest('[data-card]');
  if (!card) return;
  draggingId = card.dataset.card;
  card.classList.add('card--dragging');
  event.dataTransfer.effectAllowed = 'move';
  // Firefox will not start a drag without payload.
  event.dataTransfer.setData('text/plain', draggingId);
});

els.columns.addEventListener('dragend', (event) => {
  event.target.closest('[data-card]')?.classList.remove('card--dragging');
  els.columns.querySelectorAll('.column__drop--over').forEach((el) => {
    el.classList.remove('column__drop--over');
  });
  draggingId = null;
});

els.columns.addEventListener('dragover', (event) => {
  const drop = event.target.closest('[data-drop]');
  if (!drop || !draggingId) return;
  event.preventDefault();
  drop.classList.add('column__drop--over');
});

els.columns.addEventListener('dragleave', (event) => {
  event.target.closest('[data-drop]')?.classList.remove('column__drop--over');
});

els.columns.addEventListener('drop', async (event) => {
  const drop = event.target.closest('[data-drop]');
  if (!drop || !draggingId) return;
  event.preventDefault();
  drop.classList.remove('column__drop--over');

  const id = draggingId;
  draggingId = null;
  const column = drop.dataset.drop;

  // Order the card relative to where it was released, using a midpoint so
  // neighbouring cards never need rewriting.
  const order = orderForDrop(drop, event.clientY, id);

  const record = store.cards.get(id);
  if (!record || (record.data.column === column && record.data.order === order)) return;

  // Optimistic: redraw now, let the write and the next sync pass confirm.
  record.data = { ...record.data, column, order };
  renderBoard();

  try {
    const result = await store.moveCard(id, { column, order });
    if (result?.attempts > 1) {
      showBanner(
        `Move retried ${result.attempts - 1}× — someone else was editing that card. Applied cleanly.`,
        'info',
      );
      setTimeout(hideBanner, 4000);
    }
    renderStats();
  } catch (error) {
    await store.sync();
    renderBoard();
    reportError(error);
  }
});

function orderForDrop(drop, clientY, movingId) {
  const siblings = [...drop.querySelectorAll('[data-card]')]
    .filter((el) => el.dataset.card !== movingId)
    .map((el) => ({ el, order: store.cards.get(el.dataset.card)?.data.order ?? 0 }));

  const insertIndex = siblings.findIndex(({ el }) => {
    const box = el.getBoundingClientRect();
    return clientY < box.top + box.height / 2;
  });

  if (siblings.length === 0) return Date.now();
  if (insertIndex === -1) return siblings.at(-1).order + 1000;
  if (insertIndex === 0) return siblings[0].order - 1000;
  return Math.round((siblings[insertIndex - 1].order + siblings[insertIndex].order) / 2);
}

// --- Conflict resolution --------------------------------------------------

function showConflict(detail) {
  pendingConflict = detail;
  els.conflictMessage.textContent = detail.message;
  els.conflictTheirs.textContent = detail.theirs
    ? JSON.stringify(
        { title: detail.theirs.title, notes: detail.theirs.notes, by: detail.theirs.updatedBy },
        null,
        2,
      )
    : '(the card was deleted)';
  els.conflictMine.textContent = detail.mine
    ? JSON.stringify({ title: detail.mine.title, notes: detail.mine.notes }, null, 2)
    : '(no local version)';

  els.conflictForce.hidden = !detail.mine || !detail.theirs;
  els.conflictDialog.showModal();
}

els.conflictDiscard.addEventListener('click', async () => {
  els.conflictDialog.close();
  pendingConflict = null;
  await store.sync();
  renderBoard();
});

els.conflictForce.addEventListener('click', async () => {
  const conflict = pendingConflict;
  els.conflictDialog.close();
  pendingConflict = null;
  if (!conflict?.mine) return;

  try {
    await store.forceCard(conflict.cardId, conflict.mine);
    renderBoard();
    renderStats();
  } catch (error) {
    reportError(error);
  }
});

// --- Errors ---------------------------------------------------------------

function reportError(error) {
  console.error(error);

  if (error instanceof AuthError) {
    showBanner(`${error.message} — the API key may be wrong or scoped to another namespace.`);
    return;
  }
  if (error instanceof JayDBError && error.status === 0) {
    showBanner(error.message, 'warn');
    return;
  }
  showBanner(error?.message ?? String(error));
}

// --- Wiring ---------------------------------------------------------------

els.toggleInspector.addEventListener('click', () => {
  els.inspector.hidden = !els.inspector.hidden;
  els.boardView.classList.toggle('board--inspecting', !els.inspector.hidden);
});

els.disconnect.addEventListener('click', async () => {
  await store?.leave();
  store = null;
  els.boardView.hidden = true;
  els.connect.hidden = false;
});

els.connectForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  els.connectError.hidden = true;

  // This is the API-key / advanced path (the submit button lives inside the
  // advanced disclosure). Tenant and namespace fall back to config so a user
  // only needs to paste a key.
  const settings = {
    baseUrl: (els.baseUrl.value.trim() || CONFIG.oidc?.issuer || '').replace(/\/+$/, ''),
    namespace: els.namespace.value.trim() || CONFIG.oidc?.namespace || 'default',
    apiKey: els.apiKey.value.trim(),
    boardId: els.board.value.trim() || 'demo',
    name: els.name.value.trim() || 'Player',
  };

  if (!settings.baseUrl) {
    els.connectError.textContent = 'Enter a tenant URL (or configure oidc.issuer and sign in instead).';
    els.connectError.hidden = false;
    return;
  }
  if (!settings.apiKey) {
    els.connectError.textContent = 'Enter an API key, or sign in above instead.';
    els.connectError.hidden = false;
    return;
  }

  try {
    await connect(settings);
    saveSettings(settings);
  } catch (error) {
    console.error(error);
    els.connectError.textContent =
      error instanceof AuthError
        ? `${error.message} — check the key and that it covers namespace “${settings.namespace}”.`
        : (error?.message ?? String(error));
    els.connectError.hidden = false;
  }
});

async function connect(settings) {
  // When signed in via OIDC, authorize by the token's scopes: the server knows
  // the user and enforces read/write per key. Otherwise fall back to the API key.
  const signedIn = pkceSignedIn();
  const db = new JayDB({
    baseUrl: settings.baseUrl,
    namespace: settings.namespace,
    ...(signedIn ? { getToken: pkceCurrentToken } : { apiKey: settings.apiKey }),
  });

  store = new BoardStore(db, settings.boardId, {
    clientId: clientId(),
    name: settings.name,
  });

  store.addEventListener('meta', renderBoard);
  store.addEventListener('cards', () => {
    renderBoard();
    renderStats();
  });
  store.addEventListener('presence', renderPresence);
  store.addEventListener('activity', renderActivity);
  store.addEventListener('synced', () => {
    setPill('ok', `synced ${store.syncStats.lastSyncMs}ms`);
    renderStats();
    hideBanner();
  });
  store.addEventListener('conflict', (event) => showConflict(event.detail));
  store.addEventListener('retry', (event) => {
    setPill('warn', `retrying ${event.detail.description}…`);
  });
  store.addEventListener('error', (event) => {
    setPill('error', 'sync failed');
    const seconds = Math.round(event.detail.retryInMs / 1000);
    showBanner(`${event.detail.error.message} Retrying in ${seconds}s.`, 'warn');
  });

  setPill('sync', 'opening…');

  // This is the first request, so it is also the credential and CORS check.
  await store.open();
  await store.heartbeat();
  await store.sync();
  await store.loadActivity();

  renderBoard();
  renderPresence();
  renderActivity();
  renderStats();
  setPill('ok', 'synced');

  store.startPolling();

  els.connect.hidden = true;
  els.boardView.hidden = false;
}

// Withdraw presence on close so other clients drop the avatar promptly. Not
// guaranteed to run, which is exactly why presence also expires on age.
window.addEventListener('pagehide', () => {
  if (!store) return;
  navigator.sendBeacon?.('data:,'); // keep the tab alive a beat longer
  store.leave();
});

// Refresh relative timestamps without a sync pass.
setInterval(() => {
  if (store && !els.inspector.hidden) renderActivity();
}, 30_000);

// --- Sign-in --------------------------------------------------------------
//
// Two modes, chosen by config:
//
//  * CONFIG.oidc.issuer SET  -> real PKCE against the JayDB tenant. The token it
//    yields is sent as Authorization: Bearer and the SERVER authorizes by its
//    scopes (jaydb-cloud#58). This is the mode where sign-in actually gates data
//    and where GitHub works (the tenant issuer holds GitHub's secret).
//
//  * CONFIG.oidc.issuer EMPTY -> identity-only Google (GIS), which fills in the
//    name/avatar but does NOT gate data — data still rides on the API key. GitHub
//    is impossible in this mode (no secret in a static page), so its button stays
//    disabled.

const oidcEnabled = () => Boolean(CONFIG.oidc?.issuer && CONFIG.oidc?.clientId);

function connectContext() {
  // The connect-form values to restore after the authorize redirect returns.
  return {
    baseUrl: els.baseUrl.value.trim().replace(/\/+$/, '') || CONFIG.oidc.issuer,
    namespace: els.namespace.value.trim() || CONFIG.oidc.namespace,
    boardId: els.board.value.trim() || 'demo',
    name: els.name.value.trim(),
  };
}

async function startPkce(idp) {
  try {
    await pkceBeginLogin({
      issuer: CONFIG.oidc.issuer,
      clientId: CONFIG.oidc.clientId,
      scopes: CONFIG.oidc.scopes ?? [],
      idp,
      context: connectContext(),
    });
    // beginLogin navigates away; nothing after this runs.
  } catch (error) {
    console.error(error);
    els.connectError.textContent = error?.message ?? String(error);
    els.connectError.hidden = false;
  }
}

/** Decode a JWT payload without verifying it — display-only fields. */
function decodeJwtPayload(jwt) {
  try {
    const [, payload] = jwt.split('.');
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

function applyIdentityOnly({ name, email }) {
  if (name) els.name.value = name;
  els.signedInAs.hidden = false;
  els.signedInAs.textContent = `Signed in as ${name || email}. This sets your name only — data still uses the API key.`;
}

// Identity-only Google (GIS), used only when OIDC is not configured.
function initGoogleIdentityOnly() {
  if (!CONFIG.googleClientId) {
    els.googleSignin.innerHTML =
      '<span class="signin__hint">Set googleClientId in config.js to enable Google sign-in.</span>';
    return;
  }
  if (!window.google?.accounts?.id) {
    setTimeout(initGoogleIdentityOnly, 300);
    return;
  }
  window.google.accounts.id.initialize({
    client_id: CONFIG.googleClientId,
    callback: (response) => {
      const claims = decodeJwtPayload(response.credential);
      if (claims) applyIdentityOnly({ name: claims.name, email: claims.email });
    },
  });
  window.google.accounts.id.renderButton(els.googleSignin, {
    theme: 'filled_black',
    size: 'large',
    text: 'signin_with',
    shape: 'pill',
  });
}

function initSignin() {
  if (oidcEnabled()) {
    // Sign-in is the primary path: the token gates data. Lead with it, keep the
    // API-key fields collapsed as an advanced escape hatch.
    els.signinLabel.textContent = 'Sign in to play';
    els.advancedConnect.open = false;

    els.googleSignin.innerHTML =
      '<button type="button" class="button button--primary">Sign in with Google</button>';
    els.googleSignin.querySelector('button').addEventListener('click', () => startPkce('google'));

    els.githubSignin.disabled = false;
    els.githubSignin.classList.remove('signin__github');
    els.githubSignin.title = 'Sign in with GitHub via your JayDB tenant';
    els.githubSignin.addEventListener('click', () => startPkce('github'));
  } else {
    // No issuer configured: the API-key path is the only one that reaches data,
    // and Google is identity-only. Lead with the API-key fields (open), and keep
    // sign-in as the name/avatar helper it is in this mode.
    els.signinLabel.textContent = 'Or sign in for your name & avatar (does not gate data)';
    els.advancedConnect.open = true;
    initGoogleIdentityOnly();
  }
}

// --- pagehide / timers ----------------------------------------------------

// Withdraw presence on close so other clients drop the avatar promptly. Not
// guaranteed to run, which is exactly why presence also expires on age.
window.addEventListener('pagehide', () => {
  if (!store) return;
  navigator.sendBeacon?.('data:,');
  store.leave();
});

setInterval(() => {
  if (store && !els.inspector.hidden) renderActivity();
}, 30_000);

// --- Boot -----------------------------------------------------------------

(async function boot() {
  const saved = loadSettings();
  if (saved) {
    els.baseUrl.value = saved.baseUrl ?? '';
    els.namespace.value = saved.namespace ?? 'default';
    els.board.value = saved.boardId ?? 'demo';
    els.name.value = saved.name ?? '';
    els.apiKey.value = saved.apiKey ?? '';
  }
  els.connect.hidden = false;
  initSignin();

  // If we returned from a PKCE authorize redirect, finish the exchange and open
  // the board straight away using the token — no API key needed.
  if (oidcEnabled()) {
    try {
      const ctx = await pkceCompleteCallback({ clientId: CONFIG.oidc.clientId });
      if (ctx) {
        // Refresh the token if needed, then connect with the token getter.
        await pkceEnsureToken();
        const claims = pkceIdentityClaims();
        const settings = {
          baseUrl: ctx.baseUrl || CONFIG.oidc.issuer,
          namespace: ctx.namespace || CONFIG.oidc.namespace,
          boardId: ctx.boardId || 'demo',
          name: ctx.name || claims?.name || claims?.email || 'Player',
          apiKey: '',
        };
        await connect(settings);
      }
    } catch (error) {
      console.error(error);
      els.connectError.textContent = error?.message ?? String(error);
      els.connectError.hidden = false;
    }
  }
})();
