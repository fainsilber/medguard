/**
 * Jest mock for `expo-sharing` (mapped in `jest.config.js`) — the real module launches the OS
 * share sheet, with no headless equivalent under Jest. `shareAsync`'s calls are what a test reads
 * back to find the uri `shareTextFile.ts` wrote the export to (see `mockExpoFileSystem.ts`'s
 * `readSeededFile`) — the same role `capturedBlob` plays in web's `BackupRestoreCard.test.tsx`.
 */
export const isAvailableAsync = jest.fn().mockResolvedValue(true);
export const shareAsync = jest.fn().mockResolvedValue(undefined);
