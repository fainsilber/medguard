import { useEffect, useState } from 'react';
import { formatLogEntry } from '@medguard/shared';
import { clearAppLog, exportAppLogText, getAppLogEntries, onAppLogChange } from '../logging/appLog.js';
import { downloadTextFile } from '../ui/download.js';
import { buttonClass } from '../ui/primitives.js';

/**
 * Every sync and live-connection event recorded this session, exportable as a text file.
 *
 * This is what a caregiver reaches for instead of a screenshot when the sync badge gets stuck —
 * see apps/web/src/logging/appLog.ts for what actually gets recorded.
 */
export function AppLogSection() {
  const [entries, setEntries] = useState(getAppLogEntries);

  useEffect(() => onAppLogChange(() => setEntries(getAppLogEntries())), []);

  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');

  const handleExport = () => {
    downloadTextFile(exportAppLogText(), `medguard-app-log-${Date.now()}.txt`, 'text/plain;charset=utf-8');
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(exportAppLogText());
      setCopyStatus('copied');
    } catch {
      setCopyStatus('error');
    }
  };

  const isEmpty = entries.length === 0;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-slate-400">
        Every sync and live-connection event from this session — export it when something gets
        stuck, like a badge that stays on &ldquo;Syncing&hellip;&rdquo;.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={buttonClass} disabled={isEmpty} onClick={handleExport}>
          Export logs
        </button>
        <button type="button" className={buttonClass} disabled={isEmpty} onClick={() => void handleCopy()}>
          Copy logs
        </button>
        <button type="button" className={buttonClass} disabled={isEmpty} onClick={clearAppLog}>
          Clear
        </button>
        {copyStatus === 'copied' && <span className="text-safe text-sm">Copied.</span>}
        {copyStatus === 'error' && <span className="text-locked text-sm">Clipboard blocked.</span>}
        <span className="text-xs text-slate-500">{entries.length} entries</span>
      </div>
      {isEmpty ? (
        <p className="text-sm text-slate-400">Nothing logged yet.</p>
      ) : (
        <textarea
          readOnly
          aria-label="App log"
          className="h-40 w-full rounded-md bg-slate-900 p-2 font-mono text-xs"
          value={entries.map(formatLogEntry).join('\n')}
        />
      )}
    </div>
  );
}
