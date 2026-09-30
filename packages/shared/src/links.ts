/**
 * The public address of the privacy policy.
 *
 * Google Play wants the same URL on the store listing and inside the app, and it has to be a
 * plain, login-free web page rather than a file. It is served as a static asset from
 * `apps/web/public/privacy.html` by the web app's Worker, so it needs no backend and stays up
 * even if the API is down. Cloudflare serves that file at the extension-less path.
 *
 * The Android app opens this absolute URL. The web app links to its own copy by relative path
 * (`/privacy.html`) instead, so the policy stays readable offline and in `vite dev`, where
 * extension-less paths fall through to the SPA.
 */
export const PRIVACY_POLICY_URL = 'https://medguard-web.fainsilber.workers.dev/privacy';
