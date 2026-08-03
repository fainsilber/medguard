import { defineConfig } from 'vitest/config';

/**
 * One runner across every layer, so `npm test` is the single command that proves the system.
 *
 * The api project is defined by its own config because it runs inside the real workerd runtime
 * via @cloudflare/vitest-pool-workers — real D1, real Durable Objects, no Cloudflare account.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'shared',
          root: './packages/shared',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      './apps/web/vitest.config.ts',
      './apps/api/vitest.config.ts',
    ],

    coverage: {
      // istanbul, not v8: the v8 provider needs node:inspector, which does not exist in
      // workerd, so it silently collects nothing from the Worker and Durable Object tests.
      // That would leave the Durable Object's authoritative double-dose check uncovered —
      // exactly the code that must not be. istanbul instruments at transform time and works
      // in all three environments.
      provider: 'istanbul',
      reporter: ['text', 'html', 'lcov'],
      include: ['packages/shared/src/**/*.ts', 'apps/*/src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/*.d.ts',
        '**/testing.ts',
        // Composition roots and platform adapters: no logic of their own, only wiring of real
        // clocks, real ids and real service workers. Their correctness is proven by the E2E
        // suite, not by unit coverage.
        'apps/web/src/main.tsx',
        'apps/web/src/sw.ts',
        'packages/shared/src/runtime/**',
        'packages/shared/src/index.ts',
      ],
      thresholds: {
        // Global floor.
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,

        // The patient-safety modules. A dosing error here can harm a child, so these are held
        // at 100% branch coverage and the build fails below it.
        //
        // timezone.ts and logs.ts are held to the same bar despite not being named in the sprint
        // plan: a DST bug skips or doubles a dose, and a bug in supersession arithmetic makes the
        // rolling-cap count wrong. Both are safety-critical in the same way the named three are.
        'packages/shared/src/clock.ts': { lines: 100, functions: 100, branches: 100, statements: 100 },
        'packages/shared/src/safety.ts': { lines: 100, functions: 100, branches: 100, statements: 100 },
        'packages/shared/src/schedule.ts': { lines: 100, functions: 100, branches: 100, statements: 100 },
        'packages/shared/src/inventory.ts': { lines: 100, functions: 100, branches: 100, statements: 100 },
        'packages/shared/src/timezone.ts': { lines: 100, functions: 100, branches: 100, statements: 100 },
        'packages/shared/src/logs.ts': { lines: 100, functions: 100, branches: 100, statements: 100 },
        'packages/shared/src/sync.ts': { lines: 100, functions: 100, branches: 100, statements: 100 },
      },
    },
  },
});
