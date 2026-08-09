import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { getApiBaseUrl } from '../../api/config.js';
import {
  deleteHousehold,
  issueJoinCode,
  leaveHousehold,
  listDevices,
  revokeDevice,
} from '../../api/householdApi.js';
import type { DeviceInfo } from '../../api/householdApi.js';
import { useRepository } from '../../app/RepositoryContext.js';
import { getCaregiverName } from '../../identity/caregiverName.js';
import { clearHouseholdSession, getHouseholdSession } from '../../identity/session.js';
import type { HouseholdSession } from '../../identity/session.js';
import { Button, Card, colors, styles as sharedStyles } from '../../ui/primitives.js';
import { HouseholdOnboarding } from './HouseholdOnboarding.js';

const DELETE_CONFIRMATION_PHRASE = 'DELETE';

/**
 * The household screen: who this device is connected to, who else is, and how to disconnect —
 * by leaving, by revoking a specific device, or by deleting the household outright. RN port of
 * `apps/web/src/features/household/HouseholdScreen.tsx`.
 *
 * Unlike web, the session isn't known on first render — `getHouseholdSession()` is backed by
 * `expo-secure-store`, which has no synchronous read — so this loads it in an effect and shows a
 * brief loading state first. Once loaded, session state lives in this component (not re-read from
 * storage) so leaving or joining a different household updates the screen immediately, same as
 * web.
 */
