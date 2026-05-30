// content/content.js  —  isolated world

document.documentElement.dataset.processorUrl = chrome.runtime.getURL('content/pitch-processor.js');

(function () {
  'use strict';
  const host = window.location.hostname;

  // Auto-load saved pitch
  if (chrome.storage && chrome.storage.local) {
    chrome.storage.local.get([`pitch_${host}`, `formants_${host}`], (res) => {
      const savedPitch = res[`pitch_${host}`] || 0;
      const savedFormants = res[`formants_${host}`] || 0;
      if (savedPitch !== 0 || savedFormants !== 0) {
        setTimeout(() => {
          document.dispatchEvent(new CustomEvent('__pitchshift:set', {
            detail: { semitones: savedPitch, formants: savedFormants }
          }));
        }, 200);
      }
    });
  }

  // Save pitch changes
  document.addEventListener('__pitchshift:save', (e) => {
    if (chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({
        [`pitch_${host}`]: e.detail.semitones,
        [`formants_${host}`]: e.detail.formants
      });
    }
  });

  // Relay Popup <--> Injected World
  // Messages arrive here already unwrapped by the service worker (inner payload only).
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const action = msg.type;

    if (action === 'SET_SEMITONES') {
      const semitones = msg.semitones;
      const formants = msg.formants;

      document.dispatchEvent(new CustomEvent('__pitchshift:set', {
        detail: { semitones: semitones, formants: formants },
      }));

      chrome.storage.local.set({
        [`pitch_${host}`]: semitones,
        [`formants_${host}`]: formants
      });

      sendResponse({ ok: true });
      return false;
    }

    if (action === 'GET_STATE') {
      // 🚀 THE FIX: The Locked Async Bridge
      const onState = (e) => {
        document.removeEventListener('__pitchshift:state', onState);
        sendResponse({
          ok: true,
          hookedCount: e.detail.hookedCount,
          semitones: e.detail.semitones,
          formants: e.detail.formants,
          baseKey: e.detail.baseKey,
          baseMode: e.detail.baseMode,
        });
      };

      // 1. Start listening for the answer
      document.addEventListener('__pitchshift:state', onState);

      // 2. Ask the engine for the data
      document.dispatchEvent(new CustomEvent('__pitchshift:getstate'));

      // 3. Failsafe timeout to prevent hanging UI
      setTimeout(() => {
        document.removeEventListener('__pitchshift:state', onState);
        sendResponse({ ok: false });
      }, 300);

      // 4. Return TRUE tells Chrome: "Wait for sendResponse, don't close!"
      return true;
    }
  });

  console.info('[PitchShift] Content script ready. Async Bridge enabled.');
})();