/**
 * Deployment config. Safe to commit and to serve publicly: a Google OAuth
 * client ID is a public identifier, not a secret (there is no client secret in
 * a browser Google Identity Services flow).
 *
 * To enable Google sign-in, create an OAuth 2.0 Client ID of type "Web
 * application" in the Google Cloud console, add this site's origin
 * (https://avivklas.github.io) to "Authorized JavaScript origins", and paste
 * the client ID below. Leave it empty to hide the Google button.
 */
export const CONFIG = {
  // PUBLIC identifier, safe to commit — this is not a secret. The Google client
  // SECRET is never used in the browser and must never appear in this repo.
  googleClientId: '1083061471320-r701f07o2kj79m9ej8h9jf8ristcesov.apps.googleusercontent.com',

  // JayDB tenant OIDC, for the PKCE sign-in that actually gates data access.
  // The issuer is the tenant's own host; the client is the public PKCE client
  // registered via scripts/setup-tenant.sh. Leave `issuer` empty to fall back to
  // the API-key / identity-only flow.
  oidc: {
    // e.g. "https://kanban.jaydb.com" — the tenant that hosts the demo.
    issuer: '',
    // The public client_id registered on that tenant (setup-tenant.sh uses
    // "kanban-demo").
    clientId: 'kanban-demo',
    // What a demo player's token requests. read+write on the demo's board keyspace.
    scopes: ['read:boards/*', 'write:boards/*'],
    // The namespace the board's documents live in on that tenant.
    namespace: 'kanban',
  },
};
