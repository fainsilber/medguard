import { fireEvent, waitFor } from '@testing-library/react-native';
import { fixedClock } from '@medguard/shared/testing';
import { renderWithRepository } from '../testUtils/renderWithRepository.js';
import { seedPatient } from '../testUtils/seedAlarmData.js';
import { PatientSwitcher } from './PatientSwitcher.js';

const NOW = '2026-06-15T12:00:00.000Z';

describe('PatientSwitcher', () => {
  it('renders nothing for a single-patient household', async () => {
    const dbName = 'patient-switcher-single.db';
    await seedPatient(dbName, {
      id: '11111111-1111-4111-8111-111111111111',
      displayName: 'Yoni',
      archived: false,
      sortOrder: 0,
      updatedAt: '',
      updatedByDeviceId: '',
      syncStatus: 'pending',
    });

    const { queryByText } = renderWithRepository(<PatientSwitcher />, {
      clock: fixedClock(NOW),
      dbName,
    });

    // One patient is not a choice — the bootstrap effect never fires (a row already exists) and
    // the switcher stays hidden throughout, so there's nothing to wait for.
    await waitFor(() => expect(queryByText('Yoni')).toBeNull());
  });

  it('shows "All patients" by default and lists every patient once there are several', async () => {
    const dbName = 'patient-switcher-multi.db';
    await seedPatient(dbName, {
      id: '11111111-1111-4111-8111-111111111111',
      displayName: 'Yoni',
      archived: false,
      sortOrder: 0,
      updatedAt: '',
      updatedByDeviceId: '',
      syncStatus: 'pending',
    });
    await seedPatient(dbName, {
      id: '22222222-2222-4222-8222-222222222222',
      displayName: 'Dad',
      archived: false,
      sortOrder: 1,
      updatedAt: '',
      updatedByDeviceId: '',
      syncStatus: 'pending',
    });

    const { getByText, findByText } = renderWithRepository(<PatientSwitcher />, {
      clock: fixedClock(NOW),
      dbName,
    });

    fireEvent.press(await findByText('All patients'));
    expect(getByText('Yoni')).toBeTruthy();
    expect(getByText('Dad')).toBeTruthy();
  });

  it('switches the current selection and updates the button label', async () => {
    const dbName = 'patient-switcher-select.db';
    await seedPatient(dbName, {
      id: '11111111-1111-4111-8111-111111111111',
      displayName: 'Yoni',
      archived: false,
      sortOrder: 0,
      updatedAt: '',
      updatedByDeviceId: '',
      syncStatus: 'pending',
    });
    await seedPatient(dbName, {
      id: '22222222-2222-4222-8222-222222222222',
      displayName: 'Dad',
      archived: false,
      sortOrder: 1,
      updatedAt: '',
      updatedByDeviceId: '',
      syncStatus: 'pending',
    });

    const { getByText, findByText, getAllByText, queryByText } = renderWithRepository(
      <PatientSwitcher />,
      { clock: fixedClock(NOW), dbName },
    );

    fireEvent.press(await findByText('All patients'));
    fireEvent.press(getByText('Yoni'));

    // Selecting closes the menu, so "Dad" (menu-only content) disappears — leaving exactly one
    // "Yoni", now the switcher button's own label.
    await waitFor(() => expect(queryByText('Dad')).toBeNull());
    expect(getAllByText('Yoni')).toHaveLength(1);
  });
});
