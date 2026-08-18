import { NavigationContainer, useNavigationContainerRef } from '@react-navigation/native';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { AlarmHealthBanner } from './src/alarms/AlarmHealthBanner';
import { AlarmProvider } from './src/alarms/AlarmProvider';
import { AppNavigator } from './src/app/AppNavigator';
import type { RootStackParamList } from './src/app/AppNavigator';
import { PatientProvider } from './src/app/PatientProvider';
import { PatientSwitcher } from './src/app/PatientSwitcher';
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
 * `AlarmProvider` (Sprint A3) nests just inside `SyncProvider`: it needs the repository, and it
 * re-materializes on the same `NotifyingStore` writes `SyncProvider`'s pulls make, so no explicit
 * "sync completed" hook is needed between them — the store notification is the hook.
 *
 * The header row (Medicines shortcut, title + sync status, hamburger) and the safety warning banner
 * sit above `AppNavigator`'s stack, visible on every screen — this is the one persistent header
 * for the whole app, which is why every screen in `AppNavigator` is `headerShown: false`: a
 * second per-screen header stacked under this one was the source of the dead space that used to
 * show up above every screen. `AppNavigator` renders its own persistent bottom bar (Today /
 * As needed) the same way, alongside its stack rather than nested inside part of it — `navigationRef`
 * is created here (so the header's Medicines shortcut and hamburger menu can drive it too) and passed
 * down as a prop for that bottom bar to navigate with.
 */
const MENU_ITEMS: ReadonlyArray<{ route: keyof RootStackParamList; label: string; icon: string }> =
  [
    { route: 'Settings', label: 'Settings', icon: '🛠️' },
    { route: 'Shabbat', label: 'Shabbat', icon: '🕯️' },
    { route: 'Log', label: 'Log', icon: '📤' },
    { route: 'Inventory', label: 'Inventory', icon: '📦' },
    { route: 'Household', label: 'Household', icon: '🏠' },
  ];

export default function App(): React.JSX.Element {
  const navigationRef = useNavigationContainerRef<RootStackParamList>();
  const [menuOpen, setMenuOpen] = useState(false);

  function navigate(route: keyof RootStackParamList): void {
    setMenuOpen(false);
    if (navigationRef.isReady()) {
      navigationRef.navigate(route);
    }
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
        <StatusBar style="light" />
        <CaregiverGate>
          <SyncProvider>
            <PatientProvider>
              <AlarmProvider>
                <View style={styles.header}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Medicines list"
                    onPress={() => navigate('Medicines')}
                    style={styles.iconButton}
                  >
                    <Text style={styles.iconGlyph}>💊</Text>
                  </Pressable>
                  <View style={styles.headerCenter}>
                    <Text style={styles.title}>MedGuard</Text>
                    <SyncStatusBadge />
                    <PatientSwitcher />
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="More screens"
                    onPress={() => setMenuOpen(true)}
                    style={styles.iconButton}
                  >
                    <Text style={styles.iconGlyph}>☰</Text>
                  </Pressable>
                </View>
                <RevokedDeviceBanner />
                <SafetyWarningBanner />
                <AlarmHealthBanner />
                <NavigationContainer ref={navigationRef}>
                  <AppNavigator navigationRef={navigationRef} />
                </NavigationContainer>
                <Modal
                  visible={menuOpen}
                  transparent
                  animationType="fade"
                  onRequestClose={() => setMenuOpen(false)}
                >
                  <Pressable
                    style={styles.menuBackdrop}
                    accessibilityRole="button"
                    onPress={() => setMenuOpen(false)}
                  >
                    <View style={styles.menu}>
                      {MENU_ITEMS.map((item) => (
                        <Pressable
                          key={item.route}
                          accessibilityRole="button"
                          style={styles.menuItem}
                          onPress={() => navigate(item.route)}
                        >
                          <Text style={styles.menuItemIcon}>{item.icon}</Text>
                          <Text style={styles.menuItemLabel}>{item.label}</Text>
                        </Pressable>
                      ))}
                    </View>
                  </Pressable>
                </Modal>
              </AlarmProvider>
            </PatientProvider>
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
    paddingHorizontal: 4,
    paddingVertical: 6,
  },
  iconButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconGlyph: { fontSize: 20, color: colors.text },
  headerCenter: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  title: { fontSize: 20, fontWeight: '700', color: colors.text },
  menuBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    alignItems: 'flex-end',
  },
  menu: {
    marginTop: 56,
    marginRight: 8,
    minWidth: 190,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingVertical: 4,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  menuItemIcon: { fontSize: 18 },
  menuItemLabel: { fontSize: 15, fontWeight: '500', color: colors.text },
});
