import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearCaregiverName, getCaregiverName, setCaregiverName } from './caregiverName.js';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe('caregiver name', () => {
  it('is absent before it is ever set', () => {
    expect(getCaregiverName()).toBeNull();
  });

  it('round-trips a name', () => {
    setCaregiverName('Mom');
    expect(getCaregiverName()).toBe('Mom');
  });

  it('trims surrounding whitespace', () => {
    setCaregiverName('  Dad  ');
    expect(getCaregiverName()).toBe('Dad');
  });

  it('refuses a blank name', () => {
    expect(() => setCaregiverName('')).toThrow(RangeError);
    expect(() => setCaregiverName('   ')).toThrow(RangeError);
  });

  it('leaves nothing stored after refusing a blank name', () => {
    try {
      setCaregiverName('   ');
    } catch {
      // expected
    }
    expect(getCaregiverName()).toBeNull();
  });

  it('can be cleared', () => {
    setCaregiverName('Mom');
    clearCaregiverName();
    expect(getCaregiverName()).toBeNull();
  });
});
