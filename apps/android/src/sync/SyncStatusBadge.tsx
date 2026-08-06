import { Badge } from '../ui/primitives.js';
import type { BadgeTone } from '../ui/primitives.js';
import { useSyncStatus } from './SyncProvider.js';
import type { SyncIndicatorStatus } from './SyncProvider.js';

/**
 * Always visible when this device belongs to a household — safety invariant 6, the sync state a
 * caregiver depends on to trust that another caregiver will actually see a dose they just logged
 * must never just quietly disappear. Android equivalent of `apps/web/src/sync/SyncStatusBadge.tsx`.
 */
export function SyncStatusBadge(): React.JSX.Element | null {
  const { status } = useSyncStatus();

  if (status.kind === 'disconnected') {
    return null;
  }

  const { label, tone } = describe(status);
  return <Badge tone={tone}>{label}</Badge>;
}

function describe(status: Exclude<SyncIndicatorStatus, { kind: 'disconnected' }>): {
  label: string;
  tone: BadgeTone;
} {
  switch (status.kind) {
    case 'syncing':
      return { label: 'Syncing…', tone: 'neutral' };
    case 'synced':
      return { label: 'Synced', tone: 'safe' };
    case 'pending':
      return { label: `Pending (${status.count})`, tone: 'capped' };
    case 'offline':
      return { label: 'Offline', tone: 'neutral' };
    case 'error':
      return { label: 'Sync error', tone: 'locked' };
  }
}
