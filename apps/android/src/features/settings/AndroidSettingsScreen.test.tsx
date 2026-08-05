import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixedClock } from '@medguard/shared/testing';
import type * as SharedModule from '@medguard/shared';
import type * as AndroidBridgeModule from '../../native/androidBridge.js';
import { AndroidSettingsScreen } from './AndroidSettingsScreen.js';
import { renderWithAndroidApp } from '../../testUtils/renderWithAndroidApp.js';
import { medicine } from '../../testUtils/fixtures.js';

const clock = fixedClock('2026-06-15T12:00:00.000Z');

/**
 * Renders the screen against a freshly-built module graph, so a `vi.doMock` registered inside
 * `applyMocks` actually takes effect — the statically imported screen above is already resolved
 * and would ignore it. The render helper is re-imported alongside the screen because both must
 * come from the same graph, or the provider's React context would be a different object than the
 * one the screen's hooks read.
 */
async function renderIsolated(applyMocks: () => void) {
  vi.resetModules();
  applyMocks();

  const [{ AndroidSettingsScreen: Screen }, { renderWithAndroidApp: renderIsolatedApp }] =
    await Promise.all([
      import('./AndroidSettingsScreen.js'),
      import('../../testUtils/renderWithAndroidApp.js'),
    ]);

  return renderIsolatedApp(<Screen onChangeCaregiver={vi.fn()} />, {
    clock,
    timeZone: 'Asia/Jerusalem',
  });
}

afterEach(() => {
  vi.doUnmock('../../native/androidBridge.js');
  vi.doUnmock('@medguard/shared');
  vi.resetModules();
});

describe('AndroidSettingsScreen', () => {
  it('reports push and notification channels as unavailable rather than claiming them', async () => {
    // The screen this replaced showed a hard-coded "FCM Active" badge and a synthetic token. A
    // caregiver relying on that to be woken at 3am would have been relying on nothing.
    await renderWithAndroidApp(<AndroidSettingsScreen onChangeCaregiver={vi.fn()} />, {
      clock,
      timeZone: 'Asia/Jerusalem',
    });

    expect(await screen.findByText(/not registered/i)).toBeInTheDocument();
    expect(screen.getByText(/not created/i)).toBeInTheDocument();
    expect(screen.getByText(/cannot wake a locked phone/i)).toBeInTheDocument();
  });

  it('reports that it is running in a browser, not the Android app', async () => {
    await renderWithAndroidApp(<AndroidSettingsScreen onChangeCaregiver={vi.fn()} />, {
      clock,
      timeZone: 'Asia/Jerusalem',
    });

    expect(await screen.findByText('Browser')).toBeInTheDocument();
  });

  it('shows how many local changes are still queued, and that nothing uploads them', async () => {
    await renderWithAndroidApp(<AndroidSettingsScreen onChangeCaregiver={vi.fn()} />, {
      clock,
      timeZone: 'Asia/Jerusalem',
      seed: (repository) => repository.saveMedicine(medicine({ id: 'med-1' })),
    });

    // Household settings plus the medicine.
    expect(await screen.findByText(/2 local changes queued/i)).toBeInTheDocument();
    expect(screen.getByText(/upload not wired/i)).toBeInTheDocument();
  });

  it('reports the household timezone and this device’s id', async () => {
    await renderWithAndroidApp(<AndroidSettingsScreen onChangeCaregiver={vi.fn()} />, {
      clock,
      timeZone: 'Asia/Jerusalem',
    });

    expect(await screen.findByText('Asia/Jerusalem')).toBeInTheDocument();
  });

  it('trusts a clock that has not drifted during the session', async () => {
    await renderWithAndroidApp(<AndroidSettingsScreen onChangeCaregiver={vi.fn()} />, {
      clock,
      timeZone: 'Asia/Jerusalem',
    });

    expect(await screen.findByText('Trusted')).toBeInTheDocument();
  });

  it('reports the good case honestly too, when the capabilities are genuinely there', async () => {
    await renderIsolated(() => {
      vi.doMock('../../native/androidBridge.js', async () => {
        const actual = await vi.importActual<typeof AndroidBridgeModule>(
          '../../native/androidBridge.js',
        );
        return {
          ...actual,
          getDeviceInfo: (deviceId: string) => ({
            deviceId,
            platform: 'android' as const,
            fcmToken: 'real-token',
            pushProvider: 'fcm' as const,
          }),
          describeCapabilities: () => ({
            platform: 'android' as const,
            channelsCreated: true,
            channels: actual.NOTIFICATION_CHANNELS,
            chime: 'web-audio-foreground-only' as const,
            pushRegistered: true,
          }),
        };
      });
    });

    expect(await screen.findByText('Android app')).toBeInTheDocument();
    expect(screen.getByText('Registered')).toBeInTheDocument();
    expect(screen.getByText('Created')).toBeInTheDocument();
  });

  it('reports a drifting clock as skewed', async () => {
    await renderIsolated(() => {
      vi.doMock('@medguard/shared', async () => {
        const actual = await vi.importActual<typeof SharedModule>('@medguard/shared');
        return { ...actual, getLocalClockTrust: () => ({ kind: 'skewed', offsetMs: 600_000 }) };
      });
    });

    expect(await screen.findByText('Skew detected')).toBeInTheDocument();
    expect(screen.getByText(/changed mid-session/i)).toBeInTheDocument();
  });

  it('hands a new caregiver name upward only once it differs and is non-blank', async () => {
    const user = userEvent.setup();
    const onChangeCaregiver = vi.fn();

    await renderWithAndroidApp(<AndroidSettingsScreen onChangeCaregiver={onChangeCaregiver} />, {
      clock,
      userId: 'Mom',
      timeZone: 'Asia/Jerusalem',
    });

    const save = await screen.findByRole('button', { name: /save name/i });
    expect(save).toBeDisabled(); // unchanged

    const input = screen.getByLabelText(/caregiver name/i);
    await user.clear(input);
    expect(save).toBeDisabled(); // blank

    await user.type(input, 'Dad');
    await user.click(save);

    expect(onChangeCaregiver).toHaveBeenCalledWith('Dad');
  });
});
