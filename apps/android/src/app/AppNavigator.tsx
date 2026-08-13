import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { formatLocalDate } from '@medguard/shared';
import type { Medicine, Schedule } from '@medguard/shared';
import { DiagnosticsScreen } from '../features/diagnostics/DiagnosticsScreen.js';
import { ExportScreen } from '../features/export/ExportScreen.js';
import { HouseholdScreen } from '../features/household/HouseholdScreen.js';
import { InventoryScreen } from '../features/inventory/InventoryScreen.js';
import { MedicineForm } from '../features/medicines/MedicineForm.js';
import { MedicineList } from '../features/medicines/MedicineList.js';
import { PrnScreen } from '../features/prnDoses/PrnScreen.js';
import { ScheduleForm } from '../features/schedules/ScheduleForm.js';
import { ReconciliationSheet } from '../features/shabbat/ReconciliationSheet.js';
import { ShabbatScreen } from '../features/shabbat/ShabbatScreen.js';
import { useMotzeiPrompt } from '../features/shabbat/useMotzeiPrompt.js';
import { TodayView } from '../features/today/TodayView.js';
import { useLiveQuery } from '../store/useLiveQuery.js';
import { colors } from '../ui/primitives.js';
import { useClock, useRepository } from './RepositoryContext.js';
import { useHouseholdSettings } from './useHouseholdSettings.js';

/**
 * The navigation shell — the Android equivalent of web's flat `TABS` array + component-swap
 * `AppShell` in `apps/web/src/App.tsx`, using `@react-navigation` instead since RN has no
 * URL/DOM to swap components against. Every screen below was built (see each feature directory)
 * to take navigation-agnostic callback props exactly for this seam: this file is the only place
 * that knows about routes, route params, or `@react-navigation` at all.
 *
 * A single native-stack replaces the old bottom-tab bar: `App.tsx` renders one persistent header
 * (Today shortcut top-left, hamburger top-right) above the `NavigationContainer`, so every screen
 * here is `headerShown: false` and reached either from `Home`'s two big buttons, the header's
 * Today shortcut, the hamburger menu, or the OS back gesture/button (native-stack pops on it same
 * as any Android app) — no per-screen header bar left to double up with the persistent one.
 */

// ---------------------------------------------------------------------------
// Medicines tab: a native-stack of List -> Form -> ScheduleForm
// ---------------------------------------------------------------------------

type MedicinesStackParamList = {
  MedicineList: undefined;
  MedicineForm: { medicineId?: string };
  ScheduleForm: { medicineId: string; scheduleId?: string };
};

const MedicinesStack = createNativeStackNavigator<MedicinesStackParamList>();

function MedicineListRoute({
  navigation,
}: NativeStackScreenProps<MedicinesStackParamList, 'MedicineList'>): React.JSX.Element {
  return (
    <MedicineList
      onAddMedicine={() => navigation.navigate('MedicineForm', {})}
      onEditMedicine={(medicine: Medicine) => navigation.navigate('MedicineForm', { medicineId: medicine.id })}
      onAddSchedule={(medicineId: string) => navigation.navigate('ScheduleForm', { medicineId })}
      onEditSchedule={(schedule: Schedule) =>
        navigation.navigate('ScheduleForm', { medicineId: schedule.medicineId, scheduleId: schedule.id })
      }
    />
  );
}

function MedicineFormRoute({
  route,
  navigation,
}: NativeStackScreenProps<MedicinesStackParamList, 'MedicineForm'>): React.JSX.Element {
  const repository = useRepository();
  const { medicineId } = route.params;
  const medicine = useLiveQuery(
    () => (medicineId ? repository.getMedicine(medicineId) : Promise.resolve(undefined)),
    ['medicines'],
  );

  // Editing an existing medicine: wait for it to load rather than briefly rendering a blank
  // "add" form and then repopulating it once the fetch resolves.
  if (medicineId && medicine === undefined) {
    return <LoadingScreen />;
  }

  return (
    <MedicineForm
      {...(medicine ? { medicine } : {})}
      onDone={() => navigation.goBack()}
      onCancel={() => navigation.goBack()}
    />
  );
}

function ScheduleFormRoute({
  route,
  navigation,
}: NativeStackScreenProps<MedicinesStackParamList, 'ScheduleForm'>): React.JSX.Element {
  const repository = useRepository();
  const clock = useClock();
  const householdSettings = useHouseholdSettings();
  const { medicineId, scheduleId } = route.params;

  const schedules = useLiveQuery(() => repository.schedulesForMedicine(medicineId), ['schedules']);
  const today = householdSettings ? formatLocalDate(householdSettings.timeZone, clock.nowMs()) : undefined;
  const existing = scheduleId ? schedules?.find((schedule) => schedule.id === scheduleId) : undefined;

  if (!today || (scheduleId && !schedules)) {
    return <LoadingScreen />;
  }

  return (
    <ScheduleForm
      medicineId={medicineId}
      {...(existing ? { existing } : {})}
      today={today}
      onDone={() => navigation.goBack()}
      onCancel={() => navigation.goBack()}
    />
  );
}

