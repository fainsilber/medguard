import { useEffect, useState } from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { NavigationContainerRefWithCurrent } from '@react-navigation/native';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
 * A native-stack replaces the old 8-item bottom-tab bar: `App.tsx` renders one persistent header
 * (Medicines shortcut top-left, hamburger top-right) above the `NavigationContainer`, so every screen
 * here is `headerShown: false` and reached either from the bottom Today/As-needed switcher,
 * the header's Medicines shortcut, the hamburger menu, or the OS back gesture/button (native-stack
 * pops on it same as any Android app) — no per-screen header bar left to double up with the
 * persistent one.
 *
 * `BottomNavBar` (Today / As needed) is rendered here as a sibling of `RootStack.Navigator`,
 * not nested inside it, so it stays visible on every root screen — Medicines, Inventory, Log, Shabbat,
 * Household and Diagnostics included, not just the two tabs it switches between. Those are the two
 * things a caregiver reaches for constantly, so they get a permanent, full-width, always-visible
 * switcher no matter where navigation currently is, the same way the header above never goes away.
 * It drives navigation through `navigationRef` (owned by `App.tsx`, passed down as a prop) rather
 * than `useNavigation()`, because it isn't rendered inside a `Screen` — there's no navigation prop
 * in context to pull from at this level.
 */

// ---------------------------------------------------------------------------
// Medicines tab: a native-stack of List -> Form -> ScheduleForm
// ---------------------------------------------------------------------------

type MedicinesStackParamList = {
  MedicineList: undefined;
  MedicineForm: { medicineId?: string };
  ScheduleForm: { medicineId: string; patientId: string; scheduleId?: string };
};

const MedicinesStack = createNativeStackNavigator<MedicinesStackParamList>();

