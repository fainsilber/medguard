import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

/**
 * Writes `content` to a file in the app's cache directory and hands it to the OS share sheet —
 * the Android replacement for web's browser download (`apps/web/src/ui/download.ts`'s
 * `downloadTextFile`). Android has no direct equivalent of a browser "Save As" dialog outside of
 * the Storage Access Framework; the share sheet (whose targets typically include "Save to
 * Drive"/"Save to Files") covers the same need with one mechanism, reused here for both the CSV
 * export and the JSON backup export.
 *
 * Deliberately does not replicate web's "Print summary" button — there is no Android equivalent
 * of `window.print()`, and nothing on this device to print to.
 */
export async function shareTextFile(content: string, filename: string, mimeType: string): Promise<void> {
  const cacheDir = FileSystem.cacheDirectory;
  if (!cacheDir) {
    throw new Error('No cache directory is available on this device.');
  }

  const fileUri = `${cacheDir}${filename}`;
  await FileSystem.writeAsStringAsync(fileUri, content);

  const canShare = await Sharing.isAvailableAsync();
  if (!canShare) {
    throw new Error('Sharing is not available on this device.');
  }
  await Sharing.shareAsync(fileUri, { mimeType, dialogTitle: `Share ${filename}` });
}
