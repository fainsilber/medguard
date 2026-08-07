import { useState } from 'react';
import { Text, View } from 'react-native';
import { describeSchedule, formatLocalDate } from '@medguard/shared';
import type { Schedule } from '@medguard/shared';
import { useClock, useRepository } from '../../app/RepositoryContext.js';
import { useHouseholdSettings } from '../../app/useHouseholdSettings.js';
import { useLiveQuery } from '../../store/useLiveQuery.js';
import { Button, colors, styles as sharedStyles } from '../../ui/primitives.js';

/**
 * A medicine's schedule history: the live version plus every closed one, since a closed
 * schedule still owns the historical doses it produced (safety invariant 1) and stays visible
 * rather than disappearing. RN port of `apps/web/src/features/schedules/ScheduleList.tsx`.
 *
 * Unlike web, "Change"/"+ Add schedule" don't swap in `ScheduleForm` in place — they call
 * `onEditSchedule`/`onAddSchedule` so a stack navigator can push `ScheduleForm` as its own screen.
 */
export function ScheduleList({
  medicineId,
  onAddSchedule,
  onEditSchedule,
}: {
  medicineId: string;
  onAddSchedule: () => void;
  onEditSchedule: (schedule: Schedule) => void;
}): React.JSX.Element {
  const repository = useRepository();
  const clock = useClock();
  const householdSettings = useHouseholdSettings();

  const schedules = useLiveQuery(() => repository.schedulesForMedicine(medicineId), ['schedules']);

  const today = householdSettings ? formatLocalDate(householdSettings.timeZone, clock.nowMs()) : undefined;

  const active = (schedules ?? []).filter((schedule) => schedule.active);
  const past = (schedules ?? []).filter((schedule) => !schedule.active);
  const [showPast, setShowPast] = useState(false);

  return (
    <View style={{ gap: 10 }}>
      <View style={[sharedStyles.row, { justifyContent: 'space-between' }]}>
        <Text style={{ color: colors.text, fontSize: 13, fontWeight: '600' }}>Schedule</Text>
        <Button label="+ Add schedule" onPress={onAddSchedule} disabled={!today} />
      </View>

      {schedules === undefined || !today ? (
        <Text style={sharedStyles.subtitle}>Loading…</Text>
      ) : active.length === 0 ? (
        <Text style={sharedStyles.subtitle}>No active schedule.</Text>
      ) : (
        <View style={{ gap: 6 }}>
          {active.map((schedule) => (
            <View
              key={schedule.id}
              style={[sharedStyles.row, { justifyContent: 'space-between', borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 8 }]}
            >
              <Text style={{ color: colors.text, fontSize: 13, flex: 1 }}>{describeSchedule(schedule)}</Text>
              <View style={sharedStyles.row}>
                <Button label="Change" onPress={() => onEditSchedule(schedule)} />
                <Button label="Stop" onPress={() => void repository.closeSchedule(schedule.id, today)} />
              </View>
            </View>
          ))}
        </View>
      )}

      {past.length > 0 && (
        <View style={{ gap: 4 }}>
          <Button label={showPast ? `Hide past schedules (${past.length})` : `Past schedules (${past.length})`} onPress={() => setShowPast((current) => !current)} />
          {showPast && (
            <View style={{ gap: 4 }}>
              {past.map((schedule) => (
                <Text key={schedule.id} style={sharedStyles.subtitle}>
                  {describeSchedule(schedule)} — ended {schedule.endDate ?? '(never took effect)'}
                </Text>
              ))}
            </View>
          )}
        </View>
      )}
    </View>
  );
}
