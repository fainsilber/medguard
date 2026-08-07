import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { getApiBaseUrl } from '../../api/config.js';
import { createHousehold, redeemJoinCode } from '../../api/householdApi.js';
import { setCaregiverName } from '../../identity/caregiverName.js';
import { setHouseholdSession } from '../../identity/session.js';
import type { HouseholdSession } from '../../identity/session.js';
import { Button, colors, styles as sharedStyles } from '../../ui/primitives.js';

/**
 * First run: start a household, or join one someone else already started. RN port of
 * `apps/web/src/features/household/HouseholdOnboarding.tsx`.
 *
 * Deliberately skippable on a fresh device — the app works entirely offline on one device, and a
 * caregiver standing in a hospital with no signal must not be blocked from logging a dose because
 * a server is unreachable. Connecting can happen later.
 *
 * Also reused, `embedded`, from `HouseholdScreen` when a caregiver leaves one household and wants
 * to join or create another without navigating away — skipping doesn't apply there (they're
 * already using the device on its own), and their existing caregiver name is worth pre-filling
 * rather than asking for again.
 *
 * Unlike web, `finish()` is async: `setHouseholdSession`/`setCaregiverName` are backed by
 * `expo-secure-store`, which has no synchronous write to fire-and-forget the way web's
 * `localStorage` does — both are awaited before `onDone` runs, so the caller never sees `onDone`
 * fire ahead of the session actually being persisted.
 */
type Mode = 'choose' | 'create' | 'join';

export function HouseholdOnboarding({
  onDone,
  onSkip,
  embedded = false,
  initialDisplayName = '',
}: {
  onDone: () => void;
  onSkip?: () => void;
  embedded?: boolean;
  initialDisplayName?: string;
}): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('choose');
  const [householdName, setHouseholdName] = useState('');
  const [displayName, setDisplayName] = useState(initialDisplayName);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const finish = async (session: HouseholdSession, name: string) => {
    await setHouseholdSession(session);
    // The caregiver name is what every dose log is attributed to (safety invariant 5), so it is
    // stored locally too rather than re-fetched.
    await setCaregiverName(name);
    onDone();
  };

  const handleCreate = async () => {
    setError(null);

    const trimmedHousehold = householdName.trim();
    const trimmedName = displayName.trim();
    if (!trimmedHousehold || !trimmedName) {
      setError('Please fill in both fields.');
      return;
    }

    setBusy(true);
    const result = await createHousehold(getApiBaseUrl(), {
      householdName: trimmedHousehold,
      displayName: trimmedName,
    });
    setBusy(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }
    await finish({ ...result.value, householdName: trimmedHousehold }, trimmedName);
  };

  const handleJoin = async () => {
    setError(null);

    const trimmedName = displayName.trim();
    const trimmedCode = code.trim();
    if (!/^\d{6}$/.test(trimmedCode)) {
      setError('A join code is six digits.');
      return;
    }
    if (!trimmedName) {
      setError('Please enter your name.');
      return;
    }

    setBusy(true);
    const result = await redeemJoinCode(getApiBaseUrl(), {
      code: trimmedCode,
      displayName: trimmedName,
    });
    setBusy(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }
    await finish(result.value, trimmedName);
  };

  const content = (
    <>
      {!embedded && (
        <View>
          <Text style={sharedStyles.title}>MedGuard</Text>
          <Text style={[sharedStyles.subtitle, { marginTop: 8 }]}>
            {mode === 'choose'
              ? 'Set up a household so every caregiver sees the same doses, or carry on alone on this device.'
              : mode === 'create'
                ? 'You can invite the other caregivers once this is set up.'
                : 'Ask the caregiver who set up the household for a 6-digit code.'}
          </Text>
        </View>
      )}

      {mode === 'choose' && (
        <View style={{ gap: 12 }}>
          <Button label="Start a new household" onPress={() => setMode('create')} variant="primary" />
          <Button label="Join with a code" onPress={() => setMode('join')} />
          {!embedded && onSkip && (
            <Pressable onPress={onSkip} accessibilityRole="button">
              <Text style={{ fontSize: 13, color: colors.textMuted, textDecorationLine: 'underline' }}>
                Use this device on its own for now
              </Text>
            </Pressable>
          )}
        </View>
      )}

      {mode === 'create' && (
        <View style={{ gap: 12 }}>
          <View>
            <Text style={sharedStyles.label}>Household name</Text>
            <TextInput
              style={sharedStyles.input}
              placeholder="e.g. The Cohens"
              placeholderTextColor={colors.textMuted}
              value={householdName}
              onChangeText={setHouseholdName}
              autoFocus
            />
          </View>
          <View>
            <Text style={sharedStyles.label}>Your name</Text>
            <TextInput
              style={sharedStyles.input}
              placeholder="e.g. Mom"
              placeholderTextColor={colors.textMuted}
              value={displayName}
              onChangeText={setDisplayName}
            />
          </View>
          {error && (
            <Text style={sharedStyles.errorText} accessibilityRole="alert">
              {error}
            </Text>
          )}
          <View style={sharedStyles.row}>
            <Button
              label={busy ? 'Creating…' : 'Create household'}
              onPress={() => void handleCreate()}
              disabled={busy}
              variant="primary"
            />
            <Button label="Back" onPress={() => setMode('choose')} disabled={busy} />
          </View>
        </View>
      )}

      {mode === 'join' && (
        <View style={{ gap: 12 }}>
          <View>
            <Text style={sharedStyles.label}>Join code</Text>
            <TextInput
              style={[sharedStyles.input, { textAlign: 'center', fontSize: 24, letterSpacing: 8 }]}
              keyboardType="number-pad"
              maxLength={6}
              placeholder="000000"
              placeholderTextColor={colors.textMuted}
              value={code}
              onChangeText={(text) => setCode(text.replace(/\D/g, '').slice(0, 6))}
              autoFocus
            />
          </View>
          <View>
            <Text style={sharedStyles.label}>Your name</Text>
            <TextInput
              style={sharedStyles.input}
              placeholder="e.g. Dad"
              placeholderTextColor={colors.textMuted}
              value={displayName}
              onChangeText={setDisplayName}
            />
          </View>
          {error && (
            <Text style={sharedStyles.errorText} accessibilityRole="alert">
              {error}
            </Text>
          )}
          <View style={sharedStyles.row}>
            <Button
              label={busy ? 'Joining…' : 'Join household'}
              onPress={() => void handleJoin()}
              disabled={busy}
              variant="primary"
            />
            <Button label="Back" onPress={() => setMode('choose')} disabled={busy} />
          </View>
        </View>
      )}
    </>
  );

  if (embedded) {
    return <View style={{ gap: 16 }}>{content}</View>;
  }

  return <View style={[sharedStyles.content, { flex: 1, justifyContent: 'center' }]}>{content}</View>;
}
