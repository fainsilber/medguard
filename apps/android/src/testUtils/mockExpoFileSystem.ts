/**
 * Jest mock for `expo-file-system/legacy` (mapped in `jest.config.js`) — the real module writes to
 * the device's real cache directory, with no headless equivalent under Jest. Backed by an
 * in-memory `Map` keyed by uri, scoped to one test file's run: `writeAsStringAsync` (the export
 * path, via `shareTextFile.ts`) and `readAsStringAsync` (the import path, via
 * `BackupRestoreCard.ts`'s picked-file read) share it, so a test can write through one and read
 * back through the other exactly like the real filesystem would.
 */
const files = new Map<string, string>();

export const cacheDirectory = 'mock-cache://';

export const writeAsStringAsync = jest.fn(async (uri: string, content: string): Promise<void> => {
  files.set(uri, content);
});

export const readAsStringAsync = jest.fn(async (uri: string): Promise<string> => {
  const content = files.get(uri);
  if (content === undefined) {
    throw new Error(`mockExpoFileSystem: no file at ${uri}`);
  }
  return content;
});

/** Pre-seeds a file before a component under test picks it — stands in for a document already
 * sitting wherever the OS file picker would have pointed at. */
export function seedFile(uri: string, content: string): void {
  files.set(uri, content);
}

/** Reads back what `writeAsStringAsync` wrote, for asserting on an exported file's content. */
export function readSeededFile(uri: string): string | undefined {
  return files.get(uri);
}
