import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { formatLocalDate, formatLocalTime, fromIso, resolveLocal, toIso } from '@medguard/shared';
import type { IntakeLog, IntakeStatus } from '@medguard/shared';
import { useCurrentDeviceId, useCurrentUserId, useIdGenerator, useRepository } from '../../app/RepositoryContext.js';
import { Button, colors, styles as ui } from '../../ui/primitives.js';

const CORRECTABLE_STATUSES: IntakeStatus[] = ['taken', 'skipped'];

/**
 * RN port of `apps/web/src/features/logs/DoseCorrection.tsx`. Reused verbatim (same props) by
 * both `TodayView` and (the PRN screen, built separately) — corrections are never edits (safety
 * invariant 1): a new log is appended with `supersedesId` pointing at the one it replaces, so the
 * original stays visible in history.
 */
function correctionChain(allLogs: readonly IntakeLog[], tipId: string): IntakeLog[] {
  const byId = new Map(allLogs.map((log) => [log.id, log]));
  const chain: IntakeLog[] = [];
  let current = byId.get(tipId);
  while (current) {
    chain.push(current);
    current = current.supersedesId !== undefined ? byId.get(current.supersedesId) : undefined;
  }
  return chain.reverse();
}

function CorrectionForm({
  original,
  timeZone,
  onDone,
  onCancel,
}: {
  original: IntakeLog;
  timeZone: string;
  onDone: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const repository = useRepository();
  const ids = useIdGenerator();
  const userId = useCurrentUserId();
  const deviceId = useCurrentDeviceId();

  const originalMs = fromIso(original.actualTime);
  const [status, setStatus] = useState<IntakeStatus>(original.status);
  const [quantity, setQuantity] = useState(String(original.quantityTaken));
  const [date, setDate] = useState(formatLocalDate(timeZone, originalMs));
  const [time, setTime] = useState(formatLocalTime(timeZone, originalMs));
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    setError(null);

    const quantityValue = status === 'skipped' ? 0 : Number(quantity);
    if (!(quantityValue >= 0)) {
      setError('Quantity must be zero or more.');
      return;
    }
    const trimmedNote = note.trim();
    if (!trimmedNote) {
      setError("Say what was wrong — it's recorded permanently alongside the correction.");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setError('Date must be in YYYY-MM-DD form.');
      return;
    }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      setError('Time must be in HH:MM form.');
      return;
    }

    const resolved = resolveLocal(timeZone, date, time);

    setSaving(true);
    try {
      await repository.correctDose(original.id, {
        id: ids.next(),
        patientId: original.patientId,
        medicineId: original.medicineId,
        ...(original.scheduleId !== undefined ? { scheduleId: original.scheduleId } : {}),
        type: original.type,
        status,
        ...(original.scheduledTime !== undefined ? { scheduledTime: original.scheduledTime } : {}),
        actualTime: toIso(resolved.instantMs),
        quantityTaken: quantityValue,
        loggedByUserId: userId,
        loggedByDeviceId: deviceId,
        notes: trimmedNote,
        syncStatus: 'pending',
      });
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={{ gap: 8, borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 10 }}>
      <View style={ui.row}>
        {CORRECTABLE_STATUSES.map((option) => (
          <Pressable key={option} onPress={() => setStatus(option)} disabled={saving}>
            <Text
              style={{
                fontSize: 13,
                fontWeight: '600',
                color: status === option ? colors.primary : colors.textMuted,
              }}
            >
              {option === 'taken' ? 'Taken' : 'Skipped'}
            </Text>
          </Pressable>
        ))}
      </View>
      <View>
        <Text style={ui.label}>Quantity</Text>
        <TextInput
          style={ui.input}
          keyboardType="numeric"
          value={quantity}
          editable={status !== 'skipped' && !saving}
          onChangeText={setQuantity}
        />
      </View>
      <View style={ui.row}>
        <View style={{ flex: 1 }}>
          <Text style={ui.label}>Date (YYYY-MM-DD)</Text>
          <TextInput style={ui.input} value={date} editable={!saving} onChangeText={setDate} placeholder="2026-06-15" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={ui.label}>Time (HH:MM)</Text>
          <TextInput style={ui.input} value={time} editable={!saving} onChangeText={setTime} placeholder="08:00" />
        </View>
      </View>
      <View>
        <Text style={ui.label}>What was wrong?</Text>
        <TextInput
          style={[ui.input, { minHeight: 60 }]}
          multiline
          value={note}
          editable={!saving}
          onChangeText={setNote}
        />
      </View>
      {error ? (
        <Text style={ui.errorText} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      <View style={ui.row}>
        <Button label={saving ? 'Saving…' : 'Save correction'} onPress={() => void handleSubmit()} disabled={saving} variant="primary" />
        <Button label="Cancel" onPress={onCancel} disabled={saving} />
      </View>
    </View>
  );
}

/**
 * Lets a caregiver correct a mistaken log entry (never edits it — appends a superseding one) and
 * view the full history of what changed.
 */
export function DoseCorrection({
  allLogs,
  tipLog,
  timeZone,
}: {
  /** Every log for this medicine (or patient), so the full supersede chain can be found. */
  allLogs: readonly IntakeLog[];
  tipLog: IntakeLog;
  timeZone: string;
}): React.JSX.Element {
  const [correcting, setCorrecting] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const chain = correctionChain(allLogs, tipLog.id);
  const hasHistory = chain.length > 1;

  if (correcting) {
    return (
      <CorrectionForm
        original={tipLog}
        timeZone={timeZone}
        onDone={() => setCorrecting(false)}
        onCancel={() => setCorrecting(false)}
      />
    );
  }

  return (
    <View style={{ gap: 4 }}>
      <View style={[ui.row, { gap: 12 }]}>
        <Pressable onPress={() => setCorrecting(true)}>
          <Text style={{ fontSize: 12, color: colors.textMuted, textDecorationLine: 'underline' }}>Correct</Text>
        </Pressable>
        {hasHistory ? (
          <Pressable onPress={() => setShowHistory((current) => !current)}>
            <Text style={{ fontSize: 12, color: colors.textMuted, textDecorationLine: 'underline' }}>
              {showHistory ? 'Hide history' : `History (${chain.length})`}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {showHistory ? (
        <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 8, gap: 4 }}>
          {chain.map((log) => (
            <Text key={log.id} style={{ fontSize: 12, color: colors.textMuted }}>
              {formatLocalDate(timeZone, fromIso(log.actualTime))} {formatLocalTime(timeZone, fromIso(log.actualTime))} —{' '}
              {log.status === 'taken' ? `Taken (${log.quantityTaken})` : 'Skipped'} by {log.loggedByUserId}
              {log.notes ? ` — ${log.notes}` : ''}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}
