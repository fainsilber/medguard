import { useCallback, useEffect, useState } from 'react';
import { getApiBaseUrl } from '../../api/config.js';
import {
  deleteHousehold,
  issueJoinCode,
  leaveHousehold,
  listDevices,
  revokeDevice,
} from '../../api/householdApi.js';
import type { DeviceInfo } from '../../api/householdApi.js';
import { clearHouseholdSession, getHouseholdSession } from '../../api/session.js';
import type { HouseholdSession } from '../../api/session.js';
import { useRepository } from '../../app/RepositoryContext.js';
import { getCaregiverName } from '../../identity/caregiverName.js';
import {
  Card,
  buttonClass,
  dangerButtonClass,
  inputClass,
  labelClass,
  primaryButtonClass,
} from '../../ui/primitives.js';
import { HouseholdOnboarding } from './HouseholdOnboarding.js';
import { PatientRosterCard } from './PatientRosterCard.js';

const DELETE_CONFIRMATION_PHRASE = 'DELETE';

/**
 * The household screen: who this device is connected to, who else is, and how to disconnect —
 * by leaving, by revoking a specific device, or by deleting the household outright.
 *
 * Nothing here needs a page reload. Session state lives in this component rather than being
 * re-read from storage on remount, so leaving or joining a different household updates the screen
 * immediately.
 */
