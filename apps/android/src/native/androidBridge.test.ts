import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NOTIFICATION_CHANNELS,
  ShabbatChimeEngine,
  describeCapabilities,
  getDeviceInfo,
  webAudioChime,
} from './androidBridge.js';
import type { ChimeAudio } from './androidBridge.js';

function recordingAudio(): ChimeAudio & { pulses: number; closed: number } {
  return {
    pulses: 0,
    closed: 0,
    pulse() {
      this.pulses += 1;
    },
    close() {
      this.closed += 1;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ShabbatChimeEngine', () => {
  it('stops on its own after the configured duration', () => {
    // The whole point of the chime (PRD §3): it ends without anyone touching the phone.
    const audio = recordingAudio();
    const engine = new ShabbatChimeEngine(() => audio);
    const onComplete = vi.fn();

    expect(engine.start(45, onComplete)).toBe(true);
    expect(engine.isPlaying()).toBe(true);

    vi.advanceTimersByTime(45_000);

    expect(engine.isPlaying()).toBe(false);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('still auto-stops when no audio is available at all', () => {
    // jsdom has no Web Audio, and neither do some WebViews. A chime that cannot make a sound
    // must still end — otherwise `isPlaying` stays true forever and every later chime is refused.
    const engine = new ShabbatChimeEngine(() => null);
    const onComplete = vi.fn();

    engine.start(45, onComplete);
    vi.advanceTimersByTime(45_000);

    expect(engine.isPlaying()).toBe(false);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('auto-stops when building the audio context throws', () => {
    const engine = new ShabbatChimeEngine(() => {
      throw new Error('no output device');
    });
    const onComplete = vi.fn();

    expect(engine.start(10, onComplete)).toBe(true);
    vi.advanceTimersByTime(10_000);

    expect(engine.isPlaying()).toBe(false);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('repeats the tone while it is sounding', () => {
    const audio = recordingAudio();
    const engine = new ShabbatChimeEngine(() => audio);

    engine.start(45);
    expect(audio.pulses).toBe(1); // immediately, not after the first interval

    vi.advanceTimersByTime(9_000);
    expect(audio.pulses).toBe(4);

    engine.stop();
  });

  it('emits no further tones once stopped', () => {
    const audio = recordingAudio();
    const engine = new ShabbatChimeEngine(() => audio);

    engine.start(45);
    engine.stop();
    const after = audio.pulses;

    vi.advanceTimersByTime(60_000);

    expect(audio.pulses).toBe(after);
    expect(audio.closed).toBe(1);
  });

  it('does not fire onComplete for a chime that was stopped by hand', () => {
    const engine = new ShabbatChimeEngine(() => recordingAudio());
    const onComplete = vi.fn();

    engine.start(45, onComplete);
    engine.stop();
    vi.advanceTimersByTime(60_000);

    expect(onComplete).not.toHaveBeenCalled();
  });

  it('refuses to start a second chime on top of a sounding one', () => {
    const engine = new ShabbatChimeEngine(() => recordingAudio());

    expect(engine.start(45)).toBe(true);
    expect(engine.start(45)).toBe(false);

    engine.stop();
    expect(engine.start(45)).toBe(true);
    engine.stop();
  });

  it('is safe to stop when nothing is playing', () => {
    const engine = new ShabbatChimeEngine(() => recordingAudio());
    expect(() => engine.stop()).not.toThrow();
    expect(engine.isPlaying()).toBe(false);
  });
});

describe('webAudioChime', () => {
  it('returns null where the platform has no Web Audio', () => {
    // jsdom provides no AudioContext, which is exactly the degraded case the engine handles.
    expect(webAudioChime()).toBeNull();
  });

  it('drives an oscillator through a gain node when Web Audio exists', () => {
    const oscillator = {
      type: '',
      frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    const gain = {
      gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
    };
    const close = vi.fn().mockResolvedValue(undefined);

    vi.stubGlobal(
      'AudioContext',
      class {
        state = 'running';
        currentTime = 0;
        destination = {};
        createOscillator = () => oscillator;
        createGain = () => gain;
        close = close;
      },
    );

    const audio = webAudioChime();
    expect(audio).not.toBeNull();

    audio?.pulse();
    expect(oscillator.start).toHaveBeenCalledTimes(1);
    expect(gain.connect).toHaveBeenCalledTimes(1);

    audio?.close();
    expect(close).toHaveBeenCalledTimes(1);

    // Closing releases the context, so a late pulse is a no-op rather than a crash.
    audio?.pulse();
    expect(oscillator.start).toHaveBeenCalledTimes(1);
  });
});

describe('device info', () => {
  it('reports no push token rather than inventing one', () => {
    // A synthetic token would make the server believe it can reach a phone it cannot, and dose
    // escalations would be delivered into a void.
    const info = getDeviceInfo('device-1');

    expect(info.deviceId).toBe('device-1');
    expect(info.fcmToken).toBeNull();
    expect(info.pushProvider).toBe('none');
  });

  it('reports the browser platform when not running in the Android WebView', () => {
    expect(getDeviceInfo('device-1').platform).toBe('web');
  });
});

describe('describeCapabilities', () => {
  it('does not claim notification channels or push that nothing has created', () => {
    const capabilities = describeCapabilities(getDeviceInfo('device-1'));

    expect(capabilities.channelsCreated).toBe(false);
    expect(capabilities.pushRegistered).toBe(false);
    expect(capabilities.channels).toEqual(NOTIFICATION_CHANNELS);
  });

  it('reports the chime as foreground-only where Web Audio exists', () => {
    vi.stubGlobal('AudioContext', class {});
    expect(describeCapabilities(getDeviceInfo('d')).chime).toBe('web-audio-foreground-only');
  });

  it('reports the chime as unavailable where it does not', () => {
    expect(describeCapabilities(getDeviceInfo('d')).chime).toBe('unavailable');
  });

  it('reports push as registered once a token exists', () => {
    const capabilities = describeCapabilities({
      deviceId: 'd',
      platform: 'android',
      fcmToken: 'real-token',
      pushProvider: 'fcm',
    });
    expect(capabilities.pushRegistered).toBe(true);
  });

  it('versions every channel id, so a retuned sound does not need a reinstall', () => {
    expect(NOTIFICATION_CHANNELS.every((id) => /_v\d+$/.test(id))).toBe(true);
  });
});