function MedicinesStackScreen(): React.JSX.Element {
  return (
    <MedicinesStack.Navigator screenOptions={stackScreenOptions}>
      <MedicinesStack.Screen name="MedicineList" component={MedicineListRoute} options={{ title: 'Medicines' }} />
      <MedicinesStack.Screen
        name="MedicineForm"
        component={MedicineFormRoute}
        options={({ route }) => ({ title: route.params.medicineId ? 'Edit medicine' : 'Add medicine' })}
      />
      <MedicinesStack.Screen
        name="ScheduleForm"
        component={ScheduleFormRoute}
        options={({ route }) => ({ title: route.params.scheduleId ? 'Change schedule' : 'Add schedule' })}
      />
    </MedicinesStack.Navigator>
  );
}

// ---------------------------------------------------------------------------
// Root stack: Home (the two big buttons) + every other screen, reached from
// Home, the persistent header's Today shortcut, or the hamburger menu.
// ---------------------------------------------------------------------------

export type RootStackParamList = {
  Home: undefined;
  Today: undefined;
  Medicines: undefined;
  'As needed': undefined;
  Inventory: undefined;
  Log: undefined;
  Shabbat: undefined;
  Household: undefined;
  Diagnostics: undefined;
};

const RootStack = createNativeStackNavigator<RootStackParamList>();

function HomeScreen({
  navigation,
}: NativeStackScreenProps<RootStackParamList, 'Home'>): React.JSX.Element {
  return (
    <View style={homeStyles.container}>
      <Pressable
        accessibilityRole="button"
        onPress={() => navigation.navigate('Medicines')}
        style={({ pressed }) => [homeStyles.bigButton, homeStyles.medicinesButton, pressed && homeStyles.pressed]}
      >
        <Text style={homeStyles.bigButtonIcon}>💊</Text>
        <Text style={homeStyles.bigButtonLabel}>Medicines</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        onPress={() => navigation.navigate('As needed')}
        style={({ pressed }) => [homeStyles.bigButton, homeStyles.asNeededButton, pressed && homeStyles.pressed]}
      >
        <Text style={homeStyles.bigButtonIcon}>⏱️</Text>
        <Text style={homeStyles.bigButtonLabel}>As needed</Text>
      </Pressable>
    </View>
  );
}

const homeStyles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 16, backgroundColor: colors.background },
  bigButton: {
    flex: 1,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  medicinesButton: { backgroundColor: colors.surface },
  asNeededButton: { backgroundColor: colors.surface },
  pressed: { opacity: 0.8 },
  bigButtonIcon: { fontSize: 64 },
  bigButtonLabel: { fontSize: 26, fontWeight: '700', color: colors.text },
});

export function AppNavigator(): React.JSX.Element {
  // PRD §3: after Havdalah the app opens the reconciliation sheet rather than waiting to be asked
  // (Sprint A5 phase 2). It replaces the tabs rather than covering them, so "Later" is always one
  // tap away — a modal a caregiver could get stuck behind at 3am is its own hazard.
  const motzei = useMotzeiPrompt();

  if (motzei.show) {
    return <ReconciliationSheet onDone={motzei.dismiss} />;
  }

  return (
    <RootStack.Navigator initialRouteName="Home" screenOptions={rootScreenOptions}>
      <RootStack.Screen name="Home" component={HomeScreen} />
      <RootStack.Screen name="Today" component={TodayView} />
      <RootStack.Screen name="Medicines" component={MedicinesStackScreen} />
      <RootStack.Screen name="As needed" component={PrnScreen} />
      <RootStack.Screen name="Inventory" component={InventoryScreen} />
      <RootStack.Screen name="Log" component={ExportScreen} />
      <RootStack.Screen name="Shabbat" component={ShabbatScreen} />
      <RootStack.Screen name="Household" component={HouseholdScreen} />
      <RootStack.Screen name="Diagnostics" component={DiagnosticsScreen} />
    </RootStack.Navigator>
  );
}

function LoadingScreen(): React.JSX.Element {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background }}>
      <ActivityIndicator />
    </View>
  );
}

const rootScreenOptions = {
  headerShown: false,
  contentStyle: { backgroundColor: colors.background },
} as const;

const stackScreenOptions = {
  headerStyle: { backgroundColor: colors.surface },
  headerTintColor: colors.text,
  contentStyle: { backgroundColor: colors.background },
} as const;
