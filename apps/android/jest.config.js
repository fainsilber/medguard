/**
 * RN component tests only — split from `vitest.config.ts` per docs/android-client-plan.md's test
 * strategy table ("RN UI | Jest + @testing-library/react-native"). Vitest's jsdom/node
 * environments can't execute the actual React Native renderer; `jest-expo`'s preset provides the
 * native-module mocks (NativeModules, TurboModules, Expo's own modules) that doing so requires.
 *
 * Split by extension, not directory — but "extension" here is shorthand for "does it import
 * react-native or an Expo/native module". Every remaining untested leaf under `src/` does (e.g.
 * `api/config.ts` → expo-constants, `clock/localClockGuard.ts` → RN's AppState,
 * `identity/*.ts` → expo-secure-store), so those get named `.test.tsx` and run here even with no
 * JSX in them — `.test.ts` is reserved for files with zero RN/native imports, which stay on
 * Vitest per `vitest.config.ts`'s `include`.
 */
module.exports = {
  preset: 'jest-expo',
  rootDir: '.',
  testMatch: ['<rootDir>/src/**/*.test.tsx'],
  // Source uses explicit `.js`-suffixed relative specifiers (required for real Node ESM/workerd
  // resolution — see metro.config.js's matching resolver.resolveRequest hack). Strip the
  // extension so Jest's own moduleFileExtensions (which tries .tsx/.ts before .js) resolves it.
  moduleNameMapper: {
    // The native alarm module has no device to run against under Jest — see testUtils/mockMedguardAlarms.ts.
    'modules/medguard-alarms/src$': '<rootDir>/src/testUtils/mockMedguardAlarms.ts',
    // Same story for expo-sqlite's native database binding — see testUtils/sqliteTestDouble.ts.
    '^expo-sqlite$': '<rootDir>/src/testUtils/sqliteTestDouble.ts',
    // Android Keystore and the native CSPRNG have no headless equivalent under Jest — see
    // testUtils/mockExpoSecureStore.ts and testUtils/mockExpoCrypto.ts.
    '^expo-secure-store$': '<rootDir>/src/testUtils/mockExpoSecureStore.ts',
    '^expo-crypto$': '<rootDir>/src/testUtils/mockExpoCrypto.ts',
    // BackupRestoreCard's import path (document picker + a read) and export path (a write + the
    // OS share sheet) — none of the three has a headless equivalent under Jest. See
    // testUtils/mockExpoDocumentPicker.ts, mockExpoFileSystem.ts, mockExpoSharing.ts.
    //
    // expo-file-system/legacy is deliberately NOT mapped here, unlike the other two: jest-expo's
    // own preset (node_modules/jest-expo/src/preset/setup.js) already calls
    // `jest.mock('expo-file-system/legacy', ...)` with its own (no-op, no cacheDirectory) stub —
    // a moduleNameMapper entry for it would just be shadowed. BackupRestoreCard.test.tsx
    // re-registers its own `jest.mock('expo-file-system/legacy', ...)` instead, which — being
    // called from the test file itself, after the preset's setupFiles already ran — wins.
    '^expo-document-picker$': '<rootDir>/src/testUtils/mockExpoDocumentPicker.ts',
    '^expo-sharing$': '<rootDir>/src/testUtils/mockExpoSharing.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg)',
  ],
  // The other half of the coverage split introduced alongside vitest.config.ts's narrowed
  // apps/android/src exclusion: that config gates exactly the pure/native-free surface
  // (alarms/*.ts, store/expoSqliteDriver.ts); this gates exactly its complement, so every
  // shipped line of apps/android/src is under one gate or the other, never both and never
  // neither. collectCoverageFrom excludes what belongs to the other gate, composition roots
  // (app/RepositoryContext.tsx, app/useHouseholdSettings.ts — no logic of their own, same
  // rationale as apps/web/src/main.tsx), and thin platform adapters (version.ts, api/config.ts).
  //
  // A merged single report (`nyc merge` across both istanbul outputs) would be the technically
  // cleaner answer — one true apps/android/src number — but it's an accounting improvement, not
  // a coverage one; see docs/testing.md.
  collectCoverage: true,
  coverageDirectory: '<rootDir>/coverage',
  // json-summary feeds ci.yml's coverage-summary step, same as vitest.config.ts's own reporter
  // list does for the other four projects — one aggregate number per run, not just per-file HTML.
  coverageReporters: ['text-summary', 'html', 'lcov', 'json', 'json-summary'],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.test.{ts,tsx}',
    '!src/testUtils/**',
    '!src/alarms/*.ts',
    '!src/store/expoSqliteDriver.ts',
    '!src/store/useLiveQuery.ts',
    '!src/runtime/**',
    '!src/ui/primitives.tsx',
    '!src/version.ts',
    '!src/api/config.ts',
    '!src/app/RepositoryContext.tsx',
    '!src/app/useHouseholdSettings.ts',
  ],
  // Re-measured (2026-08-16) after the Phase 1 gap-fill tests landed: lines 73.17%, functions
  // 62.86%, branches 58.92%, statements 72.05%, floored for headroom against incidental
  // fluctuation. See docs/testing.md. Ratchet rule: raise as coverage improves, never lower to
  // make a build pass.
  coverageThreshold: {
    global: { lines: 72, functions: 62, branches: 58, statements: 71 },
  },
};
