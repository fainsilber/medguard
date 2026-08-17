import { render } from '@testing-library/react-native';
import type { RenderResult } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { fixedClock, sequentialIds } from '@medguard/shared/testing';
import type { Clock } from '@medguard/shared';
import { PatientProvider } from '../app/PatientProvider.js';
import { RepositoryProvider } from '../app/RepositoryContext.js';

/**
 * Shared harness for feature tests that render against a real repository. `RepositoryProvider`
 * opens `expo-sqlite`'s database asynchronously (`jest.config.js`'s `moduleNameMapper` swaps the
 * real, deviceless native module for `testUtils/sqliteTestDouble.ts`, a `better-sqlite3`-backed
 * stand-in — every other line of production code runs unmodified against it) and renders a
 * loading spinner (with no `testID` of its own — it's the composition root, out of scope for this
 * sprint's features to change) until its handles resolve, so every caller must `waitFor` past
 * that itself — typically by asserting on something the screen under test renders once mounted
 * (its title, an empty-state string, …). This helper only centralizes the provider wiring, not
 * that wait.
 *
 * `dbName` defaults to a fresh name per call so parallel tests never share a database file; pass
 * one explicitly if a test needs to reopen the same database (e.g. to assert a write persisted,
 * or to pre-seed via `sqliteTestDouble.ts`'s `rawDatabaseForSeeding`).
 */
const ids = sequentialIds('renderWithRepository-db');

export function renderWithRepository(
  ui: ReactElement,
  options: { dbName?: string; clock?: Clock } = {},
): RenderResult {
  const dbName = options.dbName ?? `${ids.next()}.db`;
  const clock = options.clock ?? fixedClock('2026-01-15T08:00:00.000Z');

  return render(
    <RepositoryProvider userId="test-user" dbName={dbName} clock={clock}>
      <PatientProvider>{ui}</PatientProvider>
    </RepositoryProvider>,
  );
}
