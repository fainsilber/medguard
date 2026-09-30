/**
 * A link to the privacy policy, which is a static page (`public/privacy.html`), not a route of
 * this app.
 *
 * Same-origin and relative on purpose rather than `PRIVACY_POLICY_URL`: the service worker
 * precaches the file, so the policy stays readable offline, and it resolves under `vite dev`.
 * The page carries its own "back to MedGuard" link. `target="_blank"` keeps an installed
 * (standalone) PWA from navigating away from the app with no browser chrome to get back.
 */
export const PRIVACY_POLICY_PATH = '/privacy.html';

export function PrivacyPolicyLink({
  className = 'text-sm text-slate-400 underline',
}: {
  className?: string;
}) {
  return (
    <a href={PRIVACY_POLICY_PATH} target="_blank" rel="noopener noreferrer" className={className}>
      Privacy policy
    </a>
  );
}
