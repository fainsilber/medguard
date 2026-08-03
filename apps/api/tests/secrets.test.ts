import { describe, expect, it } from 'vitest';
import {
  bearerTokenFrom,
  generateDeviceToken,
  generateJoinCode,
  hashSecret,
  timingSafeEqual,
} from '../src/auth/secrets.js';

describe('generateJoinCode', () => {
  it('is always exactly six digits, including when the value is small', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateJoinCode()).toMatch(/^\d{6}$/);
    }
  });

  it('does not repeat itself — the entropy is real, not a stub', () => {
    const codes = new Set(Array.from({ length: 200 }, generateJoinCode));
    // 200 draws from a million possibilities: a couple of collisions would be unremarkable, but
    // anything near-constant means the generator is broken.
    expect(codes.size).toBeGreaterThan(190);
  });

  it('spreads across the range rather than clustering low, which modulo bias would cause', () => {
    const codes = Array.from({ length: 500 }, () => Number(generateJoinCode()));
    const high = codes.filter((code) => code >= 500_000).length;

    // Expect ~250 of 500 in the upper half. A generous band, because this must not be flaky —
    // but a biased generator would sit far outside it.
    expect(high).toBeGreaterThan(180);
    expect(high).toBeLessThan(320);
  });
});

describe('generateDeviceToken', () => {
  it('produces a long, url-safe, non-repeating token', () => {
    const tokens = Array.from({ length: 50 }, generateDeviceToken);

    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(token.length).toBeGreaterThanOrEqual(42);
    }
    expect(new Set(tokens).size).toBe(tokens.length);
  });
});

describe('hashSecret', () => {
  it('is deterministic, so a stored hash still matches on the next request', async () => {
    await expect(hashSecret('123456')).resolves.toBe(await hashSecret('123456'));
  });

  it('produces a 64-character hex digest', async () => {
    await expect(hashSecret('123456')).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives completely different digests for codes one digit apart', async () => {
    expect(await hashSecret('123456')).not.toBe(await hashSecret('123457'));
  });

  it('never returns the input — this is what makes a leaked backup useless', async () => {
    expect(await hashSecret('123456')).not.toContain('123456');
  });
});

describe('timingSafeEqual', () => {
  it('accepts identical strings', () => {
    expect(timingSafeEqual('abc123', 'abc123')).toBe(true);
  });

  it('rejects strings differing only in the last character', () => {
    expect(timingSafeEqual('abc123', 'abc124')).toBe(false);
  });

  it('rejects strings differing only in the first character', () => {
    expect(timingSafeEqual('abc123', 'zbc123')).toBe(false);
  });

  it('rejects strings of different lengths', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });

  it('accepts two empty strings', () => {
    expect(timingSafeEqual('', '')).toBe(true);
  });
});

describe('bearerTokenFrom', () => {
  it('extracts the token from a well-formed header', () => {
    expect(bearerTokenFrom('Bearer abc123')).toBe('abc123');
  });

  it('is case-insensitive about the scheme, as RFC 7235 requires', () => {
    expect(bearerTokenFrom('bearer abc123')).toBe('abc123');
  });

  it('tolerates surrounding and extra internal whitespace', () => {
    expect(bearerTokenFrom('  Bearer   abc123  ')).toBe('abc123');
  });

  it('returns undefined for a missing, empty, or non-bearer header', () => {
    expect(bearerTokenFrom(null)).toBeUndefined();
    expect(bearerTokenFrom(undefined)).toBeUndefined();
    expect(bearerTokenFrom('')).toBeUndefined();
    expect(bearerTokenFrom('Basic abc123')).toBeUndefined();
    expect(bearerTokenFrom('Bearer')).toBeUndefined();
    expect(bearerTokenFrom('Bearer   ')).toBeUndefined();
  });
});
