// popup.js — PitchShift Extension UI

// ─── Note names for display ───────────────────────────────────────────────

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function semitoneLabel(s) {
  if (s === 0) return 'No change';
  const dir = s > 0 ? '▲' : '▼';
  const abs = Math.abs(s);
  const isMicro = abs % 1 !== 0;
  
  if (isMicro) {
    return `${dir} ${abs.toFixed(1)} semitones (microtonal)`;
  }
  
  const steps = Math.round(abs);
  if (steps === 1) return `${dir} 1.0 semitone`;
  if (steps === 12) return `${dir} 1 octave (${steps}.0 st)`;
  return `${dir} ${steps}.0 semitones`;
}

function formatValue(s) {
  if (s === 0) return '0.0';
  const sign = s > 0 ? '+' : '−';
  const abs = Math.abs(s);
  return `${sign}${abs.toFixed(1)}`;
}

// ─── State ───────────────────────────────────────────────────────────────

let semitones = 0;

// ─── DOM refs ────────────────────────────────────────────────────────────

const semitoneValueEl = document.getElementById('semitoneValue');
const noteLabelEl = document.getElementById('noteLabel');
const statusDot = document.getElementById('statusDot');
const footerEl = document.getElementById('footer');
const slider = document.getElementById('pitch-slider');

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

// ─── Keyboard shortcuts ───────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  switch (e.key) {
    case 'ArrowUp':    e.shiftKey ? change(+0.1) : change(+1); break;
    case 'ArrowDown':  e.shiftKey ? change(-0.1) : change(-1); break;
    case 'r': case 'R': reset(); break;
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