function MedicineListRoute({
  navigation,
}: NativeStackScreenProps<MedicinesStackParamList, 'MedicineList'>): React.JSX.Element {
  return (
    <MedicineList
      onAddMedicine={() => navigation.navigate('MedicineForm', {})}
      onEditMedicine={(medicine: Medicine) =>
        navigation.navigate('MedicineForm', { medicineId: medicine.id })
      }
      onAddSchedule={(medicineId: string, patientId: string) =>
        navigation.navigate('ScheduleForm', { medicineId, patientId })
      }
      onEditSchedule={(schedule: Schedule) =>
        navigation.navigate('ScheduleForm', {
          medicineId: schedule.medicineId,
          patientId: schedule.patientId,
          scheduleId: schedule.id,
        })
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
  const { medicineId, patientId, scheduleId } = route.params;

  const schedules = useLiveQuery(() => repository.schedulesForMedicine(medicineId), ['schedules']);
  const today = householdSettings
    ? formatLocalDate(householdSettings.timeZone, clock.nowMs())
    : undefined;
  const existing = scheduleId
    ? schedules?.find((schedule) => schedule.id === scheduleId)
    : undefined;

  if (!today || (scheduleId && !schedules)) {
    return <LoadingScreen />;
  }

  return (
    <ScheduleForm
      medicineId={medicineId}
      patientId={patientId}
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
      <MedicinesStack.Screen name="MedicineList" component={MedicineListRoute} />
      <MedicinesStack.Screen name="MedicineForm" component={MedicineFormRoute} />
      <MedicinesStack.Screen name="ScheduleForm" component={ScheduleFormRoute} />
    </MedicinesStack.Navigator>
  );
}

// ---------------------------------------------------------------------------
// Root stack: every screen, reached from the bottom Medicines/As-needed
// switcher, the persistent header's Today shortcut, or the hamburger menu.
// ---------------------------------------------------------------------------

export type RootStackParamList = {
  Medicines: undefined;
  AsNeeded: undefined;
  Today: undefined;
  Inventory: undefined;
  Log: undefined;
  Shabbat: undefined;
  Household: undefined;
  Diagnostics: undefined;
};

const RootStack = createNativeStackNavigator<RootStackParamList>();

// ---------------------------------------------------------------------------
// BottomNavBar: a two-item, full-width switcher (Today / As needed) that
// stays mounted alongside RootStack.Navigator — see the file doc comment for
// why it's driven by navigationRef instead of useNavigation().
// ---------------------------------------------------------------------------

const BOTTOM_NAV_ITEMS: ReadonlyArray<{
  route: 'Today' | 'AsNeeded';
  label: string;
  icon: string;
}> = [
  { route: 'Today', label: 'Today', icon: '📅' },
  { route: 'AsNeeded', label: 'As needed', icon: '⏱️' },
];

function BottomNavBar({
  navigationRef,
  activeRoute,
}: {
  navigationRef: NavigationContainerRefWithCurrent<RootStackParamList>;
  activeRoute: keyof RootStackParamList;
}): React.JSX.Element {
  const insets = useSafeAreaInsets();
  return (
    <View style={[bottomNavBarStyles.bar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
      {BOTTOM_NAV_ITEMS.map((item) => {
        const isFocused = activeRoute === item.route;
        return (
          <Pressable
            key={item.route}
            accessibilityRole="button"
            accessibilityState={isFocused ? { selected: true } : {}}
            onPress={() => {
              if (!isFocused && navigationRef.isReady()) {
                navigationRef.navigate(item.route);
              }
            }}
            style={({ pressed }) => [
              bottomNavBarStyles.button,
              isFocused && bottomNavBarStyles.buttonActive,
              pressed && bottomNavBarStyles.pressed,
            ]}
          >
            <Text style={bottomNavBarStyles.icon}>{item.icon}</Text>
            <Text
              style={[bottomNavBarStyles.label, isFocused && bottomNavBarStyles.labelActive]}
              numberOfLines={1}
            >
              {item.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const bottomNavBarStyles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  button: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingTop: 12,
    paddingHorizontal: 8,
    borderTopWidth: 3,
    borderTopColor: 'transparent',
  },
  buttonActive: { borderTopColor: colors.primary },
  pressed: { opacity: 0.75 },
  icon: { fontSize: 26 },
  label: { fontSize: 15, fontWeight: '700', color: colors.textMuted },
  labelActive: { color: colors.text },
});

export function AppNavigator({
  navigationRef,
}: {
  navigationRef: NavigationContainerRefWithCurrent<RootStackParamList>;
}): React.JSX.Element {
  // PRD §3: after Havdalah the app opens the reconciliation sheet rather than waiting to be asked
  // (Sprint A5 phase 2). It replaces the tabs rather than covering them, so "Later" is always one
  // tap away — a modal a caregiver could get stuck behind at 3am is its own hazard.
  const motzei = useMotzeiPrompt();
  const [activeRoute, setActiveRoute] = useState<keyof RootStackParamList>('Today');

  // Root-level route name only (never a nested MedicinesStack screen like "MedicineForm"): that's
  // what tells us which of the two bottom-bar buttons to highlight, and getRootState() gives it
  // directly without descending into whichever screen's own stack happens to be focused.
  useEffect(
    () =>
      navigationRef.addListener('state', () => {
        const state = navigationRef.getRootState();
        const name = state?.routes[state.index]?.name;
        if (name) setActiveRoute(name as keyof RootStackParamList);
      }),
    [navigationRef],
  );

  if (motzei.show) {
    return <ReconciliationSheet onDone={motzei.dismiss} />;
  }

  return (
    <>
      <RootStack.Navigator initialRouteName="Today" screenOptions={rootScreenOptions}>
        <RootStack.Screen name="Medicines" component={MedicinesStackScreen} />
        <RootStack.Screen name="AsNeeded" component={PrnScreen} />
        <RootStack.Screen name="Today" component={TodayView} />
        <RootStack.Screen name="Inventory" component={InventoryScreen} />
        <RootStack.Screen name="Log" component={ExportScreen} />
        <RootStack.Screen name="Shabbat" component={ShabbatScreen} />
        <RootStack.Screen name="Household" component={HouseholdScreen} />
        <RootStack.Screen name="Diagnostics" component={DiagnosticsScreen} />
      </RootStack.Navigator>
      <BottomNavBar navigationRef={navigationRef} activeRoute={activeRoute} />
    </>
  );
}

function LoadingScreen(): React.JSX.Element {
  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.background,
      }}
    >
      <ActivityIndicator />
    </View>
  );
}

const rootScreenOptions = {
  headerShown: false,
  contentStyle: { backgroundColor: colors.background },
} as const;

const stackScreenOptions = {
  headerShown: false,
  contentStyle: { backgroundColor: colors.background },
} as const;
