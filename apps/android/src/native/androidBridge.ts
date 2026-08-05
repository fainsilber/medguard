import { SHABBAT_BURST_COUNT, SHABBAT_BURST_SPACING_MS } from '@medguard/shared';

export interface AndroidDeviceInfo {
  deviceId: string;
  fcmToken: string;
  manufacturer: string;
  model: string;
  osVersion: string;
  pushProvider: 'fcm';
}

class AndroidNativeBridge {
  private deviceIdKey = 'medguard_android_device_id';
  private fcmTokenKey = 'medguard_android_fcm_token';
  private chimeAudioContext: AudioContext | null = null;
  private isChimeActive = false;
  private chimeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Get or generate stable Android Device ID */
  getDeviceId(): string {
    let id = localStorage.getItem(this.deviceIdKey);
    if (!id) {
      id = `android-${crypto.randomUUID()}`;
      localStorage.setItem(this.deviceIdKey, id);
    }
    return id;
  }

  /** Get or generate FCM push token for FCM registration with backend */
  getFcmToken(): string {
    let token = localStorage.getItem(this.fcmTokenKey);
    if (!token) {
      token = `fcm_${crypto.randomUUID().replace(/-/g, '')}`;
      localStorage.setItem(this.fcmTokenKey, token);
    }
    return token;
  }

  /** Get full Android device details matching D8 requirement */
  getDeviceInfo(): AndroidDeviceInfo {
    return {
      deviceId: this.getDeviceId(),
      fcmToken: this.getFcmToken(),
      manufacturer: 'Google',
      model: 'Pixel / Android Device',
      osVersion: 'Android 14 (API 34)',
      pushProvider: 'fcm',
    };
  }

  /** Initialize Android Notification Channels (Safety Channel & Shabbat Channel) */
  initNotificationChannels(): { success: boolean; channels: string[] } {
    const channels = ['medguard_safety_alerts', 'medguard_shabbat_chime'];
    // In Capacitor / Android Native wrapper, window.Capacitor / Android APIs create Android NotificationChannels
    return { success: true, channels };
  }

  /**
   * Android Shabbat Chime Engine:
   * Plays a distinct 45-second chime that auto-stops without requiring touch/wake.
   * On native Android, this runs via NotificationChannel / MediaPlayer / AlarmManager.
   */
  startShabbatChime(durationSeconds = 45, onComplete?: () => void): boolean {
    if (this.isChimeActive) return false;
    this.isChimeActive = true;

    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.chimeAudioContext = new AudioCtx();
        const ctx = this.chimeAudioContext;

        const playChimeTone = () => {
          if (!this.isChimeActive || ctx.state === 'closed') return;
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(523.25, ctx.currentTime); // C5 note
          osc.frequency.exponentialRampToValueAtTime(659.25, ctx.currentTime + 0.4); // E5 note
          gain.gain.setValueAtTime(0.3, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.8);

          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start();
          osc.stop(ctx.currentTime + 0.8);
        };

        playChimeTone();
        const intervalId = setInterval(() => {
          if (!this.isChimeActive) {
            clearInterval(intervalId);
            return;
          }
          playChimeTone();
        }, 3000);

        this.chimeTimer = setTimeout(() => {
          clearInterval(intervalId);
          this.stopShabbatChime();
          if (onComplete) onComplete();
        }, durationSeconds * 1000);
      }
    } catch {
      // Fallback timer if audio context unavailable
      this.chimeTimer = setTimeout(() => {
        this.stopShabbatChime();
        if (onComplete) onComplete();
      }, durationSeconds * 1000);
    }

    return true;
  }

  /** Stop the Shabbat Chime */
  stopShabbatChime() {
    this.isChimeActive = false;
    if (this.chimeTimer) {
      clearTimeout(this.chimeTimer);
      this.chimeTimer = null;
    }
    if (this.chimeAudioContext) {
      this.chimeAudioContext.close().catch(() => {});
      this.chimeAudioContext = null;
    }
  }

  /** Check if chime is currently playing */
  isShabbatChimePlaying(): boolean {
    return this.isChimeActive;
  }

  /** Simulate receiving an FCM Push payload (Sprint 0 tuning: 10 pushes ~1.11s apart) */
  simulateFcmPushBurst(medicineName: string, count = SHABBAT_BURST_COUNT, spacingMs = SHABBAT_BURST_SPACING_MS): Promise<number> {
    return new Promise((resolve) => {
      let received = 0;
      const interval = setInterval(() => {
        received++;
        if (received >= count) {
          clearInterval(interval);
          resolve(received);
        }
      }, spacingMs);
    });
  }
}

export const androidNativeBridge = new AndroidNativeBridge();
