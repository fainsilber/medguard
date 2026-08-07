import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ActivityIndicator, Text, View } from 'react-native';
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
// Bottom tabs
// ---------------------------------------------------------------------------

type TabParamList = {
  Today: undefined;
  Medicines: undefined;
  'As needed': undefined;
  Inventory: undefined;
  Export: undefined;
  Household: undefined;
  Diagnostics: undefined;
};

const Tab = createBottomTabNavigator<TabParamList>();

/**
 * Emoji glyphs instead of an icon library: no `tabBarIcon` was ever wired up here, so
 * `@react-navigation/bottom-tabs` fell back to its own placeholder (`MissingIcon`, a bare "⏷")
 * on every tab. A real icon set (`@expo/vector-icons` et al.) is a real dependency to add and
 * verify; a `Text` glyph needs nothing new and renders everywhere a font does — same reasoning
 * `MedicineForm`'s Chip rows use to avoid a dropdown library.
 */
const TAB_ICONS: Record<keyof TabParamList, string> = {
  Today: '📅',
  Medicines: '💊',
  'As needed': '⏱️',
  Inventory: '📦',
  Export: '📤',
  Household: '🏠',
  Diagnostics: '🛠️',
};

function makeTabBarIcon(tab: keyof TabParamList) {
  return ({ size }: { color: string; size: number }) => (
    <Text style={{ fontSize: size }}>{TAB_ICONS[tab]}</Text>
  );
}

export function AppNavigator(): React.JSX.Element {
  return (
    <Tab.Navigator screenOptions={tabScreenOptions}>
      <Tab.Screen name="Today" component={TodayView} options={{ tabBarIcon: makeTabBarIcon('Today') }} />
      <Tab.Screen
        name="Medicines"
        component={MedicinesStackScreen}
        options={{ headerShown: false, tabBarIcon: makeTabBarIcon('Medicines') }}
      />
      <Tab.Screen name="As needed" component={PrnScreen} options={{ tabBarIcon: makeTabBarIcon('As needed') }} />
      <Tab.Screen name="Inventory" component={InventoryScreen} options={{ tabBarIcon: makeTabBarIcon('Inventory') }} />
      <Tab.Screen name="Export" component={ExportScreen} options={{ tabBarIcon: makeTabBarIcon('Export') }} />
      <Tab.Screen name="Household" component={HouseholdScreen} options={{ tabBarIcon: makeTabBarIcon('Household') }} />
      <Tab.Screen
        name="Diagnostics"
        component={DiagnosticsScreen}
        options={{ tabBarIcon: makeTabBarIcon('Diagnostics') }}
      />
    </Tab.Navigator>
  );
}

function LoadingScreen(): React.JSX.Element {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background }}>
      <ActivityIndicator />
    </View>
  );
}

const tabScreenOptions = {
  headerStyle: { backgroundColor: colors.surface },
  headerTintColor: colors.text,
  tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
  tabBarActiveTintColor: colors.primary,
  tabBarInactiveTintColor: colors.textMuted,
  sceneStyle: { backgroundColor: colors.background },
} as const;

const stackScreenOptions = {
  headerStyle: { backgroundColor: colors.surface },
  headerTintColor: colors.text,
  contentStyle: { backgroundColor: colors.background },
} as const;
