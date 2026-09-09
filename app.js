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

import {
  JayDB,
  AuthError,
  JayDBError,
  signBoardInvite,
  verifyBoardInvite,
  beginLogin as pkceBeginLogin,
  completeLoginIfCallback as pkceCompleteCallback,
  isSignedIn as pkceSignedIn,
  identityClaims as pkceIdentityClaims,
  ensureToken as pkceEnsureToken,
  currentToken as pkceCurrentToken,
  signOut as pkceSignOut,
} from './jaydb-cloud-sdk.js';
import { BoardStore, newId, PRESENCE_TTL_MS } from './store.js';
import { CONFIG } from './config.js';

const SETTINGS_KEY = 'jaydb_kanban_settings';
const CLIENT_ID_KEY = 'jaydb_kanban_client_id';
const BOARDS_REGISTRY_KEY = 'jaydb_kanban_boards';

const $ = (id) => document.getElementById(id);

const els = {
  connect: $('connect'),
  connectError: $('connect-error'),
  signinBlock: $('signin-block'),
  signinLoader: $('signin-loader'),
  signinLoaderTitle: $('signin-loader-title'),
  signinLoaderStep: $('signin-loader-step'),
  board: $('input-board'),
  googleSignin: $('google-signin'),
  githubSignin: $('github-signin'),
  signedInAs: $('signed-in-as'),

  boardView: $('board'),
  boardName: $('board-name'),
  roleBadge: $('role-badge'),
  boardKey: $('board-key'),
  presence: $('presence'),
  syncPill: $('sync-pill'),
  banner: $('banner'),
  columns: $('columns'),
  openInvite: $('open-invite'),
  toggleStats: $('toggle-stats') || $('toggle-inspector'),
  toggleInspector: $('toggle-stats') || $('toggle-inspector'),
  disconnect: $('disconnect'),

  inviteDialog: $('invite-dialog'),
  inviteResult: $('invite-result'),
  inviteLinkInput: $('invite-link-input'),
  inviteCopyBtn: $('invite-copy-btn'),
  inviteCopyFeedback: $('invite-copy-feedback'),
  inviteCancel: $('invite-cancel'),
  inviteGenerateBtn: $('invite-generate-btn'),

  statsPanel: $('stats-panel') || $('inspector'),
  inspector: $('stats-panel') || $('inspector'),
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

// --- Settings & Board Registry --------------------------------------------

function getBoardMemberships() {
  try {
    return JSON.parse(localStorage.getItem(BOARDS_REGISTRY_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function getBoardMembership(boardId) {
  const all = getBoardMemberships();
  return all[boardId] ?? null;
}

function saveBoardMembership(boardId, role, inviter = null) {
  const all = getBoardMemberships();
  all[boardId] = {
    boardId,
    role: role || 'own',
    inviter,
    updatedAt: Date.now(),
  };
  localStorage.setItem(BOARDS_REGISTRY_KEY, JSON.stringify(all));
}
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

function setPill(state, text, title = '') {
  els.syncPill.className = `pill pill--${state}`;
  els.syncPill.textContent = text;
  if (title) {
    els.syncPill.title = title;
  } else {
    els.syncPill.removeAttribute('title');
  }
}

function updateLatencyPill() {
  if (!store?.db?.stats) return;
  const { avgLatencyMs, totalRequests } = store.db.stats;
  if (avgLatencyMs) {
    setPill(
      'ok',
      `${avgLatencyMs}ms avg`,
      `Average API request latency: ${avgLatencyMs}ms (${totalRequests} requests)`,
    );
  } else {
    setPill('ok', 'synced');
  }
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

  // Update role badge and invite button
  if (els.roleBadge) {
    els.roleBadge.className = `role-badge role-badge--${store.role}`;
    if (store.role === 'own') {
      els.roleBadge.textContent = 'Owner';
      els.roleBadge.title = 'You own this board and can invite members';
    } else if (store.role === 'write') {
      els.roleBadge.textContent = 'Editor';
      els.roleBadge.title = 'You have read-write access to this board';
    } else {
      els.roleBadge.textContent = 'Read-Only';
      els.roleBadge.title = 'You have view-only access to this board';
    }
  }

  if (els.openInvite) {
    els.openInvite.hidden = !store.canAdmin();
  }

  const columns = store.meta.columns ?? [];
  els.columns.style.setProperty('--column-count', String(columns.length));

  const canWrite = store.canWrite();

  els.columns.innerHTML = columns
    .map((column) => {
      const cards = store.cardsIn(column.id);
      return `
        <section class="column" data-column="${escapeHtml(column.id)}">
          <header class="column__header">
            <h2 class="column__title${canWrite ? '' : ' column__title--readonly'}" data-rename="${canWrite ? escapeHtml(column.id) : ''}" title="${canWrite ? 'Click to rename' : ''}">
              ${escapeHtml(column.title)}
            </h2>
            <span class="column__count">${cards.length}</span>
          </header>
          <div class="column__drop" data-drop="${escapeHtml(column.id)}">
            ${cards.map((c) => renderCard(c, canWrite)).join('')}
          </div>
          ${canWrite ? `
          <button class="column__add" type="button" data-add="${escapeHtml(column.id)}">
            + Add card
          </button>` : ''}
        </section>`;
    })
    .join('');
}

function renderCard(record, canWrite = true) {
  const { id, data, etag } = record;
  return `
    <article class="card${canWrite ? '' : ' card--readonly'}" draggable="${canWrite}" data-card="${escapeHtml(id)}">
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
  const { reads, writes, deletes, lists, conflicts, avgLatencyMs } = store.db.stats;
  const { passes, cardsFetched, cardsSkipped, lastSyncMs } = store.syncStats;

  $('stat-reads').textContent = reads;
  $('stat-writes').textContent = writes;
  $('stat-deletes').textContent = deletes;
  $('stat-lists').textContent = lists;
  $('stat-conflicts').textContent = conflicts;
  const latencyEl = $('stat-avg-latency');
  if (latencyEl) {
    latencyEl.textContent = avgLatencyMs ? `${avgLatencyMs} ms` : '—';
  }
  $('stat-passes').textContent = passes;
  $('stat-fetched').textContent = cardsFetched;
  $('stat-skipped').textContent = cardsSkipped;
  $('stat-duration').textContent = lastSyncMs ? `${lastSyncMs} ms` : '—';

  if (els.syncPill.classList.contains('pill--ok')) {
    updateLatencyPill();
  }
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
  if (!store?.canWrite()) {
    showBanner('You have read-only access to this board.', 'warn');
    return;
  }
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
  if (!store?.canWrite()) return;
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
  const canWrite = store.canWrite();

  els.cardTitle.value = record.data.title ?? '';
  els.cardTitle.readOnly = !canWrite;
  els.cardNotes.value = record.data.notes ?? '';
  els.cardNotes.readOnly = !canWrite;
  els.cardMeta.textContent =
    `${store.cardKey(id)} · ETag ${record.etag?.slice(0, 12) ?? '?'} · ` +
    `last touched by ${record.data.updatedBy ?? 'unknown'} ${relativeTime(record.data.updatedAt)}`;

  els.cardDelete.hidden = !canWrite;
  const saveBtn = els.cardForm.querySelector('button[type="submit"]');
  if (saveBtn) saveBtn.hidden = !canWrite;
  els.cardCancel.textContent = canWrite ? 'Cancel' : 'Close';

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
  if (!store?.canWrite()) {
    event.preventDefault();
    return;
  }
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

function showLoader(title, step) {
  els.signinBlock.hidden = true;
  els.signinLoaderTitle.textContent = title;
  els.signinLoaderStep.textContent = step;
  els.signinLoader.hidden = false;
  els.connectError.hidden = true;
}

function updateLoaderStep(step) {
  els.signinLoaderStep.textContent = step;
}

function hideLoader() {
  els.signinLoader.hidden = true;
  els.signinBlock.hidden = false;
}

els.toggleStats?.addEventListener('click', () => {
  els.statsPanel.hidden = !els.statsPanel.hidden;
  els.boardView.classList.toggle('board--stats-open', !els.statsPanel.hidden);
  els.boardView.classList.toggle('board--inspecting', !els.statsPanel.hidden);
  if (!els.statsPanel.hidden) {
    renderStats();
    renderActivity();
  }
});

els.disconnect.addEventListener('click', async () => {
  await store?.leave();
  store = null;
  pkceSignOut();
  hideLoader();
  resetSigninButtons();
  els.boardView.hidden = true;
  els.connect.hidden = false;
});

async function connect(settings, role = 'own') {
  if (!els.signinLoader.hidden) {
    els.signinLoaderTitle.textContent = 'Opening board';
    updateLoaderStep('Connecting to JayDB…');
  }

  // Authorized by the signed-in user's OIDC token: the server knows the user
  // and enforces read/write per key by the token's scopes.
  const db = new JayDB({
    baseUrl: settings.baseUrl,
    namespace: settings.namespace,
    getToken: pkceCurrentToken,
  });

  store = new BoardStore(db, settings.boardId, {
    clientId: clientId(),
    name: settings.name,
  }, role);

  store.addEventListener('meta', renderBoard);
  store.addEventListener('cards', () => {
    renderBoard();
    renderStats();
  });
  store.addEventListener('presence', renderPresence);
  store.addEventListener('activity', renderActivity);
  store.addEventListener('synced', () => {
    updateLatencyPill();
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
  saveBoardMembership(settings.boardId, store.role);
  await store.heartbeat();

  if (!els.signinLoader.hidden) {
    updateLoaderStep('Loading board & syncing cards…');
  }

  await store.sync();
  await store.loadActivity();

  renderBoard();
  renderPresence();
  renderActivity();
  renderStats();
  updateLatencyPill();

  store.startPolling();
  saveSettings({ boardId: settings.boardId, role: store.role });

  hideLoader();
  els.connect.hidden = true;
  els.boardView.hidden = false;
}

// --- Invite Dialog (Tree ACL) ---------------------------------------------

if (els.openInvite) {
  els.openInvite.addEventListener('click', () => {
    if (!store?.canAdmin()) return;
    if (els.inviteResult) els.inviteResult.hidden = true;
    if (els.inviteCopyFeedback) els.inviteCopyFeedback.hidden = true;
    if (els.inviteLinkInput) els.inviteLinkInput.value = '';
    els.inviteDialog?.showModal();
  });
}

if (els.inviteCancel) {
  els.inviteCancel.addEventListener('click', () => {
    els.inviteDialog?.close();
  });
}

if (els.inviteGenerateBtn) {
  els.inviteGenerateBtn.addEventListener('click', async () => {
    const roleEl = document.querySelector('input[name="invite-role"]:checked');
    const selectedRole = roleEl?.value || 'read';

    try {
      const token = await signBoardInvite({
        boardId: store.boardId,
        role: selectedRole,
        inviterName: store.identity.name,
      });

      const url = new URL(window.location.href);
      url.searchParams.set('board', store.boardId);
      url.searchParams.set('invite', token);

      if (els.inviteLinkInput) els.inviteLinkInput.value = url.toString();
      if (els.inviteResult) els.inviteResult.hidden = false;
      if (els.inviteCopyFeedback) els.inviteCopyFeedback.hidden = true;
    } catch (err) {
      console.error(err);
      alert('Failed to generate invite token: ' + (err?.message || err));
    }
  });
}

if (els.inviteCopyBtn) {
  els.inviteCopyBtn.addEventListener('click', async () => {
    if (!els.inviteLinkInput?.value) return;
    try {
      await navigator.clipboard.writeText(els.inviteLinkInput.value);
      if (els.inviteCopyFeedback) els.inviteCopyFeedback.hidden = false;
      setTimeout(() => {
        if (els.inviteCopyFeedback) els.inviteCopyFeedback.hidden = true;
      }, 3000);
    } catch {
      els.inviteLinkInput.select();
      document.execCommand('copy');
      if (els.inviteCopyFeedback) els.inviteCopyFeedback.hidden = false;
    }
  });
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
  if (store && !els.statsPanel.hidden) renderActivity();
}, 30_000);

// --- Sign-in (PKCE) -------------------------------------------------------

function connectContext() {
  // Values to restore after the authorize redirect returns.
  return {
    baseUrl: CONFIG.oidc.issuer,
    namespace: CONFIG.oidc.namespace,
    boardId: (els.board.value || '').trim() || 'demo',
  };
}

function setButtonLoading(idp) {
  const isGoogle = idp === 'google';
  const googleBtn = els.googleSignin.querySelector('button');
  const githubBtn = els.githubSignin;

  if (googleBtn) googleBtn.disabled = true;
  if (githubBtn) githubBtn.disabled = true;

  if (isGoogle && googleBtn) {
    googleBtn.classList.add('is-loading', 'button--spinner');
    googleBtn.innerHTML = '<span class="spinner-icon" aria-hidden="true"></span> Redirecting to Google…';
  } else if (!isGoogle && githubBtn) {
    githubBtn.classList.add('is-loading', 'button--spinner');
    githubBtn.innerHTML = '<span class="spinner-icon" aria-hidden="true"></span> Redirecting to GitHub…';
  }
}

function resetSigninButtons() {
  initSignin();
  els.githubSignin.disabled = false;
  els.githubSignin.classList.remove('is-loading', 'button--spinner');
  els.githubSignin.textContent = 'Sign in with GitHub';
}

async function startPkce(idp) {
  setButtonLoading(idp);
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
    resetSigninButtons();
    els.connectError.textContent = error?.message ?? String(error);
    els.connectError.hidden = false;
  }
}

function initSignin() {
  if (!CONFIG.oidc?.issuer || !CONFIG.oidc?.clientId) {
    // Misconfiguration, not a user path: there is no API-key fallback anymore.
    els.connectError.textContent =
      'Sign-in is not configured (set oidc.issuer and oidc.clientId in config.js).';
    els.connectError.hidden = false;
    els.googleSignin.innerHTML = '';
    els.githubSignin.disabled = true;
    return;
  }

  els.googleSignin.innerHTML =
    '<button type="button" class="button button--primary">Sign in with Google</button>';
  els.googleSignin.querySelector('button').addEventListener('click', () => startPkce('google'));

  els.githubSignin.onclick = () => startPkce('github');
}

// --- Boot -----------------------------------------------------------------

(async function boot() {
  const saved = loadSettings();
  if (saved?.boardId) els.board.value = saved.boardId;

  const url = new URL(window.location.href);
  const isCallback = url.searchParams.has('code') || url.searchParams.has('error');
  const hasSession = pkceSignedIn();

  const inviteParam = url.searchParams.get('invite');
  const boardParam = url.searchParams.get('board');

  let activeBoard = boardParam || (els.board.value || '').trim() || saved?.boardId || 'demo';
  let activeRole = 'own';

  if (inviteParam) {
    const verified = await verifyBoardInvite(inviteParam);
    if (verified) {
      activeBoard = verified.boardId;
      activeRole = verified.role;
      els.board.value = verified.boardId;
      saveBoardMembership(verified.boardId, verified.role, verified.inviter);
      url.searchParams.delete('invite');
      window.history.replaceState({}, document.title, url.toString());
    } else {
      showBanner('Invalid or expired invite link.', 'warn');
    }
  } else {
    const existing = getBoardMembership(activeBoard);
    if (existing?.role) {
      activeRole = existing.role;
    }
  }

  els.connect.hidden = false;

  if (isCallback) {
    showLoader('Signing in', 'Completing sign-in…');
  } else if (hasSession) {
    showLoader('Connecting', 'Restoring session…');
  } else {
    initSignin();
  }

  // If we returned from a PKCE authorize redirect, finish the exchange and open
  // the board straight away using the token.
  if (CONFIG.oidc?.issuer && CONFIG.oidc?.clientId) {
    try {
      let ctx = null;
      if (isCallback) {
        ctx = await pkceCompleteCallback({ clientId: CONFIG.oidc.clientId });
      }

      if (ctx) {
        updateLoaderStep('Verifying authorization…');
        await pkceEnsureToken();
        const claims = pkceIdentityClaims();
        await connect({
          baseUrl: ctx.baseUrl || CONFIG.oidc.issuer,
          namespace: ctx.namespace || CONFIG.oidc.namespace,
          boardId: ctx.boardId || activeBoard,
          name: claims?.name || claims?.email || 'Player',
        }, activeRole);
      } else if (hasSession) {
        updateLoaderStep('Verifying authorization…');
        const token = await pkceEnsureToken();
        if (token) {
          const claims = pkceIdentityClaims();
          await connect({
            baseUrl: CONFIG.oidc.issuer,
            namespace: CONFIG.oidc.namespace,
            boardId: activeBoard,
            name: claims?.name || claims?.email || 'Player',
          }, activeRole);
        } else {
          hideLoader();
          initSignin();
        }
      }
    } catch (error) {
      console.error(error);
      hideLoader();
      initSignin();
      els.connectError.textContent = error?.message ?? String(error);
      els.connectError.hidden = false;
    }
  }
})();
