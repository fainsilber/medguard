import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import { isClockTrusted } from '@medguard/shared';
import {
  useCurrentDeviceId,
  useCurrentUserId,
  useMedGuardDb,
} from '../../app/AndroidAppProvider.js';
import { useClockTrust } from '../../app/useClockTrust.js';
import { useHouseholdSettings } from '../../app/useHouseholdSettings.js';
import { describeCapabilities, getDeviceInfo } from '../../native/androidBridge.js';
import { M3Badge, M3Card, m3ButtonPrimary, m3InputClass } from '../../ui/MaterialComponents.js';

export function AndroidSettingsScreen({
  onChangeCaregiver,
}: {
  onChangeCaregiver: (name: string) => void;
}) {
  const db = useMedGuardDb();
  const userId = useCurrentUserId();
  const deviceId = useCurrentDeviceId();
  const clockTrust = useClockTrust();
  const household = useHouseholdSettings();

  const [draftName, setDraftName] = useState(userId);

  const deviceInfo = useMemo(() => getDeviceInfo(deviceId), [deviceId]);
  const capabilities = useMemo(() => describeCapabilities(deviceInfo), [deviceInfo]);
  const pendingCount = useLiveQuery(() => db.syncOutbox.count(), [db]);

  const trusted = isClockTrusted(clockTrust);

  return (
    <div className="flex flex-col gap-4 p-4 pb-28">
      <div className="flex flex-col">
        <h2 className="text-xl font-bold tracking-tight text-slate-100">Device &amp; household</h2>
        <p className="text-xs text-slate-400">
          Caregiver identity, what this build can actually do, and clock verification.
        </p>
      </div>

      <M3Card>
        <h3 className="text-sm font-bold text-slate-100">Caregiver identity</h3>
        <p className="text-xs text-slate-400">
          Attached to every dose and override this device records.
        </p>
        <label htmlFor="caregiver-name" className="sr-only">
          Caregiver name
        </label>
        <input
          id="caregiver-name"
          type="text"
          className={m3InputClass}
          value={draftName}
          onChange={(event) => setDraftName(event.target.value)}
        />
        <button
          onClick={() => onChangeCaregiver(draftName)}
          disabled={!draftName.trim() || draftName.trim() === userId}
          className={m3ButtonPrimary}
        >
          Save name
        </button>
      </M3Card>

      {/*
        The honest capability report. An earlier revision of this screen showed a hard-coded
        "FCM Active" badge and a synthetic push token; a caregiver relying on that to be woken at
        3am would have been relying on nothing. Safety invariant 6: degradation is visible.
      */}
      <M3Card>
        <h3 className="text-sm font-bold text-slate-100">Alerting</h3>
        <div className="flex flex-col gap-2 text-xs text-slate-300">
          <div className="flex items-center justify-between gap-3">
            <span>Running as</span>
            <M3Badge tone={capabilities.platform === 'android' ? 'safe' : 'neutral'}>
              {capabilities.platform === 'android' ? 'Android app' : 'Browser'}
            </M3Badge>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span>Push registration</span>
            <M3Badge tone={capabilities.pushRegistered ? 'safe' : 'locked'}>
              {capabilities.pushRegistered ? 'Registered' : 'Not registered'}
            </M3Badge>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span>Notification channels</span>
            <M3Badge tone={capabilities.channelsCreated ? 'safe' : 'locked'}>
              {capabilities.channelsCreated ? 'Created' : 'Not created'}
            </M3Badge>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span>Chime</span>
            <M3Badge tone={capabilities.chime === 'unavailable' ? 'locked' : 'capped'}>
              {capabilities.chime === 'unavailable' ? 'Unavailable' : 'Foreground only'}
            </M3Badge>
          </div>
          <p className="text-slate-400">
            This build cannot wake a locked phone. Dose alarms, escalation and the 45-second Shabbat
            chime need the native alarm layer described in docs/android-client-plan.md.
          </p>
        </div>
      </M3Card>

      <M3Card>
        <h3 className="text-sm font-bold text-slate-100">Sync</h3>
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-slate-300">
            {pendingCount ?? 0} local change{pendingCount === 1 ? '' : 's'} queued
          </span>
          <M3Badge tone="capped">Upload not wired</M3Badge>
        </div>
        <p className="text-xs text-slate-400">
          Changes are recorded locally and queued in order. This client has no API connection yet,
          so nothing has been sent to other caregivers&rsquo; devices.
        </p>
      </M3Card>

      <M3Card>
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-col">
            <span className="text-sm font-bold text-slate-100">Clock verification</span>
            <span className="text-xs text-slate-400">
              {trusted
                ? 'No drift detected since this session started.'
                : 'This clock changed mid-session — guarded medicines stay blocked.'}
            </span>
          </div>
          <M3Badge tone={trusted ? 'safe' : 'locked'}>
            {trusted ? 'Trusted' : 'Skew detected'}
          </M3Badge>
        </div>
        <p className="text-xs text-slate-400">
          Local check only: a clock that was already wrong before the app started cannot be detected
          without the server check.
        </p>
      </M3Card>

      <M3Card>
        <h3 className="text-sm font-bold text-slate-100">Household</h3>
        <div className="flex flex-col gap-1 font-mono text-xs text-slate-300">
          <div>
            Timezone: <span className="text-sky-400">{household?.timeZone ?? '—'}</span>
          </div>
          <div>
            Device: <span className="text-slate-400">{deviceInfo.deviceId}</span>
          </div>
        </div>
      </M3Card>
    </div>
  );
}
