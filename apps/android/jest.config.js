/**
 * RN component tests only — split from `vitest.config.ts` per docs/android-client-plan.md's test
 * strategy table ("RN UI | Jest + @testing-library/react-native"). Vitest's jsdom/node
 * environments can't execute the actual React Native renderer; `jest-expo`'s preset provides the
 * native-module mocks (NativeModules, TurboModules, Expo's own modules) that doing so requires.
 *
 * Split by extension, not directory: `.test.ts` (pure logic, no RN import) stays on Vitest per
 * `vitest.config.ts`'s `include`; `.test.tsx` (anything that renders a component) runs here.
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
    // Same story for expo-sqlite's native database binding — see testUtils/mockExpoSqlite.ts.
    '^expo-sqlite$': '<rootDir>/src/testUtils/mockExpoSqlite.ts',
    // Android Keystore and the native CSPRNG have no headless equivalent under Jest — see
    // testUtils/mockExpoSecureStore.ts and testUtils/mockExpoCrypto.ts.
    '^expo-secure-store$': '<rootDir>/src/testUtils/mockExpoSecureStore.ts',
    '^expo-crypto$': '<rootDir>/src/testUtils/mockExpoCrypto.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg)',
  ],
};
