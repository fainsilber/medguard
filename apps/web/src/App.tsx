import { useState } from 'react';
import type { ComponentType } from 'react';
import { ExportScreen } from './features/export/ExportScreen.js';
import { HouseholdScreen } from './features/household/HouseholdScreen.js';
import { InventoryScreen } from './features/inventory/InventoryScreen.js';
import { MedicineList } from './features/medicines/MedicineList.js';
import { PrnScreen } from './features/prnDoses/PrnScreen.js';
import { TodayView } from './features/today/TodayView.js';
import { CaregiverGate } from './identity/CaregiverGate.js';
import { ProbePage } from './probe/ProbePage.js';
import { buttonClass, primaryButtonClass } from './ui/primitives.js';

interface TabDefinition {
  id: string;
  label: string;
  Screen: ComponentType;
}

/**
 * The Sprint 0 capability probe stays reachable rather than being deleted: it's still how the
 * Shabbat/alarm design in later sprints gets verified against real devices, not just the spec.
 */
const TABS: TabDefinition[] = [
  { id: 'today', label: 'Today', Screen: TodayView },
  { id: 'medicines', label: 'Medicines', Screen: MedicineList },
  { id: 'prn', label: 'As needed', Screen: PrnScreen },
  { id: 'inventory', label: 'Inventory', Screen: InventoryScreen },
  { id: 'export', label: 'Export', Screen: ExportScreen },
  { id: 'household', label: 'Household', Screen: HouseholdScreen },
  { id: 'diagnostics', label: 'Diagnostics', Screen: ProbePage },
];

function AppShell() {
  const [activeTabId, setActiveTabId] = useState(TABS[0]!.id);
  const activeTab = TABS.find((tab) => tab.id === activeTabId) ?? TABS[0]!;
  const ActiveScreen = activeTab.Screen;

  return (
    <div className="mx-auto flex min-h-full max-w-2xl flex-col gap-4 p-4">
      <header className="print:hidden">
        <h1 className="text-2xl font-semibold tracking-tight">MedGuard</h1>
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

      <main>
        <ActiveScreen />
      </main>
    </div>
  );
}

/** Nothing renders until a caregiver identifies themselves — see identity/CaregiverGate.tsx. */
export function App() {
  return (
    <CaregiverGate>
      <AppShell />
    </CaregiverGate>
  );
}
