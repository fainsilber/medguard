import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Button, colors } from '../ui/primitives.js';
import { useSyncStatus } from './SyncProvider.js';

/**
 * Shown when this device's own token has been revoked — someone (possibly on another device)
 * removed it from the household via `HouseholdScreen`'s device list. Sync has already stopped
 * (`SyncStatusBadge` shows "Removed"); this banner is what tells the caregiver holding this
 * specific phone *why*, and gives them a deliberate, two-step way to clear the medical data still
 * sitting on it — never automatic, since a caregiver's dosing history disappearing without a
 * confirmed action is its own kind of harm, worth exactly as much care as `PrnCard`'s override
 * flow gives an unsafe dose.
 */
export function RevokedDeviceBanner(): React.JSX.Element | null {
  const { status, clearRevokedDevice } = useSyncStatus();
  const [confirming, setConfirming] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [clearing, setClearing] = useState(false);

  if (status.kind !== 'revoked' || dismissed) {
    return null;
  }

  const handleConfirmClear = async () => {
    setClearing(true);
    await clearRevokedDevice();
    // No further state update needed on success: clearing the session flips `status` back to
    // `'disconnected'` via `SyncProvider`'s own session-change effect, which unmounts this banner.
  };

  return (
    <View style={styles.banner} accessibilityRole="alert">
      <Text style={styles.text}>
        This device was removed from the household and will no longer sync. Any medicines, doses
        or logs already on this device are still here until you clear them.
      </Text>

      {!confirming ? (
        <View style={styles.row}>
          <Button label="Clear local data" variant="danger" onPress={() => setConfirming(true)} />
          <Button label="Not now" onPress={() => setDismissed(true)} />
        </View>
      ) : (
        <View style={styles.row}>
          <Button
            label={clearing ? 'Clearing…' : 'Yes, clear it'}
            variant="danger"
            disabled={clearing}
            onPress={() => void handleConfirmClear()}
          />
          <Button label="Cancel" disabled={clearing} onPress={() => setConfirming(false)} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    gap: 10,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.locked,
    backgroundColor: 'rgba(248, 113, 113, 0.1)',
    padding: 12,
  },
  text: { fontSize: 13, color: colors.text },
  row: { flexDirection: 'row', gap: 8 },
});
