import { clearCaregiverName, getCaregiverName, setCaregiverName } from './caregiverName.js';

/**
 * RN port of `apps/web/src/identity/caregiverName.test.ts` — same rules (round-trip, trim, refuse
 * blank), `expo-secure-store` instead of `localStorage`. `.test.tsx` despite no JSX, per
 * `jest.config.js`'s convention: this file's only path to native code is transitive
 * (`expo-secure-store`), but that's still enough to require Jest's mock, not Vitest's.
 */

beforeEach(async () => {
  await clearCaregiverName();
});

afterEach(async () => {
  await clearCaregiverName();
});

describe('caregiver name', () => {
  it('is absent before it is ever set', async () => {
    expect(await getCaregiverName()).toBeNull();
  });

  it('round-trips a name', async () => {
    await setCaregiverName('Mom');
    expect(await getCaregiverName()).toBe('Mom');
  });

  it('trims surrounding whitespace', async () => {
    await setCaregiverName('  Dad  ');
    expect(await getCaregiverName()).toBe('Dad');
  });

  it('refuses a blank name', async () => {
    await expect(setCaregiverName('')).rejects.toThrow(RangeError);
    await expect(setCaregiverName('   ')).rejects.toThrow(RangeError);
  });

  it('leaves nothing stored after refusing a blank name', async () => {
    try {
      await setCaregiverName('   ');
    } catch {
      // expected
    }
    expect(await getCaregiverName()).toBeNull();
  });

  it('can be cleared', async () => {
    await setCaregiverName('Mom');
    await clearCaregiverName();
    expect(await getCaregiverName()).toBeNull();
  });
});
