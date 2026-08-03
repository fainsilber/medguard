import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { hasPendingChanges, mergeCollections, mergeLww } from './sync.js';
import type { Medicine } from './types.js';

function medicine(overrides: Partial<Medicine> = {}): Medicine {
  return {
    id: 'medicine-1',
    patientId: 'patient-1',
    name: 'Ondansetron',
    strength: '4mg',
    form: 'pill',
    asNeeded: false,
    archived: false,
    updatedAt: '2026-06-15T12:00:00.000Z',
    updatedByDeviceId: 'device-a',
    syncStatus: 'synced',
    ...overrides,
  };
}

describe('mergeLww', () => {
  it('takes the later write', () => {
    const local = medicine({ updatedAt: '2026-06-15T12:00:01.000Z', name: 'Newer' });
    const remote = medicine({ updatedAt: '2026-06-15T12:00:00.000Z', name: 'Older' });

    expect(mergeLww(local, remote)).toEqual({ winner: local, source: 'local' });
  });

  it('takes the remote when it is later', () => {
    const local = medicine({ updatedAt: '2026-06-15T12:00:00.000Z' });
    const remote = medicine({ updatedAt: '2026-06-15T12:00:01.000Z' });

    expect(mergeLww(local, remote).source).toBe('remote');
  });

  it('resolves down to the millisecond', () => {
    const local = medicine({ updatedAt: '2026-06-15T12:00:00.002Z' });
    const remote = medicine({ updatedAt: '2026-06-15T12:00:00.001Z' });

    expect(mergeLww(local, remote).source).toBe('local');
  });

  it('breaks an exact tie by device id, not by arrival order', () => {
    // Two phones can genuinely write in the same millisecond. Resolving by arrival order would
    // give different answers on different devices and leave the household disagreeing forever.
    const local = medicine({ updatedByDeviceId: 'device-b' });
    const remote = medicine({ updatedByDeviceId: 'device-a' });

    expect(mergeLww(local, remote).winner.updatedByDeviceId).toBe('device-b');
  });

  it('gives the same answer whichever side the caller calls local', () => {
    const a = medicine({ updatedByDeviceId: 'device-a', name: 'From A' });
    const b = medicine({ updatedByDeviceId: 'device-b', name: 'From B' });

    expect(mergeLww(a, b).winner.name).toBe(mergeLww(b, a).winner.name);
  });

  it('reports identical when the same device wrote both at the same instant', () => {
    const outcome = mergeLww(medicine(), medicine());
    expect(outcome.source).toBe('identical');
  });

  it('refuses to merge two different records', () => {
    expect(() => mergeLww(medicine({ id: 'a' }), medicine({ id: 'b' }))).toThrow(/different records/);
  });

  it('is deterministic for any pair of versions', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 0, max: 5 }),
        fc.constantFrom('device-a', 'device-b', 'device-c'),
        fc.constantFrom('device-a', 'device-b', 'device-c'),
        (localSecond, remoteSecond, localDevice, remoteDevice) => {
          const local = medicine({
            updatedAt: `2026-06-15T12:00:0${localSecond}.000Z`,
            updatedByDeviceId: localDevice,
          });
          const remote = medicine({
            updatedAt: `2026-06-15T12:00:0${remoteSecond}.000Z`,
            updatedByDeviceId: remoteDevice,
          });

          // Whichever way round the two sides are presented, the same version must win.
          const forward = mergeLww(local, remote).winner;
          const backward = mergeLww(remote, local).winner;
          return (
            forward.updatedAt === backward.updatedAt &&
            forward.updatedByDeviceId === backward.updatedByDeviceId
          );
        },
      ),
    );
  });
});

describe('mergeCollections', () => {
  it('keeps records that exist only locally', () => {
    const local = [medicine({ id: 'local-only' })];
    expect(mergeCollections(local, []).map((m) => m.id)).toEqual(['local-only']);
  });

  it('adds records that exist only remotely', () => {
    const remote = [medicine({ id: 'remote-only' })];
    expect(mergeCollections([], remote).map((m) => m.id)).toEqual(['remote-only']);
  });

  it('resolves records present on both sides', () => {
    const local = [medicine({ id: 'shared', name: 'Local', updatedAt: '2026-06-15T12:00:00.000Z' })];
    const remote = [
      medicine({ id: 'shared', name: 'Remote', updatedAt: '2026-06-15T13:00:00.000Z' }),
    ];

    expect(mergeCollections(local, remote)[0]?.name).toBe('Remote');
  });

  it('does not duplicate a record present on both sides', () => {
    const local = [medicine({ id: 'shared' })];
    const remote = [medicine({ id: 'shared' })];
    expect(mergeCollections(local, remote)).toHaveLength(1);
  });

  it('orders local records first, then remote-only ones', () => {
    const local = [medicine({ id: 'l1' }), medicine({ id: 'shared' })];
    const remote = [medicine({ id: 'shared' }), medicine({ id: 'r1' })];

    expect(mergeCollections(local, remote).map((m) => m.id)).toEqual(['l1', 'shared', 'r1']);
  });

  it('handles both sides being empty', () => {
    expect(mergeCollections([], [])).toEqual([]);
  });
});

describe('hasPendingChanges', () => {
  it('is true for an unsynced record', () => {
    expect(hasPendingChanges(medicine({ syncStatus: 'pending' }))).toBe(true);
  });

  it('is false for a synced record', () => {
    expect(hasPendingChanges(medicine({ syncStatus: 'synced' }))).toBe(false);
  });
});
