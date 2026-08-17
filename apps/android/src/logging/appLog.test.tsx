import {
  appLog,
  clearAppLog,
  exportAppLogText,
  getAppLogEntries,
  onAppLogChange,
} from './appLog.js';

/**
 * RN port of `apps/web/src/logging/appLog.test.ts`. `.test.tsx` despite no JSX and no direct
 * native import: `appLog.ts` takes its timestamp from `runtime/deviceRuntime.ts`'s `deviceClock`
 * (per the file's own doc comment — not exempt from the no-ambient-time rule the way web's
 * version is), which transitively reaches `expo-crypto` — enough to require Jest's mocks, per
 * `jest.config.js`'s convention.
 */

beforeEach(() => {
  clearAppLog();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('appLog', () => {
  it('records entries tagged with their scope and level', () => {
    appLog('sync').info('pull complete', { records: 2 });

    const [entry] = getAppLogEntries();
    expect(entry).toMatchObject({ level: 'info', scope: 'sync', message: 'pull complete', data: { records: 2 } });
    expect(typeof entry?.timestamp).toBe('string');
  });

  it('notifies subscribers whenever a new entry is recorded', () => {
    const listener = jest.fn();
    const unsubscribe = onAppLogChange(listener);

    appLog('sync').debug('draining outbox');
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    appLog('sync').debug('draining outbox again');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('clears every recorded entry and notifies subscribers', () => {
    appLog('sync').info('pull complete');
    const listener = jest.fn();
    onAppLogChange(listener);

    clearAppLog();

    expect(getAppLogEntries()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('exports the recorded entries as text, one per line', () => {
    appLog('sync').info('first');
    appLog('live').warn('second');

    const text = exportAppLogText();
    expect(text.split('\n')).toHaveLength(2);
    expect(text).toContain('sync: first');
    expect(text).toContain('live: second');
  });

  it('mirrors warn and error entries to the console, but not debug or info', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    appLog('sync').debug('quiet');
    appLog('sync').info('quiet too');
    appLog('sync').warn('loud');
    appLog('sync').error('loudest');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();
  });
});
