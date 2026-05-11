// popup.js — PitchShift Extension UI

// ─── Note names for display ───────────────────────────────────────────────

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function semitoneLabel(s) {
  // If we haven't detected a key yet, fall back to the old label
  if (baseKeyIndex === -1) {
    if (s === 0) return 'Analyzing song key...';
    return `Transposed by ${formatValue(s)} st`;
  }

  // 🚀 The Music Theory Math
  const exactNote = baseKeyIndex + s;
  let nearestNoteIndex = Math.round(exactNote) % 12;
  if (nearestNoteIndex < 0) nearestNoteIndex += 12;

  // Calculate cents (-50 to +50)
  const cents = Math.round((exactNote - Math.round(exactNote)) * 100);

  const noteName = NOTE_NAMES[nearestNoteIndex];

  // Formatting
  let centsStr = '';
  if (cents > 0) centsStr = ` (+${cents} cents)`;
  if (cents < 0) centsStr = ` (${cents} cents)`;

  if (s === 0) return `Original Key: ${noteName} ${baseMode}`;
  return `Transposed key: ${noteName} ${baseMode}${centsStr}`;
}

function formatValue(s) {
  if (s === 0) return '0.0';
  const sign = s > 0 ? '+' : '−';
  const abs = Math.abs(s);
  return `${sign}${abs.toFixed(1)}`;
}

// ─── State ───────────────────────────────────────────────────────────────

let semitones = 0;
let baseKeyIndex = -1;
let baseMode = '';

// ─── DOM refs ────────────────────────────────────────────────────────────

const semitoneValueEl = document.getElementById('semitoneValue');
const noteLabelEl = document.getElementById('noteLabel');
const statusDot = document.getElementById('statusDot');
const footerEl = document.getElementById('footer');
const slider = document.getElementById('pitch-slider');
const formantBtn = document.getElementById('btnFormant');
const formantStatus = document.getElementById('formantStatus');

let formants = 0; // Local state for the popup

// ─── Render ───────────────────────────────────────────────────────────────

function render() {
  semitoneValueEl.textContent = formatValue(semitones);
  noteLabelEl.textContent = semitoneLabel(semitones);
  slider.value = semitones;

  semitoneValueEl.className = 'semitone-value';
  if (semitones === 0) semitoneValueEl.classList.add('neutral');
  else if (semitones > 0) semitoneValueEl.classList.add('up');
  else semitoneValueEl.classList.add('down');
  formantStatus.textContent = formants === 1 ? 'ON' : 'OFF';
  formantBtn.classList.toggle('active', formants === 1);
}

// ─── Send pitch to content script ─────────────────────────────────────────

function sendPitch() {
  chrome.runtime.sendMessage(
    {
      type: 'RELAY_TO_CONTENT',
      payload: { type: 'SET_SEMITONES', semitones, formants },
    },
    (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        setStatus('error', 'Content script not found. Reload the page.');
        return;
      }
      const { hookedCount } = response;
      if (hookedCount > 0) {
        setStatus('active', `Connected to ${hookedCount} media element${hookedCount > 1 ? 's' : ''}`);
      } else {
        setStatus('idle', `No media found or press play first`);
      }
    }
  );
  render();
}

function setStatus(state, message) {
  statusDot.className = 'status-dot' + (state === 'active' ? ' active' : state === 'error' ? ' error' : '');
  footerEl.textContent = message;
}

// ─── Change semitones ─────────────────────────────────────────────────────

function change(delta) {
  semitones = Math.max(-12, Math.min(12, +(semitones + delta).toFixed(1)));
  sendPitch();
}

function reset() {
  semitones = 0;
  sendPitch();
}

// ─── Button listeners ─────────────────────────────────────────────────────

document.getElementById('btnMinus').addEventListener('click', () => change(-1));
document.getElementById('btnPlus').addEventListener('click', () => change(+1));
document.getElementById('btnMinusHalf').addEventListener('click', () => change(-0.1));
document.getElementById('btnPlusHalf').addEventListener('click', () => change(+0.1));
document.getElementById('btnReset').addEventListener('click', reset);

slider.addEventListener('input', () => {
  semitones = parseFloat(slider.value);
  render();
});
slider.addEventListener('change', () => {
  semitones = parseFloat(slider.value);
  sendPitch();
});
formantBtn.addEventListener('click', () => {
  formants = formants === 0 ? 1 : 0;
  sendPitch();
});

// ── Keyboard Shortcuts inside the Popup ──
document.addEventListener('keydown', (e) => {
  let isFineTuning = e.shiftKey;
  let handled = false;

  // 1. Coarse Tuning (1.0 steps): Plus and Minus keys
  if (e.code === 'Equal') { // Physical key for '+'
    semitones += 1.0;
    handled = true;
  } else if (e.code === 'Minus') { // Physical key for '-'
    semitones -= 1.0;
    handled = true;
  }

  // 2. Fine Tuning (0.1 steps): Left and Right Arrows
  else if (e.code === 'ArrowRight') {
    semitones += 0.1;
    handled = true;
  } else if (e.code === 'ArrowLeft') {
    semitones -= 0.1;
    handled = true;
  }

  // 3. Modifiers (Shared with global shortcuts)
  else if (e.altKey && (e.code === 'Digit0' || e.code === 'Numpad0')) {
    semitones = 0;
    handled = true;
  } else if (e.altKey && e.code === 'KeyP') {
    formants = formants === 0 ? 1 : 0;
    handled = true;
  }

  // Update the engine if one of our keys was pressed
  if (handled) {
    e.preventDefault();

    // Boundaries and precision rounding
    semitones = Math.max(-12, Math.min(12, semitones));
    semitones = Math.round(semitones * 10) / 10;

    sendPitch();
    if (typeof render === "function") render();
  }
});

// ─── Init: Query active tab for its specific state ─────────────────────

function init() {
  // Render neutral state immediately while we ask the tab for its live pitch
  render();

  chrome.runtime.sendMessage(
    { type: 'RELAY_TO_CONTENT', payload: { type: 'GET_STATE' } },
    (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        setStatus('idle', 'Open a page with audio/video');
        return;
      }

      // Mirror the actual live state of the active tab!
      if (response.semitones !== undefined) {
        semitones = response.semitones;
        render();
      }

      if (response.formants !== undefined) {
        formants = response.formants;
        render();
      }

      if (response.baseKey !== undefined) {
        baseKeyIndex = response.baseKey;
        baseMode = response.baseMode;
      }

      const { hookedCount } = response;
      if (hookedCount > 0) {
        setStatus('active', `Connected to ${hookedCount} media element${hookedCount > 1 ? 's' : ''}`);
      } else {
        setStatus('idle', 'No media on this page (press play)');
      }
    }
  );
}

init();

// ─── Live Data Polling ────────────────────────────────────────────────────
// Continuously ask the tab if it has finished analyzing the song key
setInterval(() => {
  chrome.runtime.sendMessage(
    { type: 'RELAY_TO_CONTENT', payload: { type: 'GET_STATE' } },
    (response) => {
      if (chrome.runtime.lastError || !response?.ok) return;

      // If the content script finally found the key, and it's new data, update the UI!
      if (response.baseKey !== undefined && response.baseKey !== baseKeyIndex) {
        baseKeyIndex = response.baseKey;
        baseMode = response.baseMode;
        render();
      }
    }
  );
}, 1000); // Check once every second