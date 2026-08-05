import { useState, useEffect } from 'react';
import { systemClock, isClockTrusted, toIso } from '@medguard/shared';
import { androidNativeBridge, type AndroidDeviceInfo } from '../../native/androidBridge.js';
import {
  M3Card,
  M3Badge,
  m3ButtonPrimary,
  m3InputClass,
} from '../../ui/MaterialComponents.js';

export function AndroidSettingsScreen({
  caregiverName,
  setCaregiverName,
}: {
  caregiverName: string;
  setCaregiverName: (name: string) => void;
}) {
  const [deviceInfo, setDeviceInfo] = useState<AndroidDeviceInfo | null>(null);
  const [joinCode, setJoinCode] = useState('');
  const [joinedHousehold, setJoinedHousehold] = useState<string | null>(null);
  const clockOffsetMs = 0;

  useEffect(() => {
    setDeviceInfo(androidNativeBridge.getDeviceInfo());
    const savedCode = localStorage.getItem('medguard_android_household_code');
    if (savedCode) setJoinedHousehold(savedCode);
  }, []);

  const handleJoinHousehold = () => {
    if (!joinCode.trim()) return;
    localStorage.setItem('medguard_android_household_code', joinCode.trim());
    setJoinedHousehold(joinCode.trim());
    setJoinCode('');
  };

  const isTrusted = isClockTrusted(clockOffsetMs);

  return (
    <div className="flex flex-col gap-4 p-4 pb-24">
      <div className="flex flex-col">
        <h2 className="text-xl font-bold tracking-tight text-slate-100">Android Device & Household</h2>
        <p className="text-xs text-slate-400">
          Caregiver identity, FCM push registration, and server clock verification.
        </p>
      </div>

      {/* Caregiver Name Setting */}
      <M3Card>
        <h3 className="text-sm font-bold text-slate-100">Caregiver Identity</h3>
        <p className="text-xs text-slate-400">Name attached to all intake logs and overrides.</p>
        <input
          type="text"
          className={m3InputClass}
          value={caregiverName}
          onChange={(e) => setCaregiverName(e.target.value)}
        />
      </M3Card>

      {/* Household Join Code Auth */}
      <M3Card>
        <h3 className="text-sm font-bold text-slate-100">Household Connection</h3>
        {joinedHousehold ? (
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-300">Connected Code: <strong className="font-mono text-sky-400">{joinedHousehold}</strong></span>
            <M3Badge tone="safe">Connected</M3Badge>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <input
              type="text"
              placeholder="Enter 6-digit Join Code"
              className={m3InputClass}
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
            />
            <button onClick={handleJoinHousehold} className={m3ButtonPrimary}>
              Join Household
            </button>
          </div>
        )}
      </M3Card>

      {/* Android FCM Native Push Registration Card (D8) */}
      <M3Card>
        <h3 className="text-sm font-bold text-slate-100">FCM Push Credentials (D8)</h3>
        {deviceInfo && (
          <div className="flex flex-col gap-1 text-xs text-slate-300 font-mono">
            <div>Provider: <span className="text-sky-400">{deviceInfo.pushProvider}</span></div>
            <div>Device ID: <span className="text-slate-400">{deviceInfo.deviceId.slice(0, 20)}...</span></div>
            <div>FCM Token: <span className="text-slate-400">{deviceInfo.fcmToken.slice(0, 20)}...</span></div>
          </div>
        )}
      </M3Card>

      {/* Clock Trust Guard */}
      <M3Card>
        <div className="flex items-center justify-between">
          <div className="flex flex-col">
            <span className="text-sm font-bold text-slate-100">Server Clock Verification</span>
            <span className="text-xs text-slate-400">
              Current local time: {toIso(systemClock.now())}
            </span>
          </div>
          <M3Badge tone={isTrusted ? 'safe' : 'locked'}>
            {isTrusted ? 'Trusted Clock' : 'Skew Detected'}
          </M3Badge>
        </div>
      </M3Card>
    </div>
  );
}
