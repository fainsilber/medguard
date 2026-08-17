import 'fake-indexeddb/auto';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SINGLE_PATIENT_ID } from '@medguard/shared';
import { renderWithRepository } from '../testUtils/renderWithRepository.js';
import { usePatients } from './PatientProvider.js';

/** Renders the current context value as text, so tests can assert on it without a real screen. */
function Probe() {
  const { patients, selection, filterPatientId } = usePatients();
  return (
    <div>
      <p data-testid="patients">{patients.map((p) => p.displayName).join(',')}</p>
      <p data-testid="selection">{selection}</p>
      <p data-testid="filter">{filterPatientId ?? '(none)'}</p>
    </div>
  );
}

afterEach(() => {
  localStorage.clear();
});

describe('PatientProvider', () => {
  it('bootstraps a default patient on first run, matching the server backfill id', async () => {
    await renderWithRepository(
<Probe />,
    );

    await waitFor(() => expect(screen.getByTestId('patients')).toHaveTextContent('Patient'));
    expect(screen.getByTestId('selection')).toHaveTextContent('all');
    expect(screen.getByTestId('filter')).toHaveTextContent('(none)');
  });

  it('does not create a second default patient if one already exists', async () => {
    await renderWithRepository(
<Probe />,
      {
        seed: async (repository) => {
          await repository.savePatient(
            {
              id: SINGLE_PATIENT_ID,
              displayName: 'Yoni',
              archived: false,
              sortOrder: 0,
              updatedAt: '2026-01-01T00:00:00.000Z',
              updatedByDeviceId: 'seed',
              syncStatus: 'synced',
            },
            'CREATE',
          );
        },
      },
    );

    await waitFor(() => expect(screen.getByTestId('patients')).toHaveTextContent('Yoni'));
    expect(screen.getByTestId('patients')).not.toHaveTextContent('Patient,Yoni');
  });

  it('excludes an archived patient from the roster', async () => {
    await renderWithRepository(
<Probe />,
      {
        seed: async (repository) => {
          await repository.savePatient(
            {
              id: 'active-1',
              displayName: 'Active',
              archived: false,
              sortOrder: 0,
              updatedAt: '2026-01-01T00:00:00.000Z',
              updatedByDeviceId: 'seed',
              syncStatus: 'synced',
            },
            'CREATE',
          );
          await repository.savePatient(
            {
              id: 'archived-1',
              displayName: 'Archived',
              archived: true,
              sortOrder: 1,
              updatedAt: '2026-01-01T00:00:00.000Z',
              updatedByDeviceId: 'seed',
              syncStatus: 'synced',
            },
            'CREATE',
          );
        },
      },
    );

    await waitFor(() => expect(screen.getByTestId('patients')).toHaveTextContent('Active'));
    expect(screen.getByTestId('patients')).not.toHaveTextContent('Archived');
  });

  it('falls back to "all" when the stored selection no longer matches any patient', async () => {
    localStorage.setItem('medguard.selectedPatientId', 'somebody-who-was-archived');

    await renderWithRepository(
<Probe />,
    );

    await waitFor(() => expect(screen.getByTestId('patients')).toHaveTextContent('Patient'));
    expect(screen.getByTestId('selection')).toHaveTextContent('all');
  });

  it('select() persists the choice and resolves filterPatientId to the concrete id', async () => {
    let selectFn: ((selection: string) => void) | undefined;

    function Capture() {
      const ctx = usePatients();
      selectFn = ctx.select;
      return <Probe />;
    }

    await renderWithRepository(
      <Capture />,
      {
        seed: async (repository) => {
          await repository.savePatient(
            {
              id: 'p-1',
              displayName: 'Yoni',
              archived: false,
              sortOrder: 0,
              updatedAt: '2026-01-01T00:00:00.000Z',
              updatedByDeviceId: 'seed',
              syncStatus: 'synced',
            },
            'CREATE',
          );
        },
      },
    );

    await waitFor(() => expect(screen.getByTestId('patients')).toHaveTextContent('Yoni'));

    act(() => {
      selectFn!('p-1');
    });

    expect(screen.getByTestId('selection')).toHaveTextContent('p-1');
    expect(screen.getByTestId('filter')).toHaveTextContent('p-1');
    expect(localStorage.getItem('medguard.selectedPatientId')).toBe('p-1');
  });
});

describe('usePatients', () => {
  it('throws when used outside a PatientProvider', () => {
    // React logs the thrown error to the console during a failed render; expected noise for this
    // one negative test, matching the pattern in RepositoryContext.test.tsx.
    const spy = () => {};
    const original = console.error;
    console.error = spy;
    try {
      expect(() => render(<Probe />)).toThrow(/usePatients must be used within a PatientProvider/);
    } finally {
      console.error = original;
    }
  });
});
