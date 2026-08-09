import { NavigationContainer } from '@react-navigation/native';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { AppNavigator } from './src/app/AppNavigator';
import { CaregiverGate } from './src/identity/CaregiverGate';
import { RevokedDeviceBanner } from './src/sync/RevokedDeviceBanner';
import { SafetyWarningBanner } from './src/sync/SafetyWarningBanner';
import { SyncProvider } from './src/sync/SyncProvider';
import { SyncStatusBadge } from './src/sync/SyncStatusBadge';
import { colors } from './src/ui/primitives';

/**
 * Sprint A2 — feature parity (docs/android-client-plan.md). Replaces Sprint A0's bare
 * `<SpikeScreen/>` render with the real app: `CaregiverGate` (nothing renders until a caregiver
 * identifies themselves) wraps `SyncProvider` (starts the sync engine once a household session
 * exists) wraps the navigation shell — the same gating order as `apps/web/src/App.tsx`.
 *
 * The header row (title + sync status) and the safety warning banner sit above the tab
 * navigator, visible on every tab, mirroring web's `AppShell`.
 */
export default function App(): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
        <StatusBar style="light" />
        <CaregiverGate>
          <SyncProvider>
            <View style={styles.header}>
              <Text style={styles.title}>MedGuard</Text>
              <SyncStatusBadge />
            </View>
            <RevokedDeviceBanner />
            <SafetyWarningBanner />
            <NavigationContainer>
              <AppNavigator />
            </NavigationContainer>
          </SyncProvider>
        </CaregiverGate>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  title: { fontSize: 20, fontWeight: '700', color: colors.text },
});
