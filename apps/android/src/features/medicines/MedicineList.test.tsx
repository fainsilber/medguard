import { fireEvent, waitFor } from '@testing-library/react-native';
import { fixedClock } from '@medguard/shared/testing';
import { renderWithRepository } from '../../testUtils/renderWithRepository.js';
import { MedicineList } from './MedicineList.js';

describe('MedicineList', () => {
  it('renders the empty state and calls onAddMedicine when "+ Add medicine" is pressed', async () => {
    const onAddMedicine = jest.fn();
    const { getByText, queryByText } = renderWithRepository(
      <MedicineList
        onAddMedicine={onAddMedicine}
        onEditMedicine={jest.fn()}
        onAddSchedule={jest.fn()}
        onEditSchedule={jest.fn()}
      />,
      { clock: fixedClock('2026-06-15T12:00:00.000Z'), dbName: 'medicine-list-smoke.db' },
    );

    await waitFor(() => expect(queryByText('No medicines yet.')).toBeTruthy());
    fireEvent.press(getByText('+ Add medicine'));

    expect(onAddMedicine).toHaveBeenCalledTimes(1);
  });
});
