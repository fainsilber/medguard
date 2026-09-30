import { describe, expect, it } from 'vitest';
import { PRIVACY_POLICY_URL } from '@medguard/shared';
import html from '../public/privacy.html?raw';

/**
 * Pins the parts of the published privacy policy most likely to drift or be broken by an edit.
 * It cannot check the prose is *true*; `docs/data-handling.md` is where that gets reviewed. What
 * it can do is keep the page in the shape Google Play's review requires and stop it quietly
 * losing the disclosures that correspond to real integrations.
 */

describe('public/privacy.html', () => {
  it('is a standalone page: no scripts, no external stylesheets, fonts, images or frames', () => {
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link[^>]+rel=["']?stylesheet/i);
    expect(html).not.toMatch(/<(img|iframe|video|audio|source|embed|object)\b/i);
    expect(html).not.toMatch(/@import|url\(/i);
  });

  it('has a title and a language, so it reads as a proper web page', () => {
    expect(html).toMatch(/<html lang="en">/);
    expect(html).toMatch(/<title>MedGuard Privacy Policy<\/title>/);
  });

  it('names every outside party that handles data, matching the integrations in the code', () => {
    // apps/api hosts on Cloudflare (Workers, D1, Durable Objects); apps/api/src/push/fcm.ts sends
    // through Firebase Cloud Messaging; apps/api/src/push/send.ts uses browser Web Push services.
    expect(html).toContain('Cloudflare');
    expect(html).toContain('Firebase Cloud Messaging');
    expect(html).toMatch(/Web push|browser maker&rsquo;s push service/i);
  });

  it('gives a way to delete data and a contact address', () => {
    expect(html).toContain('id="delete"');
    expect(html).toContain('Delete this household');
    expect(html).toMatch(/href="mailto:[^"]+@[^"]+"/);
  });

  it('links only to sites that exist for a reason: the app itself and the named providers', () => {
    const hosts = new Set(
      [...html.matchAll(/href="(https?:\/\/[^"]+)"/g)].map((match) => new URL(match[1]!).host),
    );
    expect([...hosts].sort()).toEqual([
      'medguard-web.fainsilber.workers.dev',
      'policies.google.com',
      'www.cloudflare.com',
    ]);
  });
});

describe('PRIVACY_POLICY_URL', () => {
  it('is an https address on the same host the web app is served from', () => {
    const url = new URL(PRIVACY_POLICY_URL);
    expect(url.protocol).toBe('https:');
    expect(url.host).toBe('medguard-web.fainsilber.workers.dev');
    expect(url.pathname).toBe('/privacy');
  });
});
