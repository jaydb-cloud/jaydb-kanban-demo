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
  googleClientId: '',
};
