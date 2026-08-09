import { useEffect } from 'react';
import { ScrollView, Text } from 'react-native';
import type { ClockTrust, IntakeLog, Medicine } from '@medguard/shared';
import { useRepository } from '../../app/RepositoryContext.js';
import { useHouseholdSettings } from '../../app/useHouseholdSettings.js';
import { useTick } from '../../app/useTick.js';
import { startLocalClockGuard } from '../../clock/localClockGuard.js';
import { useLiveQuery } from '../../store/useLiveQuery.js';
import { Card, KeyboardAvoidingScreen, styles as sharedStyles } from '../../ui/primitives.js';
import { PrnCard } from './PrnCard.js';

/** RN port of `apps/web/src/features/prnDoses/PrnScreen.tsx` — PRD §2.3's PRN safety screen. */

/** Countdown re-render tick, shared by every card rather than one interval each. */
const COUNTDOWN_TICK_MS = 1000;

interface PrnData {
  medicines: Medicine[];
  logsByMedicine: Map<string, IntakeLog[]>;
}

export function PrnScreen({ clockTrust }: { clockTrust?: ClockTrust }): React.JSX.Element {
  const repository = useRepository();
  const householdSettings = useHouseholdSettings();

  // No server-verified clock trust hook exists yet on Android (that depends on API wiring not
  // built as of this sprint) — `clockTrust` is either injected by a caller (tests, and future
  // wiring once the server check lands) or left undefined, in which case each `PrnCard` falls
  // back to the local guard itself. See `apps/android/src/clock/localClockGuard.ts`.
  //
  // The guard's background refresh loop is started here, not at the module's own load time: it
  // needs `AppState` and a live interval, both real resource use that should track this screen's
  // lifetime rather than run for the whole app session regardless of whether PRN is ever opened.
  useEffect(() => (clockTrust ? undefined : startLocalClockGuard()), [clockTrust]);

  useTick(COUNTDOWN_TICK_MS);

  const data = useLiveQuery<PrnData>(async () => {
    const asNeeded = (await repository.activeMedicines()).filter((medicine) => medicine.asNeeded);
    const logsByMedicine = new Map<string, IntakeLog[]>();
    for (const medicine of asNeeded) {
      logsByMedicine.set(medicine.id, await repository.logsForMedicine(medicine.id));
    }
    return { medicines: asNeeded, logsByMedicine };
  }, ['medicines', 'intakeLogs']);

  if (!data || !householdSettings) {
    return (
      <ScrollView contentContainerStyle={sharedStyles.content} style={sharedStyles.screen}>
        <Card>
          <Text style={sharedStyles.subtitle}>Loading…</Text>
        </Card>
      </ScrollView>
    );
  }

  if (data.medicines.length === 0) {
    return (
      <ScrollView contentContainerStyle={sharedStyles.content} style={sharedStyles.screen}>
        <Card>
          <Text style={sharedStyles.subtitle}>No as-needed medicines are set up yet.</Text>
        </Card>
      </ScrollView>
    );
  }

  return (
    <KeyboardAvoidingScreen>
      <ScrollView
        contentContainerStyle={sharedStyles.content}
        style={sharedStyles.screen}
        keyboardShouldPersistTaps="handled"
      >
        {data.medicines.map((medicine) => (
          <PrnCard
            key={medicine.id}
            medicine={medicine}
            logs={data.logsByMedicine.get(medicine.id) ?? []}
            timeZone={householdSettings.timeZone}
            {...(clockTrust ? { clockTrust } : {})}
          />
        ))}
      </ScrollView>
    </KeyboardAvoidingScreen>
  );
}
