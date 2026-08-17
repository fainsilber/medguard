import { useMemo, useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import {
  SINGLE_PATIENT_ID,
  assessDose,
  blockReasonFor,
  clockAt,
  collectReconciliationItems,
  formatLocalDate,
  formatLocalTime,
  fromIso,
  resolveLocal,
  toIso,
} from '@medguard/shared';
import type {
  BlockReason,
  IntakeLog,
  Medicine,
  ReconciliationItem,
  Schedule,
  ShabbatWindow,
} from '@medguard/shared';
import type { ReconciliationEntry } from '@medguard/store';
import {
  useClock,
  useCurrentDeviceId,
  useCurrentUserId,
  useIdGenerator,
  useRepository,
} from '../../app/RepositoryContext.js';
import { useHouseholdSettings } from '../../app/useHouseholdSettings.js';
import { getLocalClockTrust } from '../../clock/localClockGuard.js';
import { useLiveQuery } from '../../store/useLiveQuery.js';
import {
  Button,
  Card,
  KeyboardAvoidingScreen,
  colors,
  styles as ui,
} from '../../ui/primitives.js';

/**
 * RN port of `apps/web/src/features/shabbat/ReconciliationSheet.tsx` — where a caregiver says what
 * actually happened during Shabbat (PRD §3, Sprint A5 phase 2).
 *
 * The native client is the one the household actually carries, so this is the copy that matters:
 * the doses listed here are the ones whose alarms rang on this phone, unanswerable at the time by
 * design.
 */

type Answer = 'given' | 'not_given';

interface RowState {
  answer: Answer;
  time: string;
  quantity: string;
}

/**
 * Raw inputs, kept separate from the derived list on purpose: `useLiveQuery` re-runs only when the
 * *store* changes, so anything derived inside it would freeze at whatever the household timezone
 * was on first render — and the timezone arrives asynchronously, one tick after mount.
 */
interface SheetData {
  windows: ShabbatWindow[];
  schedules: Schedule[];
  medicines: Medicine[];
  logs: IntakeLog[];
}

function defaultRowState(item: ReconciliationItem, timeZone: string): RowState {
  return {
    answer: 'given',
    time: formatLocalTime(timeZone, fromIso(item.occurrence.dueAt)),
    quantity: String(item.occurrence.dosageQuantity),
  };
}

export function ReconciliationSheet({ onDone }: { onDone?: () => void }): React.JSX.Element {
  const repository = useRepository();
  const clock = useClock();
  const ids = useIdGenerator();
  const userId = useCurrentUserId();
  const deviceId = useCurrentDeviceId();
  const householdSettings = useHouseholdSettings();

  const timeZone = householdSettings?.timeZone;
  const nowMs = clock.nowMs();

  const data = useLiveQuery<SheetData>(
    async () => ({
      // Sequential, like every other read on this client: expo-sqlite has one connection, and the
      // `Store` port makes no promise that overlapping transactions are safe.
      windows: await repository.allShabbatWindows(),
      schedules: await repository.allSchedules(),
      medicines: await repository.allMedicines(),
      logs: await repository.logsForPatient(SINGLE_PATIENT_ID),
    }),
    ['shabbatWindows', 'schedules', 'medicines', 'intakeLogs'],
  );

  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const items = useMemo(
    () =>
      data && timeZone
        ? collectReconciliationItems({ ...data, timeZone, nowMs })
        : ([] as ReconciliationItem[]),
    [data, timeZone, nowMs],
  );

  const prnMedicines = useMemo(
    () => (data?.medicines ?? []).filter((medicine) => medicine.asNeeded && !medicine.archived),
    [data],
  );

  if (!data || !timeZone) {
    return (
      <ScrollView contentContainerStyle={ui.content} style={ui.screen}>
        <Card>
          <Text style={ui.subtitle}>Loading…</Text>
        </Card>
      </ScrollView>
    );
  }

  const rowFor = (item: ReconciliationItem): RowState =>
    rows[item.key] ?? defaultRowState(item, timeZone);

  const setRow = (item: ReconciliationItem, changes: Partial<RowState>) => {
    setRows((current) => ({
      ...current,
      [item.key]: { ...(current[item.key] ?? defaultRowState(item, timeZone)), ...changes },
    }));
  };

  const buildEntry = (item: ReconciliationItem, state: RowState): ReconciliationEntry => {
    // Resolved against the day the dose was due, not today: reconciliation happens after
    // Havdalah, a different calendar day from the Friday-night dose being answered.
    const dueMs = fromIso(item.occurrence.dueAt);
    const resolved = resolveLocal(timeZone, formatLocalDate(timeZone, dueMs), state.time);
    const given = state.answer === 'given';

    const log: Omit<IntakeLog, 'supersedesId'> = {
      id: ids.next(),
      patientId: item.occurrence.patientId,
      medicineId: item.occurrence.medicineId,
      scheduleId: item.occurrence.scheduleId,
      type: 'scheduled',
      status: given ? 'taken' : 'skipped',
      scheduledTime: item.occurrence.dueAt,
      actualTime: given ? toIso(resolved.instantMs) : item.occurrence.dueAt,
      quantityTaken: given ? Number(state.quantity) : 0,
      loggedByUserId: userId,
      loggedByDeviceId: deviceId,
      syncStatus: 'pending',
    };

    return { log, ...(item.pendingLog ? { supersedesLogId: item.pendingLog.id } : {}) };
  };

  const submit = async (entries: ReconciliationEntry[]) => {
    if (entries.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      await repository.reconcileShabbatDoses(entries);
      setRows({});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <KeyboardAvoidingScreen>
      <ScrollView
        contentContainerStyle={ui.content}
        style={ui.screen}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={ui.title}>Shabbat is over</Text>

        <Card>
          {items.length === 0 ? (
            <Text style={ui.subtitle}>
              Every dose from Shabbat has been accounted for. Nothing left to record.
            </Text>
          ) : (
            <>
              <Text style={ui.subtitle}>
                {items.length === 1
                  ? 'One scheduled dose from Shabbat has not been recorded yet.'
                  : `${items.length} scheduled doses from Shabbat have not been recorded yet.`}{' '}
                Confirming them updates the medical record and the stock counts, which have both
                been waiting since candle lighting.
              </Text>
              <View style={ui.row}>
                <Button
                  label={saving ? 'Recording…' : 'All given as scheduled'}
                  variant="primary"
                  disabled={saving}
                  onPress={() =>
                    void submit(
                      items.map((item) => buildEntry(item, defaultRowState(item, timeZone))),
                    )
                  }
                />
                {onDone ? <Button label="Later" disabled={saving} onPress={onDone} /> : null}
              </View>
            </>
          )}
          {error ? <Text style={ui.errorText}>{error}</Text> : null}
        </Card>

        {items.length > 0 ? (
          <Card>
            <Text style={{ color: colors.text, fontWeight: '600' }}>
              Or answer them one at a time
            </Text>

            {items.map((item) => {
              const state = rowFor(item);
              return (
                <View key={item.key} style={{ gap: 6 }}>
                  <Text style={{ color: colors.text, fontWeight: '600' }}>{item.medicineName}</Text>
                  <Text style={ui.subtitle}>
                    Due {formatLocalDate(timeZone, fromIso(item.occurrence.dueAt))} ·{' '}
                    {item.occurrence.scheduledLocalTime} · {item.occurrence.dosageQuantity}
                  </Text>

                  <View style={ui.row}>
                    <Button
                      label="Given"
                      variant={state.answer === 'given' ? 'primary' : 'default'}
                      onPress={() => setRow(item, { answer: 'given' })}
                    />
                    <Button
                      label="Not given"
                      variant={state.answer === 'not_given' ? 'primary' : 'default'}
                      onPress={() => setRow(item, { answer: 'not_given' })}
                    />
                  </View>

                  {state.answer === 'given' ? (
                    <View style={ui.row}>
                      <View style={{ flex: 1 }}>
                        <Text style={ui.label}>Time given</Text>
                        <TextInput
                          style={ui.input}
                          value={state.time}
                          onChangeText={(text) => setRow(item, { time: text })}
                          accessibilityLabel={`Time given — ${item.medicineName}`}
                        />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={ui.label}>Quantity</Text>
                        <TextInput
                          style={ui.input}
                          keyboardType="numeric"
                          value={state.quantity}
                          onChangeText={(text) => setRow(item, { quantity: text })}
                          accessibilityLabel={`Quantity — ${item.medicineName}`}
                        />
                      </View>
                    </View>
                  ) : null}
                </View>
              );
            })}

            <Button
              label={saving ? 'Recording…' : 'Record these answers'}
              variant="primary"
              disabled={saving}
              onPress={() => void submit(items.map((item) => buildEntry(item, rowFor(item))))}
            />
          </Card>
        ) : null}

        <RetroactivePrn
          timeZone={timeZone}
          medicines={prnMedicines}
          logs={data.logs}
          nowMs={nowMs}
        />
      </ScrollView>
    </KeyboardAvoidingScreen>
  );
}

/**
 * An as-needed dose given during Shabbat, entered afterwards.
 *
 * The guard is assessed as of the instant the dose was given (`clockAt`), which is both the honest
 * question and exactly what the Durable Object re-checks on push. When it binds, the dose is still
 * recorded — it happened — but only with a written reason (safety invariant 5).
 */
function RetroactivePrn({
  timeZone,
  medicines,
  logs,
  nowMs,
}: {
  timeZone: string;
  medicines: readonly Medicine[];
  logs: readonly IntakeLog[];
  nowMs: number;
}): React.JSX.Element | null {
  const repository = useRepository();
  const ids = useIdGenerator();
  const userId = useCurrentUserId();
  const deviceId = useCurrentDeviceId();

  const [medicineId, setMedicineId] = useState('');
  const [date, setDate] = useState(formatLocalDate(timeZone, nowMs));
  const [time, setTime] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [reason, setReason] = useState('');
  const [blockedBy, setBlockedBy] = useState<BlockReason | null>(null);
  const [saving, setSaving] = useState(false);
  const [recorded, setRecorded] = useState<string | null>(null);

  if (medicines.length === 0) {
    return null;
  }

  const record = async (override?: { reason: string; blockedBy: BlockReason }) => {
    const medicine = medicines.find((candidate) => candidate.id === medicineId);
    if (!medicine || !time) {
      return;
    }

    const givenAtMs = resolveLocal(timeZone, date, time).instantMs;

    if (!override) {
      const safety = assessDose({
        medicine,
        patientId: SINGLE_PATIENT_ID,
        logs,
        clock: clockAt(givenAtMs),
        clockTrust: getLocalClockTrust(),
      });
      const blocked = blockReasonFor(safety);
      if (blocked) {
        setBlockedBy(blocked);
        return;
      }
    }

    setSaving(true);
    try {
      await repository.recordDose({
        id: ids.next(),
        patientId: SINGLE_PATIENT_ID,
        medicineId: medicine.id,
        type: 'prn',
        status: 'taken',
        actualTime: toIso(givenAtMs),
        quantityTaken: Number(quantity),
        loggedByUserId: userId,
        loggedByDeviceId: deviceId,
        syncStatus: 'pending',
        ...(override
          ? {
              override: {
                confirmedByUserId: userId,
                reason: override.reason,
                blockedBy: override.blockedBy,
              },
            }
          : {}),
      });
      setRecorded(`${medicine.name} at ${time}`);
      setMedicineId('');
      setTime('');
      setQuantity('1');
      setReason('');
      setBlockedBy(null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <Text style={{ color: colors.text, fontWeight: '600' }}>
        Something given as needed during Shabbat?
      </Text>
      <Text style={ui.subtitle}>
        As-needed doses have no scheduled time to confirm, so they are entered here rather than
        listed above.
      </Text>

      <View style={{ gap: 6 }}>
        {medicines.map((medicine) => (
          <Button
            key={medicine.id}
            label={`${medicine.name} ${medicine.strength}`}
            variant={medicineId === medicine.id ? 'primary' : 'default'}
            onPress={() => {
              setMedicineId(medicine.id);
              setBlockedBy(null);
            }}
          />
        ))}
      </View>

      <View>
        <Text style={ui.label}>Date given</Text>
        <TextInput
          style={ui.input}
          value={date}
          onChangeText={setDate}
          accessibilityLabel="Date given"
        />
      </View>

      <View style={ui.row}>
        <View style={{ flex: 1 }}>
          <Text style={ui.label}>Time given</Text>
          <TextInput
            style={ui.input}
            value={time}
            onChangeText={(text) => {
              setTime(text);
              setBlockedBy(null);
            }}
            accessibilityLabel="Time given as needed"
          />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={ui.label}>Quantity</Text>
          <TextInput
            style={ui.input}
            keyboardType="numeric"
            value={quantity}
            onChangeText={setQuantity}
            accessibilityLabel="Quantity given as needed"
          />
        </View>
      </View>

      {blockedBy ? (
        <View style={{ gap: 6 }}>
          <Text style={ui.subtitle}>
            At that time this dose was inside the safety limit for this medicine. It still
            happened, so it still gets recorded — say why, and the reason is kept with it.
          </Text>
          <TextInput
            style={ui.input}
            value={reason}
            onChangeText={setReason}
            accessibilityLabel="Why this dose was given"
          />
          <Button
            label="Record it with this reason"
            variant="primary"
            disabled={saving || reason.trim().length === 0}
            onPress={() => void record({ reason: reason.trim(), blockedBy })}
          />
        </View>
      ) : (
        <Button
          label={saving ? 'Recording…' : 'Record this dose'}
          disabled={saving || !medicineId || !time}
          onPress={() => void record()}
        />
      )}

      {recorded ? <Text style={{ color: colors.safe }}>Recorded: {recorded}</Text> : null}
    </Card>
  );
}
