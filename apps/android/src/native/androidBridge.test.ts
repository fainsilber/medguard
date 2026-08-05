import { describe, it, expect } from 'vitest';
import { androidNativeBridge } from './androidBridge.js';

describe('AndroidNativeBridge', () => {
  it('generates a valid Android device ID and FCM token', () => {
    const info = androidNativeBridge.getDeviceInfo();
    expect(info.deviceId).toContain('android-');
    expect(info.fcmToken).toContain('fcm_');
    expect(info.pushProvider).toBe('fcm');
  });

  it('initializes notification channels for safety and shabbat', () => {
    const res = androidNativeBridge.initNotificationChannels();
    expect(res.success).toBe(true);
    expect(res.channels).toContain('medguard_safety_alerts');
    expect(res.channels).toContain('medguard_shabbat_chime');
  });

  it('simulates FCM push burst according to shared push parameters', async () => {
    const result = await androidNativeBridge.simulateFcmPushBurst('Ondansetron', 3, 10);
    expect(result).toBe(3);
  });
});
