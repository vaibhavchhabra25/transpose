// popup.js — PitchShift Extension UI

// ─── Note names for display ───────────────────────────────────────────────

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function semitoneLabel(s) {
  if (s === 0) return 'No change';
  const dir = s > 0 ? '▲' : '▼';
  const abs = Math.abs(s);
  const isHalf = abs % 1 !== 0;
  if (isHalf) {
    return `${dir} ${abs} semitones (microtonal)`;
  }
  const steps = Math.round(abs);
  if (steps === 1) return `${dir} 1 semitone`;
  if (steps === 12) return `${dir} 1 octave (${steps} st)`;
  return `${dir} ${steps} semitones`;
}

function formatValue(s) {
  if (s === 0) return '0';
  const sign = s > 0 ? '+' : '−';
  const abs = Math.abs(s);
  // Show ½ symbol for .5 values
  if (abs % 1 === 0.5) return `${sign}${Math.floor(abs)}½`;
  return `${sign}${abs}`;
}

// ─── State ───────────────────────────────────────────────────────────────

let semitones = 0;

// ─── DOM refs ────────────────────────────────────────────────────────────

const semitoneValueEl = document.getElementById('semitoneValue');
const noteLabelEl = document.getElementById('noteLabel');
const statusDot = document.getElementById('statusDot');
const footerEl = document.getElementById('footer');
const slider = document.getElementById('pitchSlider');

// ─── Render ───────────────────────────────────────────────────────────────

function render() {
  semitoneValueEl.textContent = formatValue(semitones);
  noteLabelEl.textContent = semitoneLabel(semitones);
  slider.value = semitones;

  semitoneValueEl.className = 'semitone-value';
  if (semitones === 0) semitoneValueEl.classList.add('neutral');
  else if (semitones > 0) semitoneValueEl.classList.add('up');
  else semitoneValueEl.classList.add('down');
}

// ─── Send pitch to content script ─────────────────────────────────────────

function sendPitch() {
  chrome.runtime.sendMessage(
    {
      type: 'RELAY_TO_CONTENT',
      payload: { type: 'SET_SEMITONES', semitones },
    },
    (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        setStatus('error', 'Content script not found. Reload the page.');
        return;
      }
      const { hookedCount, mediaCount } = response;
      if (hookedCount > 0) {
        setStatus('active', `Connected to ${hookedCount} media element${hookedCount > 1 ? 's' : ''}`);
      } else if (mediaCount === 0) {
        setStatus('idle', 'No media found on this page');
      } else {
        setStatus('idle', `Found ${mediaCount} element${mediaCount > 1 ? 's' : ''} — press play first`);
      }
    }
  );
  render();
  // Persist setting for this tab
  chrome.storage.session.set({ semitones }).catch(() => {});
}

function setStatus(state, message) {
  statusDot.className = 'status-dot' + (state === 'active' ? ' active' : state === 'error' ? ' error' : '');
  footerEl.textContent = message;
}

// ─── Change semitones ─────────────────────────────────────────────────────

function change(delta) {
  semitones = Math.max(-12, Math.min(12, +(semitones + delta).toFixed(2)));
  sendPitch();
}

function reset() {
  semitones = 0;
  sendPitch();
}

// ─── Button listeners ─────────────────────────────────────────────────────

document.getElementById('btnMinus').addEventListener('click', () => change(-1));
document.getElementById('btnPlus').addEventListener('click', () => change(+1));
document.getElementById('btnMinusHalf').addEventListener('click', () => change(-0.5));
document.getElementById('btnPlusHalf').addEventListener('click', () => change(+0.5));
document.getElementById('btnReset').addEventListener('click', reset);

slider.addEventListener('input', () => {
  semitones = parseFloat(slider.value);
  render();
});
slider.addEventListener('change', () => {
  semitones = parseFloat(slider.value);
  sendPitch();
});

// ─── Keyboard shortcuts ───────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  switch (e.key) {
    case 'ArrowUp':    e.shiftKey ? change(+0.5) : change(+1); break;
    case 'ArrowDown':  e.shiftKey ? change(-0.5) : change(-1); break;
    case 'r': case 'R': reset(); break;
  }
});

// ─── Init: load saved state and query content script ─────────────────────

async function init() {
  // Load persisted semitones
  try {
    const stored = await chrome.storage.session.get('semitones');
    if (stored?.semitones !== undefined) {
      semitones = stored.semitones;
    }
  } catch (_) {}

  render();

  // Query current state from content script
  chrome.runtime.sendMessage(
    { type: 'RELAY_TO_CONTENT', payload: { type: 'GET_STATE' } },
    (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        setStatus('idle', 'Open a page with audio/video');
        return;
      }
      const { mediaCount, hookedCount } = response;
      if (hookedCount > 0) {
        setStatus('active', `Connected to ${hookedCount} media element${hookedCount > 1 ? 's' : ''}`);
      } else if (mediaCount > 0) {
        setStatus('idle', `${mediaCount} media element${mediaCount > 1 ? 's' : ''} — press play to activate`);
      } else {
        setStatus('idle', 'No media on this page');
      }
    }
  );
}

init();
