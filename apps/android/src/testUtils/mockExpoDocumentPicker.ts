/**
 * Jest mock for `expo-document-picker` (mapped in `jest.config.js`) — the real module launches a
 * native file picker UI, with no headless equivalent under Jest. Defaults to a cancelled pick, the
 * harmless default every other mock in this directory follows; a test that cares about a specific
 * file overrides it with `.mockResolvedValueOnce(...)`.
 */
export const getDocumentAsync = jest.fn().mockResolvedValue({ canceled: true, assets: [] });
