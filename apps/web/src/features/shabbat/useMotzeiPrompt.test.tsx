import 'fake-indexeddb/auto';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { fixedClock } from '@medguard/shared/testing';
import type { Medicine, Schedule, ShabbatConfig, ShabbatWindow } from '@medguard/shared';
import { setDismissedReconciliation } from '@medguard/store';
import type { Store } from '@medguard/store';
import { renderWithRepository } from '../../testUtils/renderWithRepository.js';
import { useMotzeiPrompt } from './useMotzeiPrompt.js';

/**
 * No dedicated test file existed on either platform — only proven end-to-end
 * (`apps/web/e2e/motzei-reconciliation.spec.ts`) and, since this sprint, by
 * `apps/android/src/features/shabbat/useMotzeiPrompt.test.tsx`'s new unit coverage. This is the
 * web-side mirror of that file: the phase gate (nothing shows without Shabbat automation turned
 * on), which window counts as "just ended," and that a dismissal is remembered per window, never
 * suppressing a different one.
 *
 * Not covered here: the `nextWindow(...)?.id !== endedWindow.id` "never mid-Shabbat, even if a
 * stale window somehow says otherwise" guard — a web-only addition `shabbatPhaseAt`'s own active-
 * window check should already make unreachable with well-formed data, and manufacturing the
 * malformed-data case it defends against would test a contrived fixture more than real behavior.
 */

const JERUSALEM = 'Asia/Jerusalem';
const NOW = '2026-08-16T06:00:00.000Z'; // Sunday morning, after a Shabbat that ran Fri–Sat
const WINDOW_START = '2026-08-14T16:03:00.000Z';
const WINDOW_END = '2026-08-15T17:01:00.000Z';

afterEach(() => {
  localStorage.clear();
});

function makeWindow(): ShabbatWindow {
  return {
    id: `shabbat:${WINDOW_START}`,
    patientId: 'patient-1',
    kind: 'shabbat',
    label: 'Shabbat',
    startsAt: WINDOW_START,
    endsAt: WINDOW_END,
    generatedAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    updatedByDeviceId: 'server',
    syncStatus: 'synced',
  };
}

function makeConfig(overrides: Partial<ShabbatConfig> = {}): ShabbatConfig {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    patientId: 'patient-1',
    autoShabbatEnabled: true,
    latitude: 31.7683,
    longitude: 35.2137,
    candleLightingOffsetMins: 18,
    havdalahDegreesOrMins: '8.5_degrees',
    israelHolidays: true,
    chimeDurationSeconds: 30,
    weekdayChimeDurationSeconds: 60,
    updatedAt: '2026-08-01T00:00:00.000Z',
    updatedByDeviceId: 'seed-device',
    syncStatus: 'synced',
    ...overrides,
  };
}

function makeMedicine(): Medicine {
  return {
    id: 'medicine-1',
    patientId: 'patient-1',
    name: 'Ondansetron',
    strength: '4mg',
    form: 'pill',
    asNeeded: false,
    archived: false,
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedByDeviceId: 'seed',
    syncStatus: 'synced',
  };
}

function makeSchedule(): Schedule {
  return {
    id: 'schedule-1',
    medicineId: 'medicine-1',
    patientId: 'patient-1',
    frequencyType: 'daily',
    timesOfDay: ['09:00'],
    dosageQuantity: 1,
    startDate: '2026-01-01',
    active: true,
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedByDeviceId: 'seed',
    syncStatus: 'synced',
  };
}

async function putWindow(store: Store) {
  await store.transaction(['shabbatWindows'], (tx) => tx.put('shabbatWindows', makeWindow()));
}

function Probe() {
  const { show, dismiss } = useMotzeiPrompt();
  return (
    <>
      <p>{show ? 'show: yes' : 'show: no'}</p>
      <button type="button" onClick={dismiss}>
        Dismiss
      </button>
    </>
  );
}

describe('useMotzeiPrompt', () => {
  it('never shows without Shabbat automation configured, however unreconciled the doses', async () => {
    await renderWithRepository(<Probe />, {
      clock: fixedClock(NOW),
      timeZone: JERUSALEM,
      seed: async (repository, store) => {
        await repository.saveMedicine(makeMedicine(), 'CREATE');
        await repository.saveSchedule(makeSchedule(), 'CREATE');
        await putWindow(store);
        // Deliberately no saveShabbatConfig call — automation was never turned on.
      },
    });

    expect(await screen.findByText('show: no')).toBeInTheDocument();
  });

  it('does not show once a window has ended with nothing left to reconcile', async () => {
    await renderWithRepository(<Probe />, {
      clock: fixedClock(NOW),
      timeZone: JERUSALEM,
      seed: async (repository, store) => {
        await repository.saveShabbatConfig(makeConfig(), 'CREATE');
        await putWindow(store);
        // No medicine/schedule at all — nothing could possibly be unreconciled.
      },
    });

    expect(await screen.findByText('show: no')).toBeInTheDocument();
  });

  it('shows once a window has ended with an unreconciled dose', async () => {
    await renderWithRepository(<Probe />, {
      clock: fixedClock(NOW),
      timeZone: JERUSALEM,
      seed: async (repository, store) => {
        await repository.saveShabbatConfig(makeConfig(), 'CREATE');
        await repository.saveMedicine(makeMedicine(), 'CREATE');
        await repository.saveSchedule(makeSchedule(), 'CREATE');
        await putWindow(store);
      },
    });

    expect(await screen.findByText('show: yes')).toBeInTheDocument();
  });

  it('dismissing hides the prompt and persists the dismissal for that window', async () => {
    const user = userEvent.setup();
    await renderWithRepository(<Probe />, {
      clock: fixedClock(NOW),
      timeZone: JERUSALEM,
      seed: async (repository, store) => {
        await repository.saveShabbatConfig(makeConfig(), 'CREATE');
        await repository.saveMedicine(makeMedicine(), 'CREATE');
        await repository.saveSchedule(makeSchedule(), 'CREATE');
        await putWindow(store);
      },
    });
    await screen.findByText('show: yes');

    await user.click(screen.getByText('Dismiss'));

    await waitFor(() => expect(screen.getByText('show: no')).toBeInTheDocument());
  });

  it('a dismissal recorded for a different window does not suppress this one', async () => {
    // The property the hook's own doc comment promises: the next Shabbat is a different
    // question, so nothing should have to remember to clear a stale dismissal. Pre-seeds a
    // dismissal for an id that is not this window's real id (`shabbat:${WINDOW_START}`),
    // standing in for last week's window.
    await renderWithRepository(<Probe />, {
      clock: fixedClock(NOW),
      timeZone: JERUSALEM,
      seed: async (repository, store) => {
        await repository.saveShabbatConfig(makeConfig(), 'CREATE');
        await repository.saveMedicine(makeMedicine(), 'CREATE');
        await repository.saveSchedule(makeSchedule(), 'CREATE');
        await putWindow(store);
        await setDismissedReconciliation(store, 'shabbat:last-week');
      },
    });

    expect(await screen.findByText('show: yes')).toBeInTheDocument();
  });
});
