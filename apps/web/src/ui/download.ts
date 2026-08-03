/**
 * Triggers a browser download of already-generated text — not a fetch from anywhere, so there's
 * nothing here to confirm: the caregiver just asked for exactly this file.
 */
export function downloadTextFile(content: string, filename: string, mimeType: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
