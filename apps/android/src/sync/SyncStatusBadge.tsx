import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Badge, colors } from '../ui/primitives.js';
import type { BadgeTone } from '../ui/primitives.js';
import { useSyncStatus } from './SyncProvider.js';
import type { SyncIndicatorStatus } from './SyncProvider.js';

/**
 * Always visible when this device belongs to a household — safety invariant 6, the sync state a
 * caregiver depends on to trust that another caregiver will actually see a dose they just logged
 * must never just quietly disappear. Android equivalent of `apps/web/src/sync/SyncStatusBadge.tsx`.
 */
export function SyncStatusBadge(): React.JSX.Element | null {
  const { status, syncNow } = useSyncStatus();

  if (status.kind === 'disconnected') {
    return null;
  }

  const { label, tone } = describe(status);
  // Tapping runs a sync now — the way out of "Sync failed" without restarting the app. Inert
  // while a round is already in progress or scheduled, and once the device has been removed
  // (every attempt would fail the same way; the revoked banner is the caregiver's way forward).
  const tappable = status.kind !== 'syncing' && status.kind !== 'retrying' && status.kind !== 'revoked';

  return (
    <View style={styles.wrapper}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Sync now"
        accessibilityHint={status.kind === 'error' ? status.message : undefined}
        accessibilityState={{ disabled: !tappable }}
        disabled={!tappable}
        onPress={() => {
          void syncNow();
        }}
      >
        <Badge tone={tone}>{label}</Badge>
      </Pressable>
      {status.kind === 'error' ? (
        <Text style={styles.reason} numberOfLines={2}>
          {status.message}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { alignItems: 'center' },
  reason: { color: colors.textMuted, fontSize: 11, marginTop: 2, textAlign: 'center' },
});

function describe(status: Exclude<SyncIndicatorStatus, { kind: 'disconnected' }>): {
  label: string;
  tone: BadgeTone;
} {
  switch (status.kind) {
    case 'syncing':
      return { label: 'Syncing…', tone: 'neutral' };
    case 'retrying':
      return { label: `Retrying (${status.attempt}/${status.max})…`, tone: 'neutral' };
    case 'synced':
      return { label: 'Synced', tone: 'safe' };
    case 'pending':
      return { label: `Pending (${status.count})`, tone: 'capped' };
    case 'offline':
      return { label: 'Offline', tone: 'neutral' };
    case 'error':
      return { label: 'Sync failed · tap to retry', tone: 'locked' };
    case 'revoked':
      return { label: 'Removed', tone: 'locked' };
  }
}