export function HouseholdScreen(): React.JSX.Element {
  const repository = useRepository();

  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [session, setSession] = useState<HouseholdSession | null>(null);
  const [caregiverName, setCaregiverNameState] = useState('');

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

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [loadedSession, name] = await Promise.all([getHouseholdSession(), getCaregiverName()]);
      if (!cancelled) {
        setSession(loadedSession);
        setCaregiverNameState(name ?? '');
        setSessionLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
   * Wipes local medical data and forgets the session. Local data is not scoped per household —
   * there is one SQLite database, not one per household id — so without this, medicines and logs
   * from the household just left would sit there and could bleed into whichever household is
   * joined next. Household settings and this device's caregiver name are left alone: this
   * disconnects a household, it does not reset the device's own identity.
   */
  const disconnectLocally = async () => {
    await repository.clearAllData();
    await clearHouseholdSession();
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

  if (!sessionLoaded) {
    return (
      <ScrollView style={sharedStyles.screen} contentContainerStyle={sharedStyles.content}>
        <Card>
          <Text style={sharedStyles.subtitle}>Loading…</Text>
        </Card>
      </ScrollView>
    );
  }

  if (!session) {
    return (
      <ScrollView style={sharedStyles.screen} contentContainerStyle={sharedStyles.content}>
        <Card>
          <Text style={sharedStyles.title}>Household</Text>
          <Text style={sharedStyles.subtitle}>
            This device isn&rsquo;t connected to a household. It still works on its own —
            everything is stored locally — but doses won&rsquo;t be shared with another
            caregiver&rsquo;s phone.
          </Text>
          <HouseholdOnboarding
            embedded
            initialDisplayName={caregiverName}
            onDone={() => {
              void (async () => {
                const newSession = await getHouseholdSession();
                setSession(newSession);
              })();
            }}
          />
        </Card>
      </ScrollView>
    );
  }

  return (
    <ScrollView style={sharedStyles.screen} contentContainerStyle={sharedStyles.content}>
      <Card>
        <Text style={sharedStyles.title}>Household</Text>
        <Text style={sharedStyles.subtitle}>
          {session.householdName ? `Connected to ${session.householdName}.` : 'Connected.'} Doses
          logged here are shared with every caregiver in this household.
        </Text>

        <Button
          label={inviteBusy ? 'Creating code…' : 'Invite another caregiver'}
          onPress={() => void handleInvite()}
          disabled={inviteBusy}
          variant="primary"
        />

        {inviteCode && (
          <View style={cardStyles.inviteBox}>
            <Text style={cardStyles.inviteCode}>{inviteCode}</Text>
            <Text style={sharedStyles.subtitle}>
              Enter this on the other phone
              {inviteExpiresInSeconds !== null &&
                ` within ${Math.round(inviteExpiresInSeconds / 60)} minutes`}
              . It works once.
            </Text>
            <Button label="Done" onPress={() => setInviteCode(null)} />
          </View>
        )}

        {inviteError && (
          <Text style={sharedStyles.errorText} accessibilityRole="alert">
            {inviteError}
          </Text>
        )}
      </Card>

      <Card>
        <Text style={sharedStyles.title}>Devices</Text>
        <Text style={sharedStyles.subtitle}>
          Every device currently signed in to this household. Revoke one that&rsquo;s lost,
          stolen, or no longer in use — it stops working immediately.
        </Text>

        {devicesError && (
          <Text style={sharedStyles.errorText} accessibilityRole="alert">
            {devicesError}
          </Text>
        )}
        {revokeError && (
          <Text style={sharedStyles.errorText} accessibilityRole="alert">
            {revokeError}
          </Text>
        )}

        {!devices ? (
          <Text style={sharedStyles.subtitle}>Loading…</Text>
        ) : (
          <View style={{ gap: 8 }}>
            {devices.map((device) => (
              <View key={device.id} style={cardStyles.deviceRow}>
                <View style={{ flex: 1 }}>
                  <Text style={cardStyles.deviceName}>
                    {device.displayName}
                    {device.isThisDevice && <Text style={{ color: colors.textMuted }}> (this device)</Text>}
                  </Text>
                  {device.platform && <Text style={cardStyles.devicePlatform}>{device.platform}</Text>}
                </View>
                {!device.isThisDevice && (
                  <Button
                    label={revokingId === device.id ? 'Revoking…' : 'Revoke'}
                    onPress={() => void handleRevoke(device.id)}
                    disabled={revokingId === device.id}
                  />
                )}
              </View>
            ))}
          </View>
        )}
      </Card>

      <Card>
        <Text style={sharedStyles.title}>Leave or delete</Text>

        {!leaving ? (
          <Button label="Leave this household" onPress={() => setLeaving(true)} />
        ) : (
          <View style={cardStyles.confirmBox}>
            <Text style={sharedStyles.subtitle}>
              This device will stop syncing with {session.householdName ?? 'this household'}, and
              its medicine, schedule, and dose data on this device will be cleared. Other
              caregivers keep their own copies — nothing on the server is deleted.
            </Text>
            {leaveError && (
              <Text style={sharedStyles.errorText} accessibilityRole="alert">
                {leaveError}
              </Text>
            )}
            <View style={sharedStyles.row}>
              <Button
                label={leaveBusy ? 'Leaving…' : 'Leave household'}
                onPress={() => void handleLeave()}
                disabled={leaveBusy}
                variant="danger"
              />
              <Button
                label="Cancel"
                onPress={() => {
                  setLeaving(false);
                  setLeaveError(null);
                }}
                disabled={leaveBusy}
              />
            </View>
          </View>
        )}

        <View style={cardStyles.section}>
          {!deleting ? (
            <Button label="Delete this household" onPress={() => setDeleting(true)} variant="danger" />
          ) : (
            <View style={cardStyles.dangerBox}>
              <Text style={cardStyles.dangerText} accessibilityRole="alert">
                This permanently deletes {session.householdName ?? 'this household'} for every
                caregiver in it — every device, every medicine, every dose ever logged. This
                cannot be undone.
              </Text>
              <View>
                <Text style={sharedStyles.label}>Type {DELETE_CONFIRMATION_PHRASE} to confirm</Text>
                <TextInput
                  style={sharedStyles.input}
                  value={deleteText}
                  onChangeText={setDeleteText}
                  autoFocus
                  accessibilityLabel={`Type ${DELETE_CONFIRMATION_PHRASE} to confirm`}
                />
              </View>
              {deleteError && (
                <Text style={sharedStyles.errorText} accessibilityRole="alert">
                  {deleteError}
                </Text>
              )}
              <View style={sharedStyles.row}>
                <Button
                  label={deleteBusy ? 'Deleting…' : 'Delete household'}
                  onPress={() => void handleDeleteHousehold()}
                  disabled={deleteBusy || deleteText !== DELETE_CONFIRMATION_PHRASE}
                  variant="danger"
                />
                <Button
                  label="Cancel"
                  onPress={() => {
                    setDeleting(false);
                    setDeleteText('');
                    setDeleteError(null);
                  }}
                  disabled={deleteBusy}
                />
              </View>
            </View>
          )}
        </View>
      </Card>
    </ScrollView>
  );
}

const cardStyles = StyleSheet.create({
  inviteBox: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 12,
    gap: 4,
    alignItems: 'center',
  },
  inviteCode: {
    fontSize: 30,
    fontWeight: '700',
    color: colors.text,
    letterSpacing: 6,
  },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 10,
  },
  deviceName: {
    color: colors.text,
    fontWeight: '600',
    fontSize: 14,
  },
  devicePlatform: {
    color: colors.textMuted,
    fontSize: 12,
  },
  confirmBox: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 12,
    gap: 8,
  },
  section: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: 12,
    gap: 8,
  },
  dangerBox: {
    borderWidth: 1,
    borderColor: colors.locked,
    borderRadius: 8,
    padding: 12,
    gap: 8,
  },
  dangerText: {
    color: colors.locked,
    fontWeight: '600',
    fontSize: 13,
  },
});
