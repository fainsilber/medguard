import { useState } from 'react';
import type { ComponentType } from 'react';
import { PatientProvider } from './app/PatientProvider.js';
import { PatientSwitcher } from './app/PatientSwitcher.js';
import { ExportScreen } from './features/export/ExportScreen.js';
import { HouseholdScreen } from './features/household/HouseholdScreen.js';
import { InventoryScreen } from './features/inventory/InventoryScreen.js';
import { MedicineList } from './features/medicines/MedicineList.js';
import { PrnScreen } from './features/prnDoses/PrnScreen.js';
import { ReconciliationSheet } from './features/shabbat/ReconciliationSheet.js';
import { ShabbatScreen } from './features/shabbat/ShabbatScreen.js';
import { useMotzeiPrompt } from './features/shabbat/useMotzeiPrompt.js';
import { TodayView } from './features/today/TodayView.js';
import { CaregiverGate } from './identity/CaregiverGate.js';
import { DiagnosticsPage } from './diagnostics/DiagnosticsPage.js';
import { RevokedDeviceBanner } from './sync/RevokedDeviceBanner.js';
import { SafetyWarningBanner } from './sync/SafetyWarningBanner.js';
import { PushProvider } from './push/PushProvider.js';
import { SyncProvider } from './sync/SyncProvider.js';
import { SyncStatusBadge } from './sync/SyncStatusBadge.js';
import { buttonClass, primaryButtonClass } from './ui/primitives.js';

interface TabDefinition {
  id: string;
  label: string;
  Screen: ComponentType;
}

/**
 * Diagnostics stays a tab rather than a hidden route: which build is running, whether this device
 * is actually registered for dose alerts, and the app log are the three things a caregiver has to
 * be able to read out when something is wrong, without anyone talking them through a URL.
 */
const TABS: TabDefinition[] = [
  { id: 'today', label: 'Today', Screen: TodayView },
  { id: 'medicines', label: 'Medicines', Screen: MedicineList },
  { id: 'prn', label: 'As needed', Screen: PrnScreen },
  { id: 'inventory', label: 'Inventory', Screen: InventoryScreen },
  { id: 'export', label: 'Log', Screen: ExportScreen },
  { id: 'shabbat', label: 'Shabbat', Screen: ShabbatScreen },
  { id: 'household', label: 'Household', Screen: HouseholdScreen },
  { id: 'diagnostics', label: 'Diagnostics', Screen: DiagnosticsPage },
];

function AppShell() {
  const [activeTabId, setActiveTabId] = useState(TABS[0]!.id);
  const activeTab = TABS.find((tab) => tab.id === activeTabId) ?? TABS[0]!;
  const ActiveScreen = activeTab.Screen;
  // PRD §3: after Havdalah the app opens the reconciliation sheet rather than waiting to be asked
  // (Sprint A5 phase 2). It replaces the tab content rather than covering it, so "Later" and the
  // navigation are both always reachable — a modal a caregiver could get stuck behind at 3am is
  // its own hazard.
  const motzei = useMotzeiPrompt();

  return (
    <div className="mx-auto flex min-h-full max-w-2xl flex-col gap-4 p-4">
      <header className="flex items-center justify-between gap-3 print:hidden">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">MedGuard</h1>
          <PatientSwitcher />
        </div>
        <SyncStatusBadge />
      </header>

      <nav className="flex flex-wrap gap-2 print:hidden" aria-label="Sections">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={tab.id === activeTabId ? primaryButtonClass : buttonClass}
            aria-current={tab.id === activeTabId ? 'page' : undefined}
            onClick={() => setActiveTabId(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <RevokedDeviceBanner />
      <SafetyWarningBanner />

      <main>
        {motzei.show ? <ReconciliationSheet onDone={motzei.dismiss} /> : <ActiveScreen />}
      </main>
    </div>
  );
}

/** Nothing renders until a caregiver identifies themselves — see identity/CaregiverGate.tsx. */
export function App() {
  return (
    <CaregiverGate>
      <PatientProvider>
        <SyncProvider>
          <PushProvider>
            <AppShell />
          </PushProvider>
        </SyncProvider>
      </PatientProvider>
    </CaregiverGate>
  );
}
