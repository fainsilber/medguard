import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import {
  assessDose,
  blockReasonFor,
  formatCountdown,
  formatLocalTime,
  fromIso,
  isDosePermitted,
  lastAdministeredDose,
} from '@medguard/shared';
import type { BlockReason, ClockTrust, DoseSafety, IntakeLog, Medicine } from '@medguard/shared';
import {
  useClock,
  useCurrentDeviceId,
  useCurrentUserId,
  useIdGenerator,
  useRepository,
} from '../../app/RepositoryContext.js';
import { getLocalClockTrust } from '../../clock/localClockGuard.js';
import { DoseCorrection } from '../logs/DoseCorrection.js';
import { Badge, Button, Card, colors, styles as sharedStyles } from '../../ui/primitives.js';
import type { BadgeTone } from '../../ui/primitives.js';

/**
 * RN port of `apps/web/src/features/prnDoses/PrnCard.tsx`. Behavior is a direct port — see that
 * file for the full rationale on the two-step override flow, including `<DoseCorrection>` under
 * the "last given" line, exactly as web does.
 */

const STATE_BORDER_COLOR: Record<DoseSafety['state'], string> = {
  safe: colors.safe,
  cooldown: colors.locked,
  capped: colors.capped,
  untrusted_clock: colors.locked,
};

const STATE_BADGE_TONE: Record<DoseSafety['state'], BadgeTone> = {
  safe: 'safe',
  cooldown: 'locked',
  capped: 'capped',
  untrusted_clock: 'locked',
};

const STATE_LABEL: Record<DoseSafety['state'], string> = {
  safe: 'Safe to take',
  cooldown: 'Locked',
  capped: 'Daily limit reached',
  untrusted_clock: 'Clock unverified',
};

/**
 * Override needs two *deliberate, separate* confirmations before it writes anything — a reason
 * (required, becomes part of the permanent audit record) and then an explicit "yes, really" a
 * moment later. Neither step alone can trigger a dose: this exists so a caregiver can't mis-tap
 * their way past a cooldown at 3am.
 */
type OverridePhase = 'closed' | 'reason' | 'confirm';

export function PrnCard({
  medicine,
  logs,
  timeZone,
  clockTrust,
}: {
  medicine: Medicine;
  logs: readonly IntakeLog[];
  timeZone: string;
  /** Overrides the real local clock-trust check — exists for deterministic tests only. */
  clockTrust?: ClockTrust;
}): React.JSX.Element {
  const clock = useClock();
  const repository = useRepository();
  const ids = useIdGenerator();
  const userId = useCurrentUserId();
  const deviceId = useCurrentDeviceId();

  const [overridePhase, setOverridePhase] = useState<OverridePhase>('closed');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const safety = assessDose({
    medicine,
    logs,
    clock,
    clockTrust: clockTrust ?? getLocalClockTrust(),
  });

  const resetOverride = () => {
    setOverridePhase('closed');
    setReason('');
  };

  const give = async (override?: { reason: string; blockedBy: BlockReason }) => {
    setSaving(true);
    try {
      await repository.recordDose({
        id: ids.next(),
        patientId: medicine.patientId,
        medicineId: medicine.id,
        type: 'prn',
        status: 'taken',
        actualTime: clock.nowIso(),
        quantityTaken: 1,
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
      resetOverride();
    } finally {
      setSaving(false);
    }
  };

  const handleGive = () => void give();

  const handleReasonContinue = () => {
    if (!reason.trim()) return;
    setOverridePhase('confirm');
  };

  const handleConfirmOverride = () => {
    const blockedBy = blockReasonFor(safety);
    if (!blockedBy) return; // unreachable: this button only renders when safety is blocked
    void give({ reason: reason.trim(), blockedBy });
  };

  const permitted = isDosePermitted(safety);
  const lastLog = lastAdministeredDose(logs, medicine.id);

  return (
    <Card style={{ borderLeftWidth: 4, borderLeftColor: STATE_BORDER_COLOR[safety.state] }}>
      <View style={cardStyles.headerRow}>
        <Text style={cardStyles.title}>
          {medicine.name} <Text style={cardStyles.strength}>{medicine.strength}</Text>
        </Text>
        <Badge tone={STATE_BADGE_TONE[safety.state]}>{STATE_LABEL[safety.state]}</Badge>
      </View>

      {lastLog && (
        <>
          <Text style={cardStyles.muted}>
            Last given by {lastLog.loggedByUserId} at {formatLocalTime(timeZone, fromIso(lastLog.actualTime))} (
            {lastLog.quantityTaken})
          </Text>
          <DoseCorrection allLogs={logs} tipLog={lastLog} timeZone={timeZone} />
        </>
      )}

      {safety.state === 'cooldown' && (
        <Text style={cardStyles.lockedText}>Locked: {formatCountdown(safety.msRemaining)} remaining</Text>
      )}
      {safety.state === 'capped' && (
        <Text style={cardStyles.muted}>
          Daily limit reached ({safety.dosesInWindow}/{safety.maxDailyDoses} doses in 24h). Resets in{' '}
          {formatCountdown(safety.msRemaining)}.
        </Text>
      )}
      {safety.state === 'untrusted_clock' && (
        <Text style={cardStyles.lockedText}>
          This device's clock could not be verified, so the cooldown can't be confirmed safely. Try again in a
          moment.
        </Text>
      )}

      {permitted && (
        <Button
          label={saving ? 'Recording…' : 'Give dose'}
          variant="primary"
          disabled={saving}
          onPress={handleGive}
        />
      )}

      {!permitted && overridePhase === 'closed' && (
        <Button label="Give anyway (override)" onPress={() => setOverridePhase('reason')} />
      )}

      {!permitted && overridePhase === 'reason' && (
        <View style={cardStyles.overridePanel}>
          <Text style={sharedStyles.label}>Why are you overriding this?</Text>
          <TextInput
            style={[sharedStyles.input, cardStyles.reasonInput]}
            multiline
            numberOfLines={2}
            value={reason}
            onChangeText={setReason}
            placeholder="Reason for giving this dose anyway"
            placeholderTextColor={colors.textMuted}
            accessibilityLabel="Why are you overriding this?"
            autoFocus
          />
          <View style={sharedStyles.row}>
            <Button label="Continue" variant="danger" disabled={!reason.trim()} onPress={handleReasonContinue} />
            <Button label="Cancel" onPress={resetOverride} />
          </View>
        </View>
      )}

      {!permitted && overridePhase === 'confirm' && (
        <View style={[cardStyles.overridePanel, cardStyles.confirmPanel]}>
          <Text style={cardStyles.confirmText} accessibilityRole="alert">
            Are you sure? This will be permanently recorded as an override.
          </Text>
          <View style={sharedStyles.row}>
            <Button
              label={saving ? 'Recording…' : 'Yes, give the dose'}
              variant="danger"
              disabled={saving}
              onPress={handleConfirmOverride}
            />
            <Button label="Cancel" disabled={saving} onPress={resetOverride} />
          </View>
        </View>
      )}
    </Card>
  );
}

const cardStyles = StyleSheet.create({
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  title: { fontSize: 16, fontWeight: '600', color: colors.text },
  strength: { fontWeight: '400', color: colors.textMuted },
  muted: { fontSize: 12, color: colors.textMuted },
  lockedText: { fontSize: 13, color: colors.locked },
  overridePanel: {
    gap: 8,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.locked,
    padding: 10,
  },
  confirmPanel: { borderWidth: 1 },
  reasonInput: { minHeight: 60, textAlignVertical: 'top' },
  confirmText: { fontSize: 13, fontWeight: '600', color: colors.locked },
});
