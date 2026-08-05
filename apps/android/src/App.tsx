import { useState } from 'react';
import { M3TopAppBar } from './ui/MaterialComponents.js';
import { AndroidTodayView } from './features/today/AndroidTodayView.js';
import { AndroidPrnScreen } from './features/prn/AndroidPrnScreen.js';
import { AndroidMedicineScreen } from './features/medicines/AndroidMedicineScreen.js';
import { AndroidInventoryScreen } from './features/inventory/AndroidInventoryScreen.js';
import { AndroidShabbatScreen } from './features/shabbat/AndroidShabbatScreen.js';
import { AndroidSettingsScreen } from './features/settings/AndroidSettingsScreen.js';

type AndroidTab = 'today' | 'prn' | 'medicines' | 'inventory' | 'shabbat' | 'settings';

export function App() {
  const [activeTab, setActiveTab] = useState<AndroidTab>('today');
  const [caregiverName, setCaregiverName] = useState(() => {
    return localStorage.getItem('medguard_android_caregiver_name') || 'Dad';
  });

  const handleUpdateCaregiver = (name: string) => {
    setCaregiverName(name);
    localStorage.setItem('medguard_android_caregiver_name', name);
  };

  return (
    <div className="flex h-full min-h-screen flex-col bg-slate-950 text-slate-100 font-sans">
      <M3TopAppBar
        title="MedGuard Android"
        subtitle={`Caregiver: ${caregiverName}`}
        actions={
          <span className="rounded-full bg-emerald-950 px-2.5 py-1 text-xs font-bold uppercase tracking-wider text-emerald-400 border border-emerald-500/30">
            FCM Active
          </span>
        }
      />

      <main className="flex-1 overflow-y-auto">
        {activeTab === 'today' && <AndroidTodayView caregiverName={caregiverName} />}
        {activeTab === 'prn' && <AndroidPrnScreen caregiverName={caregiverName} />}
        {activeTab === 'medicines' && <AndroidMedicineScreen />}
        {activeTab === 'inventory' && <AndroidInventoryScreen caregiverName={caregiverName} />}
        {activeTab === 'shabbat' && <AndroidShabbatScreen caregiverName={caregiverName} />}
        {activeTab === 'settings' && (
          <AndroidSettingsScreen
            caregiverName={caregiverName}
            setCaregiverName={handleUpdateCaregiver}
          />
        )}
      </main>

      {/* Material 3 Android Bottom Navigation Bar */}
      <nav className="fixed bottom-0 left-0 right-0 z-40 flex items-center justify-around border-t border-slate-800 bg-slate-950/95 py-2 backdrop-blur-md">
        <button
          onClick={() => setActiveTab('today')}
          className={`flex min-h-[48px] flex-col items-center justify-center px-3 py-1 text-xs font-semibold ${
            activeTab === 'today' ? 'text-sky-400 font-bold' : 'text-slate-400'
          }`}
        >
          <span>📅</span>
          <span>Today</span>
        </button>

        <button
          onClick={() => setActiveTab('prn')}
          className={`flex min-h-[48px] flex-col items-center justify-center px-3 py-1 text-xs font-semibold ${
            activeTab === 'prn' ? 'text-sky-400 font-bold' : 'text-slate-400'
          }`}
        >
          <span>🛡️</span>
          <span>PRN</span>
        </button>

        <button
          onClick={() => setActiveTab('medicines')}
          className={`flex min-h-[48px] flex-col items-center justify-center px-3 py-1 text-xs font-semibold ${
            activeTab === 'medicines' ? 'text-sky-400 font-bold' : 'text-slate-400'
          }`}
        >
          <span>💊</span>
          <span>Medicines</span>
        </button>

        <button
          onClick={() => setActiveTab('inventory')}
          className={`flex min-h-[48px] flex-col items-center justify-center px-3 py-1 text-xs font-semibold ${
            activeTab === 'inventory' ? 'text-sky-400 font-bold' : 'text-slate-400'
          }`}
        >
          <span>📦</span>
          <span>Inventory</span>
        </button>

        <button
          onClick={() => setActiveTab('shabbat')}
          className={`flex min-h-[48px] flex-col items-center justify-center px-3 py-1 text-xs font-semibold ${
            activeTab === 'shabbat' ? 'text-sky-400 font-bold' : 'text-slate-400'
          }`}
        >
          <span>🕯️</span>
          <span>Shabbat</span>
        </button>

        <button
          onClick={() => setActiveTab('settings')}
          className={`flex min-h-[48px] flex-col items-center justify-center px-3 py-1 text-xs font-semibold ${
            activeTab === 'settings' ? 'text-sky-400 font-bold' : 'text-slate-400'
          }`}
        >
          <span>⚙️</span>
          <span>Device</span>
        </button>
      </nav>
    </div>
  );
}
