import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { BlockReason, Medicine } from '@medguard/shared';
import { useRepository } from '../app/RepositoryContext.js';
import { colors } from '../ui/primitives.js';
import { useSyncStatus } from './SyncProvider.js';

/**
 * Surfaces an incoming `safety.warning` broadcast to every caregiver in the household, not just
 * the one whose device attempted the dose — the whole point of delta D2's authoritative re-check
 * is that a race between two phones is visible to both, immediately. Android equivalent of
 * `apps/web/src/sync/SafetyWarningBanner.tsx`, reading the medicine through the repository
 * instead of a raw Dexie query.
 *
 * Deliberately *not* `useLiveQuery` here, unlike almost everywhere else in this app. Web's version
 * refetches on `[db, lastSafetyWarning]` — `dexie-react-hooks`' `useLiveQuery` takes an explicit
 * dependency array and reruns whenever it changes. `store/useLiveQuery.ts` has no such parameter:
 * it only reruns when a transaction *writes* one of `watchTables`, which `lastSafetyWarning`
 * becoming non-null is not. Wired that way, this banner would show its `'A medicine'` fallback
 * essentially always — the fetch's very first run happens at mount, while `lastSafetyWarning` is
 * still null, and nothing about a warning arriving later touches the `medicines` table itself. A
 * plain effect keyed on `lastSafetyWarning` is what web's dependency array actually needs here.
 */

const REASON_LABEL: Record<BlockReason, string> = {
  cooldown: 'the minimum time between doses',
  daily_cap: "today's dose limit",
  untrusted_clock: 'an unverified clock',
};

export function SafetyWarningBanner(): React.JSX.Element | null {
  const repository = useRepository();
  const { lastSafetyWarning, dismissSafetyWarning } = useSyncStatus();
  const [medicine, setMedicine] = useState<Medicine | undefined>(undefined);

  useEffect(() => {
    if (!lastSafetyWarning) {
      setMedicine(undefined);
      return;
    }
    let cancelled = false;
    void repository.getMedicine(lastSafetyWarning.medicineId).then((result) => {
      if (!cancelled) {
        setMedicine(result);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [repository, lastSafetyWarning]);

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
