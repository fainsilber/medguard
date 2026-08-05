import { useState } from 'react';
import { AndroidAppProvider } from './app/AndroidAppProvider.js';
import { getCaregiverName, setCaregiverName } from './runtime/caregiverName.js';
import { AndroidInventoryScreen } from './features/inventory/AndroidInventoryScreen.js';
import { AndroidMedicineScreen } from './features/medicines/AndroidMedicineScreen.js';
import { AndroidPrnScreen } from './features/prn/AndroidPrnScreen.js';
import { AndroidSettingsScreen } from './features/settings/AndroidSettingsScreen.js';
import { AndroidShabbatScreen } from './features/shabbat/AndroidShabbatScreen.js';
import { AndroidTodayView } from './features/today/AndroidTodayView.js';
import { M3Card, M3TopAppBar, m3ButtonPrimary, m3InputClass } from './ui/MaterialComponents.js';

type AndroidTab = 'today' | 'prn' | 'medicines' | 'inventory' | 'shabbat' | 'settings';

const TABS: readonly { id: AndroidTab; icon: string; label: string }[] = [
  { id: 'today', icon: '📅', label: 'Today' },
  { id: 'prn', icon: '🛡️', label: 'PRN' },
  { id: 'medicines', icon: '💊', label: 'Medicines' },
  { id: 'inventory', icon: '📦', label: 'Inventory' },
  { id: 'shabbat', icon: '🕯️', label: 'Shabbat' },
  { id: 'settings', icon: '⚙️', label: 'Device' },
];

/**
 * Asks who is using the device before anything can be recorded.
 *
 * Not a login — there is no password and nothing stops someone typing any name. It exists
 * because safety invariant 5 requires every log to record who and when, and a default name
 * baked into the app would attribute a 3am dose to whoever the default happens to be, which is
 * worse than no attribution at all: it reads as evidence.
 */
function CaregiverGate({ onChoose }: { onChoose: (name: string) => void }) {
  const [name, setName] = useState('');

  return (
    <div className="flex min-h-screen flex-col justify-center gap-4 bg-slate-950 p-6 text-slate-100">
      <h1 className="text-2xl font-bold tracking-tight">MedGuard</h1>
      <p className="text-sm text-slate-400">
        Who is using this device? Every dose you record is attributed to this name.
      </p>
      <M3Card>
        <label htmlFor="caregiver-gate-name" className="text-xs font-semibold text-slate-400">
          Your name
        </label>
        <input
          id="caregiver-gate-name"
          type="text"
          className={m3InputClass}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <button
          onClick={() => onChoose(name.trim())}
          disabled={!name.trim()}
          className={m3ButtonPrimary}
        >
          Continue
        </button>
      </M3Card>
    </div>
  );
}

export function App() {
  const [activeTab, setActiveTab] = useState<AndroidTab>('today');
  const [caregiver, setCaregiver] = useState<string | null>(() => getCaregiverName());

  const chooseCaregiver = (name: string) => {
    setCaregiverName(name);
    setCaregiver(name.trim());
  };

  if (!caregiver) {
    return <CaregiverGate onChoose={chooseCaregiver} />;
  }

  return (
    <AndroidAppProvider userId={caregiver}>
      <div className="flex h-full min-h-screen flex-col bg-slate-950 font-sans text-slate-100">
        <M3TopAppBar title="MedGuard" subtitle={`Caregiver: ${caregiver}`} />

        <main className="flex-1 overflow-y-auto">
          {activeTab === 'today' && <AndroidTodayView />}
          {activeTab === 'prn' && <AndroidPrnScreen />}
          {activeTab === 'medicines' && <AndroidMedicineScreen />}
          {activeTab === 'inventory' && <AndroidInventoryScreen />}
          {activeTab === 'shabbat' && <AndroidShabbatScreen />}
          {activeTab === 'settings' && (
            <AndroidSettingsScreen onChangeCaregiver={chooseCaregiver} />
          )}
        </main>

        <nav
          aria-label="Sections"
          className="fixed bottom-0 left-0 right-0 z-40 flex items-center justify-around border-t border-slate-800 bg-slate-950/95 py-2 backdrop-blur-md"
        >
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              aria-current={activeTab === tab.id ? 'page' : undefined}
              className={`flex min-h-[48px] flex-col items-center justify-center px-3 py-1 text-xs font-semibold ${
                activeTab === tab.id ? 'font-bold text-sky-400' : 'text-slate-400'
              }`}
            >
              <span aria-hidden="true">{tab.icon}</span>
              <span>{tab.label}</span>
            </button>
          ))}
        </nav>
      </div>
    </AndroidAppProvider>
  );
}
