import { useMemo, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import {
  MS_PER_DAY,
  addLocalDays,
  classifyOccurrence,
  deriveSnoozeState,
  expandSchedules,
  findLogForOccurrence,
  formatLocalDate,
  formatLocalTime,
  fromIso,
  occurrenceKey,
  resolveLocal,
  resolveMaxSnoozeCount,
  toIso,
} from '@medguard/shared';
import type { Occurrence, OccurrenceStatus } from '@medguard/shared';
import { useAlarmHealth } from '../../alarms/AlarmProvider.js';
import { usePatients } from '../../app/PatientProvider.js';
import {
  useClock,
  useCurrentDeviceId,
  useCurrentUserId,
  useIdGenerator,
  useRepository,
} from '../../app/RepositoryContext.js';
import { useHouseholdSettings } from '../../app/useHouseholdSettings.js';
import { useTick } from '../../app/useTick.js';
import { useLiveQuery } from '../../store/useLiveQuery.js';
import {
  Badge,
  Button,
  Card,
  KeyboardAvoidingScreen,
  colors,
  styles as ui,
} from '../../ui/primitives.js';
import { DoseCorrection } from '../logs/DoseCorrection.js';
import { TakenTimePrompt } from './TakenTimePrompt.js';

/** Frequent enough that overdue/due-now buckets feel live, cheap enough not to matter. */
const REFRESH_INTERVAL_MS = 30_000;

const STATUS_LABEL: Record<OccurrenceStatus, string> = {
  overdue: 'Overdue',
  due_now: 'Due now',
  snoozed: 'Snoozed',
  upcoming: 'Upcoming',
  pending_shabbat: 'Awaiting Shabbat reconciliation',
  done: 'Done',
};

const STATUS_HEADING_COLOR: Record<OccurrenceStatus, string> = {
  overdue: colors.locked,
  due_now: colors.capped,
  snoozed: colors.textMuted,
  upcoming: colors.textMuted,
  pending_shabbat: colors.capped,
  done: colors.safe,
};

/**
 * RN port of `apps/web/src/features/today/TodayView.tsx` — doses due today, bucketed into
 * Overdue/Due now/Snoozed/Upcoming/Done. Reads via the repository (`allSchedules()`,
 * `logsForPatient()`, `allMedicines()`) instead of raw Dexie table scans, through the shared
 * `useLiveQuery` hook.
 */
export function TodayView(): React.JSX.Element {
  const repository = useRepository();
  const clock = useClock();
  const ids = useIdGenerator();
  const userId = useCurrentUserId();
  const deviceId = useCurrentDeviceId();
  const householdSettings = useHouseholdSettings();
  const { patients, filterPatientId } = usePatients();
  const { snooze, silenceChime } = useAlarmHealth();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [promptingKey, setPromptingKey] = useState<string | null>(null);

  useTick(REFRESH_INTERVAL_MS);

  // Always fetched unfiltered: `useLiveQuery` only re-runs on a table write, not when
  // `filterPatientId` changes, so filtering has to happen below in a plain `useMemo` instead of
  // inside the query itself — otherwise switching patients in the header would leave the screen
  // showing the previous selection until the next unrelated write. `logs` stays unfiltered even
  // there: a dose logged for any patient still has to be matched against its own occurrence via
  // `findLogForOccurrence`, and `DoseCorrection` needs the full correction chain.
  const allSchedules = useLiveQuery(() => repository.allSchedules(), ['schedules']);
  const logs = useLiveQuery(() => repository.allLogs(), ['intakeLogs']);
  const medicines = useLiveQuery(() => repository.allMedicines(), ['medicines']);

  const schedules = useMemo(
    () =>
      allSchedules === undefined || filterPatientId === undefined
        ? allSchedules
        : allSchedules.filter((schedule) => schedule.patientId === filterPatientId),
    [allSchedules, filterPatientId],
  );

  const patientNames = useMemo(
    () => new Map(patients.map((patient) => [patient.id, patient.displayName])),
    [patients],
  );
  const showPatientBadges = filterPatientId === undefined && patients.length > 1;

  const nowMs = clock.nowMs();
  const timeZone = householdSettings?.timeZone;
  const today = timeZone ? formatLocalDate(timeZone, nowMs) : undefined;
  const maxSnoozeCount = resolveMaxSnoozeCount(householdSettings?.maxSnoozeCount);

  // Bounded by `nowMs` alone, deliberately not by `today`/`timeZone`: those load asynchronously
  // from `householdSettings`, and `useLiveQuery` only re-runs its query on a table write, never
  // because a closure it captured changed — a bound gated on the not-yet-loaded timezone would
  // permanently cache an empty result from the one query that ran before settings arrived. A
  // day's lookback comfortably covers every occurrence shown today, the same margin
  // `AlarmEngine`'s reconcile pass uses.
  const snoozes = useLiveQuery(
    () => repository.recentSnoozes(toIso(nowMs - MS_PER_DAY)),
    ['doseSnoozes'],
  );

  const rows = useMemo(() => {
    if (!schedules || !logs || !timeZone || !today || !snoozes) {
      return undefined;
    }

    const tomorrow = addLocalDays(today, 1);
    const range = {
      fromMs: resolveLocal(timeZone, today, '00:00').instantMs,
      toMs: resolveLocal(timeZone, tomorrow, '00:00').instantMs,
    };

    return expandSchedules(schedules, range, timeZone).map((occurrence) => {
      const key = occurrenceKey(occurrence);
      const log = findLogForOccurrence(logs, occurrence);
      const snoozeState = deriveSnoozeState(snoozes, key, maxSnoozeCount);
      const status = classifyOccurrence(occurrence.dueAt, nowMs, log?.status, snoozeState.untilMs);
      return { occurrence, log, status, key, snoozeState };
    });
  }, [schedules, logs, timeZone, today, nowMs, snoozes, maxSnoozeCount]);

  const medicineNames = useMemo(() => {
    if (!medicines) return undefined;
    return new Map(
      medicines.map((medicine) => [medicine.id, `${medicine.name} ${medicine.strength}`]),
    );
  }, [medicines]);

  const handleTaken = async (occurrence: Occurrence, key: string, actualTimeIso?: string) => {
    setBusyKey(key);
    try {
      await repository.recordDose({
        id: ids.next(),
        patientId: occurrence.patientId,
        medicineId: occurrence.medicineId,
        scheduleId: occurrence.scheduleId,
        type: 'scheduled',
        status: 'taken',
        scheduledTime: occurrence.dueAt,
        actualTime: actualTimeIso ?? clock.nowIso(),
        quantityTaken: occurrence.dosageQuantity,
        loggedByUserId: userId,
        loggedByDeviceId: deviceId,
        syncStatus: 'pending',
      });
      setPromptingKey(null);
      // Marking the dose is one of the stop conditions for the alert (the others being a physical
      // button and the timeout). Cancelling the alarm — which the reconcile pass does moments from
      // now — only unschedules a *future* one, so without this the phone keeps ringing.
      void silenceChime(key);
    } finally {
      setBusyKey(null);
    }
  };

  /**
   * An overdue dose is the one case where "when was this taken?" has a real answer other than
   * "now" — so it asks. Anything else logs straight away.
   */
  const handleTakenPress = (occurrence: Occurrence, key: string, status: OccurrenceStatus) => {
    if (status === 'overdue') {
      setPromptingKey(key);
      return;
    }
    void handleTaken(occurrence, key);
  };

  const handleSkipped = async (occurrence: Occurrence, key: string) => {
    setBusyKey(key);
    try {
      await repository.recordDose({
        id: ids.next(),
        patientId: occurrence.patientId,
        medicineId: occurrence.medicineId,
        scheduleId: occurrence.scheduleId,
        type: 'scheduled',
        status: 'skipped',
        scheduledTime: occurrence.dueAt,
        actualTime: clock.nowIso(),
        quantityTaken: 0,
        loggedByUserId: userId,
        loggedByDeviceId: deviceId,
        syncStatus: 'pending',
      });
      void silenceChime(key);
    } finally {
      setBusyKey(null);
    }
  };

  /**
   * Persisted and bounded (Sprint A3, delta AD5) — an append-only `DoseSnooze` through the same
   * `AlarmEngine` a notification-action snooze uses, so a reload no longer clears it and the
   * local alarm re-arms to the new deadline. `AlarmEngine.snooze` itself enforces the bound; the
   * button here just stops offering it once `snoozeState.canSnooze` says no.
   */
  const handleSnooze = (key: string) => {
    void snooze(key);
  };

  if (!rows || !medicineNames || !timeZone || !householdSettings) {
    return (
      <ScrollView style={ui.screen} contentContainerStyle={ui.content}>
        <Card>
          <Text style={ui.subtitle}>Loading…</Text>
        </Card>
      </ScrollView>
    );
  }

  // Above `done`, not beside it: after Havdalah these are the doses still owing an answer.
  const sections: OccurrenceStatus[] = [
    'overdue',
    'due_now',
    'snoozed',
    'upcoming',
    'pending_shabbat',
    'done',
  ];

  return (
    <KeyboardAvoidingScreen>
      <ScrollView
        style={ui.screen}
        contentContainerStyle={ui.content}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={ui.title}>Today</Text>
        {rows.length === 0 ? <Text style={ui.subtitle}>Nothing scheduled today.</Text> : null}

        {sections.map((status) => {
          const inSection = rows.filter((row) => row.status === status);
          if (inSection.length === 0) return null;

          return (
            <View key={status} style={{ gap: 8 }}>
              <Text
                style={{
                  fontSize: 12,
                  fontWeight: '700',
                  color: STATUS_HEADING_COLOR[status],
                  textTransform: 'uppercase',
                }}
              >
                {STATUS_LABEL[status]}
              </Text>
              <View style={{ gap: 8 }}>
                {inSection.map(({ occurrence, log, key, snoozeState }) => (
                  <Card key={key}>
                    <View
                      style={[
                        ui.row,
                        { justifyContent: 'space-between', alignItems: 'flex-start' },
                      ]}
                    >
                      <View style={{ flex: 1, gap: 2 }}>
                        <View style={[ui.row, { flexWrap: 'wrap' }]}>
                          <Text style={{ fontSize: 14, fontWeight: '600', color: colors.text }}>
                            {medicineNames.get(occurrence.medicineId) ?? 'Unknown medicine'}
                          </Text>
                          {showPatientBadges && (
                            <Badge tone="neutral">
                              {patientNames.get(occurrence.patientId) ?? 'Unknown patient'}
                            </Badge>
                          )}
                        </View>
                        <Text style={{ fontSize: 13, color: colors.textMuted }}>
                          Due {formatLocalTime(timeZone, fromIso(occurrence.dueAt))} ·{' '}
                          {occurrence.dosageQuantity}
                        </Text>
                        {log ? (
                          <>
                            <Text style={{ fontSize: 12, color: colors.textMuted }}>
                              {log.status === 'taken'
                                ? `Taken ${formatLocalTime(timeZone, fromIso(log.actualTime))}`
                                : 'Skipped'}{' '}
                              by {log.loggedByUserId}
                              {log.status === 'taken' && log.actualTime !== occurrence.dueAt
                                ? ' · not at the scheduled time'
                                : ''}
                            </Text>
                            <DoseCorrection allLogs={logs ?? []} tipLog={log} timeZone={timeZone} />
                          </>
                        ) : null}
                      </View>
                      {status !== 'done' && promptingKey !== key ? (
                        <View style={[ui.row, { flexShrink: 0 }]}>
                          <Button
                            label="Taken"
                            onPress={() => handleTakenPress(occurrence, key, status)}
                            disabled={busyKey === key}
                            variant="primary"
                          />
                          <Button
                            label="Skip"
                            onPress={() => void handleSkipped(occurrence, key)}
                            disabled={busyKey === key}
                          />
                          {status !== 'snoozed' && snoozeState.canSnooze ? (
                            <Button
                              label={`Snooze ${householdSettings.snoozeMinutes}m`}
                              onPress={() => handleSnooze(key)}
                              disabled={busyKey === key}
                            />
                          ) : null}
                          {!snoozeState.canSnooze ? (
                            <Text
                              style={{ fontSize: 12, color: colors.textMuted, alignSelf: 'center' }}
                            >
                              Snoozed {snoozeState.count}/{maxSnoozeCount}
                            </Text>
                          ) : null}
                        </View>
                      ) : null}
                    </View>

                    {promptingKey === key ? (
                      <TakenTimePrompt
                        dueAtIso={occurrence.dueAt}
                        nowMs={nowMs}
                        timeZone={timeZone}
                        saving={busyKey === key}
                        onConfirm={(actualTimeIso) =>
                          void handleTaken(occurrence, key, actualTimeIso)
                        }
                        onCancel={() => setPromptingKey(null)}
                      />
                    ) : null}
                  </Card>
                ))}
              </View>
            </View>
          );
        })}
      </ScrollView>
    </KeyboardAvoidingScreen>
  );
}
