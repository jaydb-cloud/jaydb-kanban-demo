/**
 * treeacl.js — Browser-side Tree ACL stateless invite token generator and verifier.
 *
 * Implements the same cryptographic token format as pkg/treeacl in JayDB Cloud:
 * an HMAC-SHA256 signed payload carrying tree path ownership/delegation claims:
 *   - tree_path: "boards/{boardId}/**"
 *   - role: "read" | "write"
 *   - inviter_id / inviter_name
 *   - exp: timestamp
 *
 * Generated and verified 100% in-browser with zero server calls.
 */

const INVITE_SECRET = 'jaydb-kanban-tree-acl-signing-key-2026';

function b64url(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromB64url(str) {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

async function getHmacKey() {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    'raw',
    enc.encode(INVITE_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/**
 * Sign a stateless invite token for a board path.
 *
 * @param {object} opts
 * @param {string} opts.boardId
 * @param {'read' | 'write'} opts.role
 * @param {string} [opts.inviterName]
 * @param {number} [opts.expiresInMs]  Defaults to 7 days
 * @returns {Promise<string>} URL-safe token
 */
export async function signBoardInvite({ boardId, role, inviterName, expiresInMs = 7 * 24 * 60 * 60 * 1000 }) {
  if (role !== 'read' && role !== 'write') {
    throw new Error(`invalid role: ${role}`);
  }
  if (!boardId || typeof boardId !== 'string') {
    throw new Error('boardId is required');
  }

  const nonce = b64url(crypto.getRandomValues(new Uint8Array(12)));
  const payload = {
    type: 'tree_invite',
    tree_path: `boards/${boardId}/**`,
    board_id: boardId,
    role,
    inviter: inviterName || 'Admin',
    exp: Date.now() + expiresInMs,
    nonce,
  };

  const enc = new TextEncoder();
  const payloadB64 = b64url(enc.encode(JSON.stringify(payload)));

  const key = await getHmacKey();
  const sigBuffer = await crypto.subtle.sign('HMAC', key, enc.encode(payloadB64));
  const sigB64 = b64url(sigBuffer);

  return `${payloadB64}.${sigB64}`;
}

/**
 * Verify a stateless invite token.
 *
 * @param {string} rawToken
 * @returns {Promise<{boardId: string, role: 'read' | 'write', inviter: string} | null>}
 */
export async function verifyBoardInvite(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') return null;

  const parts = rawToken.trim().split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

  const [payloadB64, sigB64] = parts;

  try {
    const key = await getHmacKey();
    const enc = new TextEncoder();
    const sigBytes = fromB64url(sigB64);

    const valid = await crypto.subtle.verify(
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
      console.warn('treeacl: invite token has expired');
      return null;
    }
    if (!payload.board_id || !payload.role) return null;

    return {
      boardId: payload.board_id,
      role: payload.role,
      inviter: payload.inviter || 'Admin',
      treePath: payload.tree_path,
    };
  } catch (err) {
    console.error('treeacl: failed to verify invite token', err);
    return null;
  }
}
