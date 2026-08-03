import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getOrCreateDeviceId } from './deviceId.js';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe('getOrCreateDeviceId', () => {
  it('creates an id on first call', () => {
    const id = getOrCreateDeviceId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns the same id on every subsequent call', () => {
    const first = getOrCreateDeviceId();
    const second = getOrCreateDeviceId();
    expect(second).toBe(first);
  });

  it('persists across what stands in for an app restart — a fresh read from storage', () => {
    const id = getOrCreateDeviceId();
    expect(localStorage.getItem('medguard-device-id')).toBe(id);
  });
});