export function HouseholdScreen() {
  const repository = useRepository();
  const [session, setSession] = useState<HouseholdSession | null>(getHouseholdSession);

  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [inviteExpiresInSeconds, setInviteExpiresInSeconds] = useState<number | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  const [leaving, setLeaving] = useState(false);
  const [leaveBusy, setLeaveBusy] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);

  const [deleting, setDeleting] = useState(false);
  const [deleteText, setDeleteText] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const refreshDevices = useCallback(async () => {
    if (!session) return;
    const result = await listDevices(getApiBaseUrl(), session.deviceToken);
    if (result.ok) {
      setDevices(result.value.devices);
      setDevicesError(null);
    } else {
      setDevicesError(result.error);
    }
  }, [session]);

  useEffect(() => {
    void refreshDevices();
  }, [refreshDevices]);

  /**
   * Wipes local medical data and forgets the session. Local data is *not* scoped per household
   * (there is one IndexedDB, not one per household id) — without this, medicines and logs from
   * the household just left would sit there and could bleed into whichever household is joined
   * next once real sync exists. Household settings and this device's caregiver name are left
   * alone: this disconnects a household, it does not reset the device's own identity.
   */
  const disconnectLocally = async () => {
    await repository.clearAllData();
    clearHouseholdSession();
    setSession(null);
    setDevices(null);
    setInviteCode(null);
  };

  const handleLeave = async () => {
    if (!session) return;
    setLeaveBusy(true);
    setLeaveError(null);

    const result = await leaveHousehold(getApiBaseUrl(), session.deviceToken);
    if (!result.ok) {
      setLeaveError(result.error);
      setLeaveBusy(false);
      return;
    }

    await disconnectLocally();
    setLeaving(false);
    setLeaveBusy(false);
  };

  const handleDeleteHousehold = async () => {
    if (!session) return;
    setDeleteBusy(true);
    setDeleteError(null);

    const result = await deleteHousehold(getApiBaseUrl(), session.deviceToken);
    if (!result.ok) {
      setDeleteError(result.error);
      setDeleteBusy(false);
      return;
    }

    await disconnectLocally();
    setDeleting(false);
    setDeleteText('');
    setDeleteBusy(false);
  };

  const handleRevoke = async (deviceId: string) => {
    if (!session) return;
    setRevokingId(deviceId);
    setRevokeError(null);

    const result = await revokeDevice(getApiBaseUrl(), session.deviceToken, deviceId);
    setRevokingId(null);

    if (!result.ok) {
      setRevokeError(result.error);
      return;
    }
    await refreshDevices();
  };

  const handleInvite = async () => {
    if (!session) return;
    setInviteError(null);
    setInviteBusy(true);
    const result = await issueJoinCode(getApiBaseUrl(), session.deviceToken);
    setInviteBusy(false);

    if (!result.ok) {
      setInviteError(result.error);
      return;
    }
    setInviteCode(result.value.code);
    setInviteExpiresInSeconds(result.value.expiresInSeconds);
  };

  if (!session) {
    return (
      <div className="flex flex-col gap-3">
        <Card>
          <h2 className="text-lg font-semibold">Household</h2>
          <p className="text-sm text-slate-400">
            This device isn&rsquo;t connected to a household. It still works on its own —
            everything is stored locally — but doses won&rsquo;t be shared with another
            caregiver&rsquo;s phone.
          </p>
          <HouseholdOnboarding
            embedded
            initialDisplayName={getCaregiverName() ?? ''}
            onDone={() => setSession(getHouseholdSession())}
          />
        </Card>
        <PatientRosterCard />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <h2 className="text-lg font-semibold">Household</h2>
        <p className="text-sm text-slate-400">
          {session.householdName ? `Connected to ${session.householdName}.` : 'Connected.'} Doses
          logged here are shared with every caregiver in this household.
        </p>

        <div className="flex flex-col gap-2">
          <button
            type="button"
            className={primaryButtonClass}
            disabled={inviteBusy}
            onClick={() => void handleInvite()}
          >
            {inviteBusy ? 'Creating code…' : 'Invite another caregiver'}
          </button>

          {inviteCode && (
            <div className="flex flex-col gap-1 rounded-md border border-slate-700 p-3 text-center">
              <p className="text-3xl font-semibold tracking-[0.3em]">{inviteCode}</p>
              <p className="text-xs text-slate-400">
                Enter this on the other phone
                {inviteExpiresInSeconds !== null &&
                  ` within ${Math.round(inviteExpiresInSeconds / 60)} minutes`}
                . It works once.
              </p>
              <button type="button" className={`${buttonClass} mt-1`} onClick={() => setInviteCode(null)}>
                Done
              </button>
            </div>
          )}

          {inviteError && (
            <p className="text-locked text-sm" role="alert">
              {inviteError}
            </p>
          )}
        </div>
      </Card>

      <PatientRosterCard />

      <Card>
        <h2 className="text-lg font-semibold">Devices</h2>
        <p className="text-sm text-slate-400">
          Every device currently signed in to this household. Revoke one that&rsquo;s lost,
          stolen, or no longer in use — it stops working immediately.
        </p>

        {devicesError && (
          <p className="text-locked text-sm" role="alert">
            {devicesError}
          </p>
        )}
        {revokeError && (
          <p className="text-locked text-sm" role="alert">
            {revokeError}
          </p>
        )}

        {!devices ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {devices.map((device) => (
              <li
                key={device.id}
                className="flex items-center justify-between gap-3 rounded-md border border-slate-800 p-3 text-sm"
              >
                <div>
                  <p className="font-medium">
                    {device.displayName}
                    {device.isThisDevice && <span className="text-slate-400"> (this device)</span>}
                  </p>
                  {device.platform && <p className="text-xs text-slate-500">{device.platform}</p>}
                </div>
                {!device.isThisDevice && (
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={revokingId === device.id}
                    onClick={() => void handleRevoke(device.id)}
                  >
                    {revokingId === device.id ? 'Revoking…' : 'Revoke'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <h2 className="text-lg font-semibold">Leave or delete</h2>

        {!leaving ? (
          <button type="button" className={buttonClass} onClick={() => setLeaving(true)}>
            Leave this household
          </button>
        ) : (
          <div className="flex flex-col gap-2 rounded-md border border-slate-700 p-3 text-sm">
            <p>
              This device will stop syncing with {session.householdName ?? 'this household'}, and
              its medicine, schedule, and dose data on this device will be cleared. Other
              caregivers keep their own copies — nothing on the server is deleted.
            </p>
            {leaveError && (
              <p className="text-locked text-sm" role="alert">
                {leaveError}
              </p>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                className={dangerButtonClass}
                disabled={leaveBusy}
                onClick={() => void handleLeave()}
              >
                {leaveBusy ? 'Leaving…' : 'Leave household'}
              </button>
              <button
                type="button"
                className={buttonClass}
                disabled={leaveBusy}
                onClick={() => {
                  setLeaving(false);
                  setLeaveError(null);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="flex flex-col gap-2 border-t border-slate-800 pt-3">
          {!deleting ? (
            <button type="button" className={dangerButtonClass} onClick={() => setDeleting(true)}>
              Delete this household
            </button>
          ) : (
            <div className="flex flex-col gap-2 rounded-md border border-locked p-3 text-sm">
              <p className="font-medium text-locked" role="alert">
                This permanently deletes {session.householdName ?? 'this household'} for every
                caregiver in it — every device, every medicine, every dose ever logged. This
                cannot be undone.
              </p>
              <label className={labelClass}>
                Type {DELETE_CONFIRMATION_PHRASE} to confirm
                <input
                  className={inputClass}
                  value={deleteText}
                  onChange={(event) => setDeleteText(event.target.value)}
                  autoFocus
                />
              </label>
              {deleteError && (
                <p className="text-locked text-sm" role="alert">
                  {deleteError}
                </p>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  className={dangerButtonClass}
                  disabled={deleteBusy || deleteText !== DELETE_CONFIRMATION_PHRASE}
                  onClick={() => void handleDeleteHousehold()}
                >
                  {deleteBusy ? 'Deleting…' : 'Delete household'}
                </button>
                <button
                  type="button"
                  className={buttonClass}
                  disabled={deleteBusy}
                  onClick={() => {
                    setDeleting(false);
                    setDeleteText('');
                    setDeleteError(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
