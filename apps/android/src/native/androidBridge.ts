import { currentPlatform } from '../runtime/platform.js';
import type { AndroidPlatform } from '../runtime/platform.js';

/**
 * The seam between the web layer and Android.
 *
 * Everything here is honest about which side of that seam it is on. Nothing fabricates a
 * capability the running environment does not have: safety invariant 6 requires degradation to
 * be *visible*, and a screen reporting a push channel as live when no native plugin has ever
 * returned a token is the exact opposite of that.
 */

/**
 * Notification channel ids, versioned per `docs/android-client-plan.md` ("Channels").
 *
 * A channel's sound and importance are immutable once created, so retuning the Shabbat chime
 * the way the web burst was retuned four times would otherwise require every caregiver to
 * reinstall the app. The suffix is bumped instead.
 */
export const NOTIFICATION_CHANNELS = [
  'dose_standard_v1',
  'dose_escalation_v1',
  'shabbat_v1',
  'low_stock_v1',
  'sync_status_v1',
] as const;

export type NotificationChannelId = (typeof NOTIFICATION_CHANNELS)[number];

export interface AndroidDeviceInfo {
  deviceId: string;
  platform: AndroidPlatform;
  /**
   * Null until a native messaging plugin supplies a real token. Never invented: a synthetic
   * token registered against `devices.push_credentials` would make the server believe it can
   * reach a phone it cannot, and dose escalations would be delivered into a void.
   */
  fcmToken: string | null;
  pushProvider: 'fcm' | 'none';
}

/**
 * The audio side of the chime, isolated so the engine's timing can be tested without Web Audio.
 * `close` is idempotent.
 */
export interface ChimeAudio {
  pulse(): void;
  close(): void;
}

type AudioContextConstructor = new () => AudioContext;

function resolveAudioContextConstructor(): AudioContextConstructor | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  const legacy = (window as unknown as { webkitAudioContext?: AudioContextConstructor })
    .webkitAudioContext;
  return window.AudioContext ?? legacy;
}

/**
 * A two-note chime on the Web Audio API, or `null` where Web Audio is unavailable.
 *
 * An approximation, and documented as one. The PRD's 45-second auto-stopping chime on a *locked*
 * phone is a native concern — `DoseAlarmService` with `AudioAttributes.USAGE_ALARM`, per
 * `docs/android-client-plan.md`. A WebView is suspended when backgrounded, so this only ever
 * sounds while the app is in the foreground.
 */
export function webAudioChime(): ChimeAudio | null {
  const AudioCtx = resolveAudioContextConstructor();
  if (!AudioCtx) {
    return null;
  }

  let context: AudioContext | null = new AudioCtx();

  return {
    pulse() {
      if (!context || context.state === 'closed') {
        return;
      }
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(523.25, context.currentTime); // C5
      oscillator.frequency.exponentialRampToValueAtTime(659.25, context.currentTime + 0.4); // E5
      gain.gain.setValueAtTime(0.3, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, context.currentTime + 0.8);

      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.8);
    },
    close() {
      const closing = context;
      context = null;
      void closing?.close().catch(() => {});
    },
  };
}

const PULSE_INTERVAL_MS = 3_000;

/**
 * The chime's state machine: start, repeat every few seconds, stop by itself after the
 * configured duration.
 *
 * The auto-stop is the whole point (PRD §3 — the chime ends without anyone touching the phone),
 * so the timer that ends it is armed *before* any audio is attempted and runs identically
 * whether or not audio is available. Stopping cancels both timers immediately rather than
 * leaving the repeat tick to discover on its next pass that it should have stopped.
 */
export class ShabbatChimeEngine {
  private playing = false;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private pulseTimer: ReturnType<typeof setInterval> | null = null;
  private audio: ChimeAudio | null = null;

  constructor(private readonly createAudio: () => ChimeAudio | null = webAudioChime) {}

  /** Returns false when a chime is already sounding, so a second alert cannot stack on it. */
  start(durationSeconds: number, onComplete?: () => void): boolean {
    if (this.playing) {
      return false;
    }
    this.playing = true;

    this.stopTimer = setTimeout(() => {
      this.stop();
      onComplete?.();
    }, durationSeconds * 1000);

    try {
      this.audio = this.createAudio();
    } catch {
      // An environment with an AudioContext constructor that refuses to build one (no output
      // device, an autoplay policy) still gets the timed, silent chime rather than a dead screen.
      this.audio = null;
    }

    if (this.audio) {
      const audio = this.audio;
      audio.pulse();
      this.pulseTimer = setInterval(() => audio.pulse(), PULSE_INTERVAL_MS);
    }

    return true;
  }

  stop(): void {
    this.playing = false;

    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    if (this.pulseTimer) {
      clearInterval(this.pulseTimer);
      this.pulseTimer = null;
    }
    this.audio?.close();
    this.audio = null;
  }

  isPlaying(): boolean {
    return this.playing;
  }
}

/**
 * What the app can actually do on the device it is running on right now.
 *
 * `channelsCreated` is false everywhere because notification channels are an Android construct
 * that needs a native plugin to create; reporting them as created would be a claim the Settings
 * screen then repeats to a caregiver who is relying on it to wake them at 3am.
 */
export interface AndroidCapabilities {
  platform: AndroidPlatform;
  channelsCreated: boolean;
  channels: readonly NotificationChannelId[];
  /** Foreground-only Web Audio, as opposed to the native alarm-stream service. */
  chime: 'web-audio-foreground-only' | 'unavailable';
  pushRegistered: boolean;
}

export function describeCapabilities(deviceInfo: AndroidDeviceInfo): AndroidCapabilities {
  return {
    platform: deviceInfo.platform,
    channelsCreated: false,
    channels: NOTIFICATION_CHANNELS,
    chime: resolveAudioContextConstructor() ? 'web-audio-foreground-only' : 'unavailable',
    pushRegistered: deviceInfo.fcmToken !== null,
  };
}

export function getDeviceInfo(deviceId: string): AndroidDeviceInfo {
  return {
    deviceId,
    platform: currentPlatform(),
    fcmToken: null,
    pushProvider: 'none',
  };
}
