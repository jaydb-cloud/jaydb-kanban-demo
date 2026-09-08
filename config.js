/**
 * Deployment config. Safe to commit and to serve publicly: a Google OAuth
 * client ID is a public identifier, not a secret (there is no client secret in
 * a browser Google Identity Services flow).
 *
 * To enable Google sign-in, create an OAuth 2.0 Client ID of type "Web
 * application" in the Google Cloud console, add this site's origin
 * (https://jaydb-cloud.github.io) to "Authorized JavaScript origins", and paste
 * the client ID below. Leave it empty to hide the Google button.
 */
export const CONFIG = {
  // JayDB tenant OIDC — the sign-in that gates data access. The issuer is the
  oidc: {
    // e.g. "https://kanban.jaydb.com" — the tenant that hosts the demo.
    issuer: 'https://kanban.jaydb.com',
    // The public client_id registered on that tenant (setup-tenant.sh uses
    // "kanban-demo").
    clientId: 'kanban-demo',
    // What a demo player's token requests. read+write on the demo's board keyspace.
    scopes: ['read:boards/*', 'write:boards/*'],
    // The namespace the board's documents live in on that tenant.
    namespace: 'kanban',
  },
};
