import { fireEvent, waitFor } from '@testing-library/react-native';
import { fixedClock } from '@medguard/shared/testing';
import { renderWithRepository } from '../../testUtils/renderWithRepository.js';
import { MedicineForm } from './MedicineForm.js';

describe('MedicineForm', () => {
  it('blocks submission when name and strength are empty', async () => {
    const onDone = jest.fn();
    const { getByText, queryByText } = renderWithRepository(
      <MedicineForm onDone={onDone} onCancel={jest.fn()} />,
      { clock: fixedClock('2026-06-15T12:00:00.000Z'), dbName: 'medicine-form-validation.db' },
    );

    await waitFor(() => expect(queryByText('Add medicine')).toBeTruthy());
    fireEvent.press(getByText('Save'));

    await waitFor(() => expect(queryByText('Name and strength are required.')).toBeTruthy());
    expect(onDone).not.toHaveBeenCalled();
  });

  it('shows "Edit medicine" and pre-fills fields when a medicine is passed', async () => {
    const medicine = {
      id: 'medicine-1',
      patientId: 'patient-1',
      name: 'Amoxicillin',
      strength: '250mg',
      form: 'pill' as const,
      asNeeded: false,
      archived: false,
      updatedAt: '2026-06-01T00:00:00.000Z',
      updatedByDeviceId: 'device-1',
      syncStatus: 'synced' as const,
    };

    const { getByText, getByDisplayValue } = renderWithRepository(
      <MedicineForm medicine={medicine} onDone={jest.fn()} onCancel={jest.fn()} />,
      { clock: fixedClock('2026-06-15T12:00:00.000Z'), dbName: 'medicine-form-edit.db' },
    );

    await waitFor(() => expect(getByText('Edit medicine')).toBeTruthy());
    expect(getByDisplayValue('Amoxicillin')).toBeTruthy();
    expect(getByDisplayValue('250mg')).toBeTruthy();
  });
});
