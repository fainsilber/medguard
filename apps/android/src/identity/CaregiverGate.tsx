import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ActivityIndicator, Text, TextInput, View } from 'react-native';
import { RepositoryProvider } from '../app/RepositoryContext.js';
import { HouseholdOnboarding } from '../features/household/HouseholdOnboarding.js';
import { Button, colors, styles as ui } from '../ui/primitives.js';
import { getCaregiverName, setCaregiverName } from './caregiverName.js';
import { getHouseholdSession } from './session.js';

/**
 * The entry point of the app: nothing renders until we know who's using this device (safety
 * invariant 5 — every log records who; no anonymous entries), then wires that identity into the
 * database via `RepositoryProvider`. RN port of `apps/web/src/identity/CaregiverGate.tsx`.
 *
 * Unlike web, `getCaregiverName()`/`getHouseholdSession()` are async (`expo-secure-store` has no
 * synchronous read), so this renders a brief loading state before it can decide which of the
 * three views below to show — a real, deliberate deviation from web's synchronous first paint.
 *
 * A device that has never been set up is offered a household first, since that is the normal
 * path now that a backend exists. Standing alone is still explicitly supported: the app is fully
 * usable offline on one device, and a caregiver with no signal must never be locked out of
 * logging a dose because a server cannot be reached.
 */
export function CaregiverGate({ children }: { children: ReactNode }): React.JSX.Element {
  const [name, setName] = useState<string | null | undefined>(undefined);
  const [standalone, setStandalone] = useState<boolean | undefined>(undefined);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [initialName, session] = await Promise.all([getCaregiverName(), getHouseholdSession()]);
      if (!cancelled) {
        setName(initialName);
        setStandalone(session !== null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (name === undefined || standalone === undefined) {
    return (
      <View style={[ui.screen, { alignItems: 'center', justifyContent: 'center' }]}>
        <ActivityIndicator />
      </View>
    );
  }

  if (name) {
    return <RepositoryProvider userId={name}>{children}</RepositoryProvider>;
  }

  if (!standalone) {
    return (
      <HouseholdOnboarding
        // The caregiver name is stored by the onboarding flow itself, so it is read back rather
        // than passed — one source of truth for who this device belongs to.
        onDone={() => {
          void getCaregiverName().then((stored) => {
            setName(stored);
            setStandalone(true);
          });
        }}
        onSkip={() => setStandalone(true)}
      />
    );
  }

  const handleSubmit = async () => {
    try {
      await setCaregiverName(draft);
      setName(draft.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Please enter a name');
    }
  };

  return (
    <View style={[ui.content, { flex: 1, justifyContent: 'center' }]}>
      <Text style={ui.title}>MedGuard</Text>
      <Text style={ui.subtitle}>
        Who&rsquo;s using this device? This name is attached to every dose you log, so the
        household always knows who gave what.
      </Text>
      <View>
        <Text style={ui.label}>Your name</Text>
        <TextInput
          style={ui.input}
          placeholder="e.g. Mom, Dad, Grandma"
          placeholderTextColor={colors.textMuted}
          value={draft}
          onChangeText={(value) => {
            setDraft(value);
            setError(null);
          }}
          autoFocus
        />
      </View>
      {error ? (
        <Text style={ui.errorText} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      <Button label="Continue" onPress={() => void handleSubmit()} variant="primary" />
    </View>
  );
}
