// background/service-worker.js
// Relay messages between popup and active tab's content script

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Relay pitch change from popup → content script
  if (message.type === 'RELAY_TO_CONTENT') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]?.id) return sendResponse({ error: 'No active tab' });
      chrome.tabs.sendMessage(tabs[0].id, message.payload, (response) => {
        sendResponse(response || { error: chrome.runtime.lastError?.message });
      });
    });
    return true; // keep channel open for async response
  }
});
