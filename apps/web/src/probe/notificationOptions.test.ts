import { describe, expect, it } from 'vitest';
import type { ProbePushPayload } from '@medguard/shared';
import { buildNotificationOptions, retainedOptions } from './notificationOptions.js';
import type { ExtendedNotification } from './notificationOptions.js';

function makePayload(overrides: Partial<ProbePushPayload> = {}): ProbePushPayload {
  return {
    kind: 'probe',
    title: 'Test',
    body: 'Body',
    sentAtIso: '2026-08-02T09:00:00.000Z',
    burstIndex: 1,
    burstTotal: 1,
    ...overrides,
  };
}

describe('buildNotificationOptions', () => {
  it('omits unset fields rather than including them as undefined', () => {
    const options = buildNotificationOptions(makePayload());

    expect(options).toEqual({
      body: 'Body',
      data: { burstIndex: 1, burstTotal: 1 },
    });
    expect('tag' in options).toBe(false);
    expect('sound' in options).toBe(false);
  });

  it('includes every field the payload sets, including the non-standard sound field', () => {
    const options = buildNotificationOptions(
      makePayload({
        tag: 'medguard-probe',
        renotify: true,
        requireInteraction: true,
        silent: false,
        vibrate: [200, 100, 200],
        sound: 'alert.mp3',
      }),
    );

    expect(options).toMatchObject({
      tag: 'medguard-probe',
      renotify: true,
      requireInteraction: true,
      silent: false,
      vibrate: [200, 100, 200],
      sound: 'alert.mp3',
    });
  });
});

describe('retainedOptions', () => {
  it('returns nothing when no notification was found', () => {
    expect(retainedOptions(makePayload(), undefined)).toEqual([]);
  });

  it('reports every option the browser actually kept', () => {
    const payload = makePayload({
      tag: 'medguard-probe',
      renotify: true,
      requireInteraction: true,
      silent: false,
      vibrate: [200, 100, 200],
    });
    const rendered = {
      tag: 'medguard-probe',
      renotify: true,
      requireInteraction: true,
      silent: false,
      vibrate: [200, 100, 200],
    } as unknown as ExtendedNotification;

    expect(retainedOptions(payload, rendered)).toEqual([
      'tag',
      'renotify',
      'requireInteraction',
      'silent',
      'vibrate',
    ]);
  });

  it('does not report sound as retained when the payload never requested it', () => {
    // Guards against a false positive: `rendered.sound === payload.sound` would otherwise be
    // `undefined === undefined` -> true, which would misreport a browser as supporting sound.
    const payload = makePayload();
    const rendered = { sound: undefined } as unknown as ExtendedNotification;

    expect(retainedOptions(payload, rendered)).not.toContain('sound');
  });

  it('reports sound as NOT retained when requested but the browser drops it', () => {
    // This is the actual, expected real-world result: the Notification API's `sound` field was
    // never implemented by any browser, settled here with evidence rather than a guess.
    const payload = makePayload({ sound: 'alert.mp3' });
    const rendered = { sound: undefined } as unknown as ExtendedNotification;

    expect(retainedOptions(payload, rendered)).not.toContain('sound');
  });

  it('reports sound as retained only if a browser genuinely echoes it back', () => {
    const payload = makePayload({ sound: 'alert.mp3' });
    const rendered = { sound: 'alert.mp3' } as unknown as ExtendedNotification;

    expect(retainedOptions(payload, rendered)).toContain('sound');
  });

  it('treats an unrequested field kept at its default as retained', () => {
    // renotify defaults to false; a payload that never sets it should still match a browser
    // that reports false, rather than being scored as "not retained".
    const payload = makePayload();
    const rendered = { renotify: false, requireInteraction: false, silent: null } as unknown as ExtendedNotification;

    const result = retainedOptions(payload, rendered);
    expect(result).toContain('renotify');
    expect(result).toContain('requireInteraction');
    expect(result).toContain('silent');
  });
});
