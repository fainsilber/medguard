import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { BlockReason } from '@medguard/shared';
import { useRepository } from '../app/RepositoryContext.js';
import { useLiveQuery } from '../store/useLiveQuery.js';
import { colors } from '../ui/primitives.js';
import { useSyncStatus } from './SyncProvider.js';

/**
 * Surfaces an incoming `safety.warning` broadcast to every caregiver in the household, not just
 * the one whose device attempted the dose — the whole point of delta D2's authoritative re-check
 * is that a race between two phones is visible to both, immediately. Android equivalent of
 * `apps/web/src/sync/SafetyWarningBanner.tsx`, reading the medicine through the repository
 * instead of a raw Dexie query.
 */

const REASON_LABEL: Record<BlockReason, string> = {
  cooldown: 'the minimum time between doses',
  daily_cap: "today's dose limit",
  untrusted_clock: 'an unverified clock',
};

export function SafetyWarningBanner(): React.JSX.Element | null {
  const repository = useRepository();
  const { lastSafetyWarning, dismissSafetyWarning } = useSyncStatus();

  const medicine = useLiveQuery(
    () => (lastSafetyWarning ? repository.getMedicine(lastSafetyWarning.medicineId) : Promise.resolve(undefined)),
    ['medicines'],
  );

  if (!lastSafetyWarning) {
    return null;
  }

  const medicineName = medicine?.name ?? 'A medicine';
  const reason = REASON_LABEL[lastSafetyWarning.blockedBy];

  return (
    <View style={styles.banner} accessibilityRole="alert">
      <Text style={styles.text}>
        {medicineName}:{' '}
        {lastSafetyWarning.outcome === 'blocked'
          ? `a dose was blocked by ${reason} — someone may have just tried to give it again too soon.`
          : `a dose was given despite ${reason}, recorded as an override.`}
      </Text>
      <Pressable onPress={dismissSafetyWarning} accessibilityRole="button">
        <Text style={styles.dismiss}>Dismiss</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.locked,
    backgroundColor: 'rgba(248, 113, 113, 0.1)',
    padding: 12,
  },
  text: { flex: 1, fontSize: 13, color: colors.text },
  dismiss: { color: colors.textMuted, textDecorationLine: 'underline', fontSize: 13 },
});
