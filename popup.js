const DEFAULTS = {
  enableBonus: true,
  enableOverlay: true,
  enablePredict: false,

  strategy: 'majority',      // 'majority'|'minority'|'random'|'blue'|'pink'
  wagerPercent: 5,           // 0..100
  wagerFixed: 0,             // >0 to override percent with a fixed wager
  predictCountdownSec: 10,   // seconds left before placing a bet

  bonusMinSec: 5,            // 5-20 seconds
  bonusMaxSec: 20
};

function $(id){ return document.getElementById(id); }

// Helper utilities for reading and writing popup controls
function getNumber(id, fallback=0) {
  const el = $(id);
  if (!el) return fallback;
  const v = parseInt(el.value || '', 10);
  return Number.isFinite(v) ? v : fallback;
}
function getChecked(id, fallback=false) {
  const el = $(id);
  return el ? !!el.checked : fallback;
}
function setValue(id, value) {
  const el = $(id);
  if (!el) return;
  el.value = value;
}
function setChecked(id, value) {
  const el = $(id);
  if (!el) return;
  el.checked = !!value;
}

function load() {
  chrome.storage.sync.get(DEFAULTS, (stored) => {
    if (chrome.runtime.lastError) {
      console.warn('storage.get error:', chrome.runtime.lastError);
      stored = DEFAULTS;
    }
    setChecked('enableBonus', stored.enableBonus);
    setChecked('enableOverlay', stored.enableOverlay);
    setChecked('enablePredict', stored.enablePredict);

    setValue('strategy', stored.strategy || DEFAULTS.strategy);
    setValue('wagerPercent', Number.isFinite(stored.wagerPercent) ? stored.wagerPercent : DEFAULTS.wagerPercent);
    setValue('wagerFixed', Number.isFinite(stored.wagerFixed) ? stored.wagerFixed : DEFAULTS.wagerFixed);
    setValue('predictCountdownSec', Number.isFinite(stored.predictCountdownSec) ? stored.predictCountdownSec : DEFAULTS.predictCountdownSec);

    setValue('bonusMinSec', Number.isFinite(stored.bonusMinSec) ? stored.bonusMinSec : DEFAULTS.bonusMinSec);
    setValue('bonusMaxSec', Number.isFinite(stored.bonusMaxSec) ? stored.bonusMaxSec : DEFAULTS.bonusMaxSec);
  });
}

function save() {
  let payload = {
    enableBonus: getChecked('enableBonus', DEFAULTS.enableBonus),
    enableOverlay: getChecked('enableOverlay', DEFAULTS.enableOverlay),
    enablePredict: getChecked('enablePredict', DEFAULTS.enablePredict),

    strategy: ( $('strategy')?.value ) || DEFAULTS.strategy,
    wagerPercent: getNumber('wagerPercent', DEFAULTS.wagerPercent),
    wagerFixed: getNumber('wagerFixed', DEFAULTS.wagerFixed),
    predictCountdownSec: getNumber('predictCountdownSec', DEFAULTS.predictCountdownSec),

    bonusMinSec: getNumber('bonusMinSec', DEFAULTS.bonusMinSec),
    bonusMaxSec: getNumber('bonusMaxSec', DEFAULTS.bonusMaxSec)
  };

  // Clamp numeric fields to sane bounds
  if (payload.bonusMinSec < 1) payload.bonusMinSec = 1;
  if (payload.bonusMaxSec < 1) payload.bonusMaxSec = 1;
  if (payload.bonusMinSec > payload.bonusMaxSec) {
    const t = payload.bonusMinSec;
    payload.bonusMinSec = payload.bonusMaxSec;
    payload.bonusMaxSec = t;
  }
  if (payload.wagerPercent < 0) payload.wagerPercent = 0;
  if (payload.wagerPercent > 100) payload.wagerPercent = 100;
  if (payload.wagerFixed < 0) payload.wagerFixed = 0;
  if (payload.predictCountdownSec < 0) payload.predictCountdownSec = 0;
  if (payload.predictCountdownSec > 600) payload.predictCountdownSec = 600;

  chrome.storage.sync.set(payload, () => {
    if (chrome.runtime.lastError) {
      console.warn('storage.set error:', chrome.runtime.lastError);
      return;
    }
    const ok = $('saveOk');
    if (ok) {
      ok.style.display = 'inline';
      setTimeout(() => ok.style.display = 'none', 1200);
    }
  });
}

function bindEvents() {
  // Hook the Save button
  $('save')?.addEventListener('click', save);

  // Auto-save whenever a control changes (even without clicking Save)
  ['enableBonus','enableOverlay','enablePredict','strategy','wagerPercent','wagerFixed','predictCountdownSec','bonusMinSec','bonusMaxSec']
    .forEach(id => {
      const el = $(id);
      if (el) el.addEventListener('change', save);
    });
}

// Run setup once the DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { bindEvents(); load(); });
} else {
  bindEvents(); load();
}
