import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appLog,
  clearAppLog,
  exportAppLogText,
  getAppLogEntries,
  onAppLogChange,
} from './appLog.js';

describe('appLog', () => {
  beforeEach(() => {
    clearAppLog();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records entries tagged with their scope and level', () => {
    appLog('sync').info('pull complete', { records: 2 });

    const [entry] = getAppLogEntries();
    expect(entry).toMatchObject({ level: 'info', scope: 'sync', message: 'pull complete', data: { records: 2 } });
    expect(typeof entry?.timestamp).toBe('string');
  });

  it('notifies subscribers whenever a new entry is recorded', () => {
    const listener = vi.fn();
    const unsubscribe = onAppLogChange(listener);

    appLog('sync').debug('draining outbox');
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    appLog('sync').debug('draining outbox again');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('clears every recorded entry and notifies subscribers', () => {
    appLog('sync').info('pull complete');
    const listener = vi.fn();
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
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    appLog('sync').debug('quiet');
    appLog('sync').info('quiet too');
    appLog('sync').warn('loud');
    appLog('sync').error('loudest');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();
  });
});
