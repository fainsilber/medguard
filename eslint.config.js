import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Cross-cutting rule 1 & 2 from the sprint plan: no ambient time, no ambient identity.
 *
 * Domain code must take a `Clock` and an `IdGenerator` rather than reaching for globals.
 * This is what makes cooldowns, escalation windows, DST boundaries and Shabbat transitions
 * deterministically testable — and it is enforced here rather than left to review.
 */
const noAmbientTimeOrIdentity = [
  {
    // Only the zero-argument form reads ambient time. `new Date(ms)` and `new Date(iso)` are
    // pure conversions and stay allowed.
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message:
      'No ambient time: inject a Clock and call clock.nowIso() instead of `new Date()`. See docs/medguard-sprint-plan.md (Cross-cutting rules).',
  },
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message:
      'No ambient time: inject a Clock and call clock.nowMs() instead of `Date.now()`. See docs/medguard-sprint-plan.md (Cross-cutting rules).',
  },
  {
    selector: "CallExpression[callee.object.name='crypto'][callee.property.name='randomUUID']",
    message:
      'No ambient identity: inject an IdGenerator instead of calling `crypto.randomUUID()` directly.',
  },
  {
    selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
    message: 'No ambient randomness in domain code: inject a source of randomness so tests stay deterministic.',
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/.wrangler/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/node_modules/**',
      '**/worker-configuration.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // The domain layer and anything that computes safety state: no ambient time or identity.
  {
    files: [
      'packages/shared/src/**/*.ts',
      'apps/web/src/db/**/*.ts',
      'apps/web/src/features/**/*.{ts,tsx}',
      'apps/web/src/sync/**/*.ts',
      'apps/api/src/**/*.ts',
      'apps/android/src/**/*.{ts,tsx}',
    ],
    rules: {
      'no-restricted-syntax': ['error', ...noAmbientTimeOrIdentity],
    },
  },

  // The clock-tampering guard's whole job is comparing the real wall clock against a monotonic
  // one — the exact ambient `Date.now()` the rule above forbids elsewhere is what this file
  // exists to read. Web's equivalent (apps/web/src/clock/localClockGuard.ts) is exempt the same
  // way, simply by not being listed in that block's `files`.
  {
    files: ['apps/android/src/clock/**/*.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },

  // Metro, Babel and Jest require CommonJS config files, loaded by Node directly rather than
  // bundled — the one place in this app that isn't ESM.
  {
    files: ['apps/android/metro.config.js', 'apps/android/babel.config.js', 'apps/android/jest.config.js'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
    languageOptions: {
      globals: {
        module: 'writable',
        require: 'readonly',
        __dirname: 'readonly',
      },
    },
  },

  // Two Jest test files need `jest.resetModules()` to give module-scoped state (a cached
  // `anchor`/`trust` pair, a `PendingActionApplier`'s in-flight guard) a clean slate per test —
  // there is no other way to get a fresh instance of code that deliberately keeps state at module
  // scope. `require()` inside a helper, not a dynamic `import()`, because this Jest project runs
  // under CommonJS and `import()` throws ("invoked without --experimental-vm-modules") without a
  // much bigger config change; `require()`'s return value is then cast with `as typeof import(...)`
  // for the real type, since `require()` itself only returns `any`.
  {
    files: [
      'apps/android/src/clock/localClockGuard.test.tsx',
      'apps/android/src/alarms/headlessTask.test.tsx',
    ],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },

  // Build-time Node scripts.
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        console: 'readonly',
        crypto: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
      },
    },
  },

  // Tests, fixtures and the composition root are exempt: they are where real clocks and
  // real ids get constructed and handed to the domain.
  {
    files: [
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/tests/**',
      '**/e2e/**',
      '**/*.config.ts',
      '**/src/main.tsx',
      '**/src/runtime/**',
    ],
    rules: {
      'no-restricted-syntax': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
