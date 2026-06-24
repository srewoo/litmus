/** chrome.storage.local adapter (browser-only; exercised in-extension). */
import type { StorageArea } from './storage';

export function chromeLocal(): StorageArea {
  return {
    get: (keys) => chrome.storage.local.get(keys),
    set: (items) => chrome.storage.local.set(items),
    remove: (keys) => chrome.storage.local.remove(keys),
  };
}

/**
 * chrome.storage.session adapter. In-memory store that survives the side panel
 * closing/reopening within a browser session and is cleared when the browser
 * shuts down — the right place for session-scoped caches (eval prompt + cases)
 * we don't want to regenerate, but also don't want to keep forever.
 */
export function chromeSession(): StorageArea {
  return {
    get: (keys) => chrome.storage.session.get(keys),
    set: (items) => chrome.storage.session.set(items),
    remove: (keys) => chrome.storage.session.remove(keys),
  };
}
