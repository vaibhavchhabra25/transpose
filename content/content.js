// content/content.js  —  isolated world
// Only job: relay chrome.runtime messages from the popup into CustomEvents
// that injected.js (MAIN world) can hear, and relay responses back.
// Never touches audio elements directly — all audio lives in MAIN world.

document.documentElement.dataset.processorUrl = chrome.runtime.getURL('content/pitch-processor.js');

(function () {
  'use strict';

  // ── popup → injected.js ───────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

    if (msg.type === 'SET_SEMITONES') {
      // 1. Listen for state reply BEFORE dispatching (avoid race)
      const onState = (e) => {
        document.removeEventListener('__pitchshift:state', onState);
        sendResponse({ ok: true, hookedCount: e.detail.hookedCount, mediaCount: e.detail.hookedCount });
      };
      document.addEventListener('__pitchshift:state', onState);

      // 2. Send command to MAIN world
      document.dispatchEvent(new CustomEvent('__pitchshift:set', {
        detail: { semitones: msg.semitones },
      }));

      // Fallback: if injected.js doesn't reply in 800ms, respond anyway
      setTimeout(() => {
        document.removeEventListener('__pitchshift:state', onState);
        sendResponse({ ok: true, hookedCount: 0, mediaCount: 0 });
      }, 800);

      return true; // keep message channel open for async sendResponse
    }

    if (msg.type === 'GET_STATE') {
      const onState = (e) => {
        document.removeEventListener('__pitchshift:state', onState);
        sendResponse({ ok: true, hookedCount: e.detail.hookedCount, mediaCount: e.detail.hookedCount });
      };
      document.addEventListener('__pitchshift:state', onState);
      document.dispatchEvent(new CustomEvent('__pitchshift:getstate'));

      setTimeout(() => {
        document.removeEventListener('__pitchshift:state', onState);
        sendResponse({ ok: true, hookedCount: 0, mediaCount: 0 });
      }, 800);

      return true;
    }
  });

  console.info('[PitchShift] Content script ready.');
})();