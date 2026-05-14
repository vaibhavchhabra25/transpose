// content/content.js  —  isolated world
// Only job: relay chrome.runtime messages from the popup into CustomEvents
// that injected.js (MAIN world) can hear, and relay responses back.
// Never touches audio elements directly — all audio lives in MAIN world.

document.documentElement.dataset.processorUrl = chrome.runtime.getURL('content/pitch-processor.js');

(function () {
  'use strict';

  const host = window.location.hostname;

  // 1. Auto-load saved pitch for this specific domain on startup
  chrome.storage.local.get([`pitch_${host}`, `formants_${host}`], (res) => {
    const savedPitch = res[`pitch_${host}`] || 0;
    const savedFormants = res[`formants_${host}`] || 0;

    if (savedPitch !== 0 || savedFormants !== 0) {
      // Give injected.js time to attach its listeners, then push the saved state
      setTimeout(() => {
        document.dispatchEvent(new CustomEvent('__pitchshift:set', {
          detail: { semitones: savedPitch, formants: savedFormants }
        }));
      }, 200);
    }
  });

  // 2. Save pitch for this domain when changed via shortcuts
  document.addEventListener('__pitchshift:save', (e) => {
    chrome.storage.local.set({
      [`pitch_${host}`]: e.detail.semitones,
      [`formants_${host}`]: e.detail.formants
    });
  });

  // 3. Relay Popup <--> Injected World
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

    if (msg.type === 'SET_SEMITONES') {
      const onState = (e) => {
        document.removeEventListener('__pitchshift:state', onState);
        sendResponse({
          ok: true,
          hookedCount: e.detail.hookedCount,
          semitones: e.detail.semitones,
          formants: e.detail.formants,
          baseKey: e.detail.baseKey,
          baseMode: e.detail.baseMode,
          chordKey: e.detail.chordKey,
          chordMode: e.detail.chordMode
        });
      };
      document.addEventListener('__pitchshift:state', onState);

      document.dispatchEvent(new CustomEvent('__pitchshift:set', {
        detail: {
          semitones: msg.semitones,
          formants: msg.formants
        },
      }));

      // Save both locally for this domain
      chrome.storage.local.set({
        [`pitch_${host}`]: msg.semitones,
        [`formants_${host}`]: msg.formants
      });

      setTimeout(() => {
        document.removeEventListener('__pitchshift:state', onState);
        sendResponse({ ok: false }); // Failsafe
      }, 800);
      return true;
    }

    if (msg.type === 'GET_STATE') {
      const onState = (e) => {
        document.removeEventListener('__pitchshift:state', onState);
        sendResponse({
          ok: true,
          hookedCount: e.detail.hookedCount, // 🚀 FIXED: Added the missing hookedCount!
          semitones: e.detail.semitones,
          formants: e.detail.formants,
          baseKey: e.detail.baseKey,
          baseMode: e.detail.baseMode,
          chordKey: e.detail.chordKey,
          chordMode: e.detail.chordMode
        });
      };

      document.addEventListener('__pitchshift:state', onState);
      document.dispatchEvent(new CustomEvent('__pitchshift:getstate'));

      setTimeout(() => {
        document.removeEventListener('__pitchshift:state', onState);
        sendResponse({ ok: false }); // Failsafe
      }, 800);
      return true;
    }
  });

  console.info('[PitchShift] Content script ready.');
})();