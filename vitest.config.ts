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
      './packages/store/vitest.config.ts',
      './apps/web/vitest.config.ts',
      './apps/api/vitest.config.ts',
      './apps/android/vitest.config.ts',
    ],

    coverage: {
      // istanbul, not v8: the v8 provider needs node:inspector, which does not exist in
      // workerd, so it silently collects nothing from the Worker and Durable Object tests.
      // That would leave the Durable Object's authoritative double-dose check uncovered —
      // exactly the code that must not be. istanbul instruments at transform time and works
      // in all three environments.
      provider: 'istanbul',
      // text-summary/json-summary feed ci.yml's $GITHUB_STEP_SUMMARY coverage step — cheap to
      // generate, and it's the one reporter format short enough to paste straight into a PR run
      // summary without truncation.
      reporter: ['text', 'text-summary', 'json-summary', 'html', 'lcov'],
      include: ['packages/shared/src/**/*.ts', 'packages/store/src/**/*.ts', 'apps/*/src/**/*.{ts,tsx}'],
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
        // Sprint A2 (docs/android-client-plan.md, test-strategy table): RN screens/components
        // run under Jest + @testing-library/react-native, a separate tool this Vitest+istanbul
        // run has no visibility into — Jest exercising a file does not register here, so every
        // apps/android/src file only reachable through a rendered component would otherwise show
        // a false 0% and sink the global threshold despite having real Jest coverage
        // (apps/android/*/**/*.test.tsx, gated by apps/android/jest.config.js's own
        // coverageThreshold). This exclusion only removes what Jest, not nothing, already proves
        // — it must name exactly the RN/native-touching surface, not the whole app: `alarms/*.ts`
        // (materializeHorizon, diffAlarms, AlarmEngine, alarmHealth — the code that decides
        // whether a phone rings) and `store/expoSqliteDriver.ts` are pure/port-injected, import
        // nothing native, and already run — and are covered — under this same Vitest project
        // (apps/android/vitest.config.ts's `include: ['src/**/*.test.ts']`). Excluding them here
        // would leave the app's most safety-critical code with no coverage floor at all.
        'apps/android/src/**/*.tsx',
        'apps/android/src/api/**',
        'apps/android/src/app/**',
        'apps/android/src/clock/**',
        'apps/android/src/features/**',
        'apps/android/src/identity/**',
        'apps/android/src/logging/**',
        'apps/android/src/runtime/**',
        'apps/android/src/store/useLiveQuery.ts',
        'apps/android/src/sync/**',
        'apps/android/src/testUtils/**',
        'apps/android/src/ui/**',
        'apps/android/src/version.ts',
        // Not yet covered by either runner — see docs/testing.md's "Adding a new test" section.
        // Delete this line once apps/android/src/alarms/headlessTask.test.tsx lands.
        'apps/android/src/alarms/headlessTask.ts',
        'apps/android/index.ts',
        'apps/android/App.tsx',
        // Barrel re-exports and the conformance-suite/fixture harness itself — no logic of their
        // own, exercised entirely through the tests that import from them.
        'packages/store/src/index.ts',
        'packages/store/src/dexie/index.ts',
        'packages/store/src/sqlite/index.ts',
        'packages/store/src/testing/**',
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
        // Sprint A3 (delta AD5): a bug here either leaves an alarm armed that a caregiver
        // dismissed, or — worse — lets a dose be deferred past the point where it should have
        // escalated. Both clients and, from A4, the Durable Object all decide from this one
        // function, so it is held to the same bar as the rest of the alarm-critical path.
        'packages/shared/src/snooze.ts': { lines: 100, functions: 100, branches: 100, statements: 100 },

        // Sprint A5: the single answer to "is it Shabbat right now", read by the Durable Object's
        // alarm chain, the Android alarm horizon and both clients' UI. A wrong `false` writes a
        // record on Shabbat; a wrong `true` silences an escalation on a weekday.
        'packages/shared/src/shabbat.ts': { lines: 100, functions: 100, branches: 100, statements: 100 },

        // How long an alert rings, and the clamp that bounds it. Held here because the failure
        // this replaced was not theoretical: a Shabbat spent with phones ringing continuously.
        // The number decided here is baked into an alarm payload days ahead and consumed by a
        // Kotlin service that may run with no JS process alive to correct it.
        'packages/shared/src/chime.ts': { lines: 100, functions: 100, branches: 100, statements: 100 },

        // Sprint A1 (docs/android-client-plan.md, "Storage and the sync port"): the extracted
        // outbox/transaction code and the LWW-vs-append-only merge dispatch carry the same
        // safety invariant 7 (no log lost across an offline→online cycle, no retry ever
        // double-applying) the rest of this list protects.
        'packages/store/src/repository.ts': { lines: 100, functions: 100, branches: 100, statements: 100 },
        'packages/store/src/tableDispatch.ts': { lines: 100, functions: 100, branches: 100, statements: 100 },

        // The Android alarm-materialization path — the code that decides whether a phone rings,
        // now that the exclusion above no longer hides it. Thresholds are set at the measured
        // baseline (2026-08-16), not guessed at 100, so this doesn't land red on an unrelated PR.
        // Ratchet rule: raise as coverage improves, never lower to make a build pass.
        'apps/android/src/alarms/AlarmEngine.ts': { lines: 100, functions: 100, branches: 83, statements: 100 },
        'apps/android/src/alarms/alarmHealth.ts': { lines: 100, functions: 100, branches: 95, statements: 100 },
        'apps/android/src/alarms/alarmReconciler.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'apps/android/src/alarms/horizon.ts': { lines: 100, functions: 100, branches: 93, statements: 100 },
      },
    },
  },
});
