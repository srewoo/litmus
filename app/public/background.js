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

// Version history is scoped per tab (chrome.storage.session key litmus:versions:<tabId>).
// When the tab closes, drop its history so it doesn't outlive the tab or leak into a
// future tab. Must stay in sync with VERSION_KEY_PREFIX in src/platform/sessionTabStore.ts.
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session
    .remove('litmus:versions:' + tabId)
    .catch((err) => console.error('[litmus] clear tab versions:', err));
});
