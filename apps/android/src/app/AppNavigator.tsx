import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
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
 * (Today shortcut top-left, hamburger top-right) above the `NavigationContainer`, so every screen
 * here is `headerShown: false` and reached either from `Home`, the header's Today shortcut, the
 * hamburger menu, or the OS back gesture/button (native-stack pops on it same as any Android app)
 * — no per-screen header bar left to double up with the persistent one.
 *
 * `Home` itself is a two-item bottom-tab navigator (Medicines / As needed) rather than a stack
 * screen: those are the two things a caregiver reaches for constantly, so they get a permanent,
 * full-width, always-visible switcher at the bottom of the screen — opening the app lands
 * straight on the Medicines list, not an empty picker.
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
      <MedicinesStack.Screen name="MedicineList" component={MedicineListRoute} />
      <MedicinesStack.Screen name="MedicineForm" component={MedicineFormRoute} />
      <MedicinesStack.Screen name="ScheduleForm" component={ScheduleFormRoute} />
    </MedicinesStack.Navigator>
  );
}

// ---------------------------------------------------------------------------
// Home: a two-item bottom-tab switcher (Medicines / As needed), full-width,
// complete labels — not the old 8-tab bar's cramped icon-plus-ellipsis.
// ---------------------------------------------------------------------------

type HomeTabParamList = {
  Medicines: undefined;
  'As needed': undefined;
};

const HomeTab = createBottomTabNavigator<HomeTabParamList>();

const HOME_TAB_ICONS: Record<keyof HomeTabParamList, string> = {
  Medicines: '💊',
  'As needed': '⏱️',
};

/**
 * Custom instead of the default `tabBarLabel`/`tabBarIcon` layout: the default bar sizes itself
 * for a row of many narrow tabs (small icon, tiny label). With only two destinations here, the
 * ask was for two big, full-width, evenly-split buttons with room for the whole label — easiest
 * to get by owning the bar's layout outright rather than fighting the default's sizing.
 */
function HomeTabBar({ state, navigation }: BottomTabBarProps): React.JSX.Element {
  const insets = useSafeAreaInsets();
  return (
    <View style={[homeTabBarStyles.bar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
      {state.routes.map((route, index) => {
        const isFocused = state.index === index;
        const name = route.name as keyof HomeTabParamList;
        return (
          <Pressable
            key={route.key}
            accessibilityRole="button"
            accessibilityState={isFocused ? { selected: true } : {}}
            onPress={() => {
              const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
              if (!isFocused && !event.defaultPrevented) {
                navigation.navigate(route.name);
              }
            }}
            style={({ pressed }) => [
              homeTabBarStyles.button,
              isFocused && homeTabBarStyles.buttonActive,
              pressed && homeTabBarStyles.pressed,
            ]}
          >
            <Text style={homeTabBarStyles.icon}>{HOME_TAB_ICONS[name]}</Text>
            <Text
              style={[homeTabBarStyles.label, isFocused && homeTabBarStyles.labelActive]}
              numberOfLines={1}
            >
              {name}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const homeTabBarStyles = StyleSheet.create({
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

function HomeScreen(): React.JSX.Element {
  return (
    <HomeTab.Navigator
      initialRouteName="Medicines"
      tabBar={(props) => <HomeTabBar {...props} />}
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.background } }}
    >
      <HomeTab.Screen name="Medicines" component={MedicinesStackScreen} />
      <HomeTab.Screen name="As needed" component={PrnScreen} />
    </HomeTab.Navigator>
  );
}

// ---------------------------------------------------------------------------
// Root stack: Home + every other screen, reached from the persistent header's
// Today shortcut or the hamburger menu.
// ---------------------------------------------------------------------------

export type RootStackParamList = {
  Home: undefined;
  Today: undefined;
  Inventory: undefined;
  Log: undefined;
  Shabbat: undefined;
  Household: undefined;
  Diagnostics: undefined;
};

const RootStack = createNativeStackNavigator<RootStackParamList>();

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
  headerShown: false,
  contentStyle: { backgroundColor: colors.background },
} as const;
