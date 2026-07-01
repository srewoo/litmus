// litmus background service worker (MV3).
// Open the side panel ONLY in the tab where the toolbar icon was clicked —
// not globally across every tab. Default is disabled; clicking enables + opens
// the panel for that specific tab.

function disableByDefault() {
  // No tabId → sets the default for tabs that don't have their own options.
  chrome.sidePanel.setOptions({ enabled: false }).catch((err) => console.error('[litmus] default disable:', err));
}

chrome.runtime.onInstalled.addListener(disableByDefault);
chrome.runtime.onStartup.addListener(disableByDefault);

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id === undefined) return;
  try {
    await chrome.sidePanel.setOptions({ tabId: tab.id, path: 'sidepanel.html', enabled: true });
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (err) {
    console.error('[litmus] open side panel:', err);
  }
});

// Version history is now DURABLE (ADR 0004): it lives under a single stable key
// in chrome.storage.local (litmus:versions:default) and intentionally survives
// tab close and browser restart, so the iterate-and-compare loop persists across
// sessions. There is therefore no per-tab cleanup here.
//
// Legacy hygiene: older builds wrote per-tab keys to chrome.storage.session; if
// any linger, drop them on tab close so they don't accumulate. (No effect on the
// durable local namespace.)
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session
    .remove('litmus:versions:' + tabId)
    .catch((err) => console.error('[litmus] clear legacy tab versions:', err));
});
