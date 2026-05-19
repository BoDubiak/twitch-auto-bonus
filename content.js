// == Twitch Helper ==
// Features: Bonus auto-claim, AdBlock overlay close, Predictions (dialog + highlight)
// Settings are synchronized via chrome.storage.sync (see popup.html)

// ========= settings =========
const DEFAULTS = {
  enableBonus: true,
  enableOverlay: true,
  enablePredict: false,
  enableDebug: false,

  strategy: 'majority',   // 'majority'|'minority'|'random'|'blue'|'pink'
  wagerPercent: 5,        // 0..100
  wagerFixed: 0,          // >0 to override percent and use a fixed wager
  predictCountdownSec: 10, // seconds left before placing a bet

  bonusMinSec: 5,
  bonusMaxSec: 20
};

let CFG = { ...DEFAULTS };

function loadSettings() {
  chrome.storage?.sync?.get(DEFAULTS, (data) => {
    CFG = { ...DEFAULTS, ...data };
    boot(); // Restart observers with the current configuration
  });
}

chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area !== 'sync') return;
  Object.keys(changes).forEach(k => {
    CFG[k] = changes[k].newValue;
  });
  boot();
});

// ========= utils =========
const log = (...a) => console.debug('[TwitchHelper]', ...a);
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function debugPredict(step, data = {}) {
  if (!CFG.enableDebug) return;
  console.debug('[TwitchHelper] [PredictDebug]', step, data);
}

const debugThrottleTs = new Map();
function debugPredictThrottled(key, step, data = {}, intervalMs = 10_000) {
  if (!CFG.enableDebug) return;
  const now = Date.now();
  const last = debugThrottleTs.get(key) || 0;
  if (now - last < intervalMs) return;
  debugThrottleTs.set(key, now);
  debugPredict(step, data);
}

function debugElement(label, el) {
  if (!CFG.enableDebug) return;
  if (!el) {
    debugPredict(label, { found: false });
    return;
  }
  const rect = el.getBoundingClientRect?.();
  debugPredict(label, {
    found: true,
    tag: el.tagName,
    disabled: !!el.disabled,
    visible: isVisible(el),
    text: compactText(el.textContent || ''),
    html: compactHtml(el)
  });
  if (rect) {
    debugPredict(label + ':rect', {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    });
  }
}

function compactText(text, max = 240) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max) + '...' : clean;
}

function compactHtml(el, max = 700) {
  const html = String(el?.outerHTML || '').replace(/\s+/g, ' ').trim();
  return html.length > max ? html.slice(0, max) + '...' : html;
}

function isVisible(el) {
  if (!el || !el.isConnected) return false;
  const st = getComputedStyle(el);
  if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function waitForBody(cb) {
  if (document.body) return cb();
  const i = setInterval(() => {
    if (document.body) { clearInterval(i); cb(); }
  }, 300);
}

// ========= (1) BONUS (safe) =========
let bonusObserver = null;
let bonusPollId = null;
let lastBonusClickTs = 0;
const scheduledBonus = new WeakSet();

const BONUS_ICON_SELECTOR = '.claimable-bonus__icon';
const BONUS_BUTTON_STRICT = 'button[data-a-target="community-points-summary-claim-button"]';

function getRealClaimButton(root = document) {
  const strictBtn = root.querySelector(BONUS_BUTTON_STRICT);
  if (strictBtn && !strictBtn.disabled && isVisible(strictBtn)) return strictBtn;
  const icon = root.querySelector(BONUS_ICON_SELECTOR);
  if (icon) {
    const btn = icon.closest('button');
    if (btn && !btn.disabled && isVisible(btn)) return btn;
  }
  return null;
}

function scheduleBonusClick(btn) {
  if (!CFG.enableBonus) return;
  if (scheduledBonus.has(btn)) return;

  const now = Date.now();
  const COOLDOWN = 25_000;
  if (now - lastBonusClickTs < COOLDOWN) return;

  const delay = rand(CFG.bonusMinSec * 1000, CFG.bonusMaxSec * 1000);
  scheduledBonus.add(btn);
  log('Bonus detected, clicking in ' + Math.round(delay/1000) + 's');

  setTimeout(() => {
    if (!CFG.enableBonus) { scheduledBonus.delete(btn); return; }
    if (btn.isConnected && !btn.disabled && isVisible(btn)) {
      try { btn.click(); lastBonusClickTs = Date.now(); log('Bonus clicked'); }
      catch (e) { console.warn('[Bonus] Click failed:', e); }
    }
    scheduledBonus.delete(btn);
  }, delay);
}

function startBonus() {
  if (bonusObserver || bonusPollId) stopBonus();

  bonusObserver = new MutationObserver(muts => {
    for (const m of muts) {
      for (const node of m.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches?.(BONUS_ICON_SELECTOR)) {
          const btn = node.closest('button'); if (btn) scheduleBonusClick(btn);
          continue;
        }
        if (node.matches?.(BONUS_BUTTON_STRICT)) { scheduleBonusClick(node); continue; }
        const strictInside = node.querySelector?.(BONUS_BUTTON_STRICT);
        if (strictInside) { scheduleBonusClick(strictInside); continue; }
        const iconInside = node.querySelector?.(BONUS_ICON_SELECTOR);
        if (iconInside) {
          const btn = iconInside.closest('button');
          if (btn) scheduleBonusClick(btn);
        }
      }
    }
  });
  bonusObserver.observe(document.body, { childList: true, subtree: true });

  bonusPollId = setInterval(() => {
    if (!CFG.enableBonus) return;
    const btn = getRealClaimButton();
    if (btn) scheduleBonusClick(btn);
  }, 5000);

  // Kick off with any existing bonus button
  const btn = getRealClaimButton();
  if (btn) scheduleBonusClick(btn);

  log('[Bonus] started');
}

function stopBonus() {
  if (bonusObserver) { bonusObserver.disconnect(); bonusObserver = null; }
  if (bonusPollId) { clearInterval(bonusPollId); bonusPollId = null; }
  scheduledBonus.clear?.();
  log('[Bonus] stopped');
}

// ========= (2) OVERLAY CLOSE =========
let overlayObserver = null;
let lastOverlayCloseTs = 0;
const scheduledOverlay = new WeakSet();

const OVERLAY_CONTAINER_SELECTOR = '.player-overlay-background';
const OVERLAY_CLOSE_SELECTORS = [
  'button[aria-label="Return to stream"]',
  'button[aria-label*="Return to stream" i]'
];

function findOverlayCloseButton(container) {
  for (const sel of OVERLAY_CLOSE_SELECTORS) {
    const btn = container.querySelector(sel);
    if (btn && !btn.disabled && isVisible(btn)) return btn;
  }
  const alt = container.querySelector('button');
  return (alt && !alt.disabled && isVisible(alt)) ? alt : null;
}

function scheduleOverlayClose(container) {
  if (!CFG.enableOverlay) return;
  if (scheduledOverlay.has(container)) return;

  const now = Date.now();
  const COOLDOWN = 10_000;
  if (now - lastOverlayCloseTs < COOLDOWN) return;

  const btn = findOverlayCloseButton(container);
  if (!btn) return;

  const delay = rand(300, 1500);
  scheduledOverlay.add(container);
  log('[Overlay] detected, click in ' + delay + 'ms');

  setTimeout(() => {
    if (!CFG.enableOverlay) { scheduledOverlay.delete(container); return; }
    if (btn.isConnected && !btn.disabled && isVisible(btn)) {
      try { btn.click(); lastOverlayCloseTs = Date.now(); log('[Overlay] closed'); }
      catch (e) { console.warn('[Overlay] Click failed:', e); }
    }
    scheduledOverlay.delete(container);
  }, delay);
}

function startOverlay() {
  if (overlayObserver) stopOverlay();

  overlayObserver = new MutationObserver(muts => {
    for (const m of muts) {
      for (const node of m.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches?.(OVERLAY_CONTAINER_SELECTOR)) { scheduleOverlayClose(node); }
        const inside = node.querySelector?.(OVERLAY_CONTAINER_SELECTOR);
        if (inside) scheduleOverlayClose(inside);
      }
    }
  });
  overlayObserver.observe(document.documentElement, { childList: true, subtree: true });

  // Kick off with any existing overlay
  document.querySelectorAll(OVERLAY_CONTAINER_SELECTOR).forEach(scheduleOverlayClose);

  log('[Overlay] started');
}

function stopOverlay() {
  if (overlayObserver) { overlayObserver.disconnect(); overlayObserver = null; }
  scheduledOverlay.clear?.();
  log('[Overlay] stopped');
}

// ========= (3) PREDICTIONS (dialog + highlight) =========
let predictOpenObserver = null;
let rewardCenterObserver = null;
let predictPollId = null;
let lastPredictTs = 0;
let lastPredictOpenAttemptTs = 0;
const scheduledOpenPredict = new WeakSet();
let dialogStates = new WeakMap();
const pendingPredictionTimers = new Set();

const PREDICTION_ROOT_SEL = [
  '[data-test-selector="community-prediction"]',
  '[data-a-target="community-prediction-root"]',
  '.community-prediction'
].join(',');

const PREDICT_HIGHLIGHT_BTN_SEL =
  'button[data-test-selector="community-prediction-highlight-header__action-button"]';

const CHANNEL_POINTS_BALANCE_SEL =
  '[data-test-selector="copo-balance-string"]';

const PREDICTION_REWARD_ITEM_SEL = [
  '.predictions-list-item',
  '[data-test-selector="predictions-list-item__title"]',
  '[data-test-selector="predictions-list-item__subtitle"]',
  '[data-test-selector="predictions-list-item__total-points"]'
].join(',');

const REWARDCENTER_DIALOG_SEL =
  '[role="dialog"][aria-labelledby="channel-points-reward-center-header"]';

const REWARDCENTER_CLOSE_SELECTORS = [
  'button[data-test-selector="community-points-reward-center__close-button"]',
  'button[data-a-target="community-points-reward-center-modal__close-button"]',
  'button[data-a-target="modal-close-button"]',
  'button[data-a-target="close-button"]',
  'button[aria-label*="Close" i]'
];

const NO_TIMER_CLOSE_DELAY_MS = 10_000;
const PREDICT_POLL_INTERVAL_MS = 8_000;
const MIN_PREDICTION_WAGER = 10;

const SUMMARY_COLUMN_SEL = '.prediction-summary-outcome';
const SUMMARY_PERCENT_SEL = '[data-test-selector="prediction-summary-outcome__percentage"], .prediction-summary-outcome__percent-hero';
const FIXED_BTN_BLUE_SEL = '.fixed-prediction-button--blue';
const FIXED_BTN_PINK_SEL = '.fixed-prediction-button--pink';
const CUSTOM_TOGGLE_SEL = 'button[data-test-selector="prediction-checkout-active-footer__input-type-toggle"]';
const WAGER_INPUT_CANDIDATES = [
  'input[data-a-target="community-prediction-wager-input"]',
  'input[data-test-selector="prediction-wager-input"]',
  'input[data-a-target="tw-input"]',
  'input[aria-label*="Predict" i]',
  'input[type="number"]'
];
const WAGER_MAX_BTN_CANDIDATES = [
  'button[data-a-target="community-prediction-amount-max-button"]',
  'button[aria-label*="Max" i]'
];
const SUBMIT_BTN_CANDIDATES = [
  'button[data-a-target="community-prediction-join-button"]',
  'button[data-test-selector="prediction-checkout-active-footer__submit-button"]',
  'button[aria-label*="Predict" i]',
  'button[aria-label*="Submit" i]',
  'button[aria-label*="Vote" i]'
];

const CUSTOM_PREDICTION_CONTAINER_SEL = '.custom-prediction-button';
const CUSTOM_PREDICTION_INTERACTIVE_SEL = '.custom-prediction-button__interactive';

const PREDICTION_DIALOG_MARKER_SEL = [
  SUMMARY_COLUMN_SEL,
  FIXED_BTN_BLUE_SEL,
  FIXED_BTN_PINK_SEL,
  CUSTOM_PREDICTION_CONTAINER_SEL,
  'input[data-a-target="community-prediction-wager-input"]',
  'input[data-test-selector="prediction-wager-input"]',
  'input[data-a-target="tw-input"]',
  '[data-test-selector="prediction-checkout-header__time-remaining"]'
].join(',');

function describeCustomPredictionContainers(dialog) {
  return Array.from(dialog.querySelectorAll(CUSTOM_PREDICTION_CONTAINER_SEL))
    .map(container => {
      const entry = {
        container,
        input: container.querySelector('input[type="number"]'),
        voteButton: container.querySelector('button'),
        interactive: container.querySelector(CUSTOM_PREDICTION_INTERACTIVE_SEL)
      };
      entry.maxButton = qsOne(container, WAGER_MAX_BTN_CANDIDATES);
      return entry;
    })
    .filter(entry => visible(entry.container));
}

function pickCustomPredictionEntry(entries, side) {
  if (!entries.length) return null;
  const matchByColor = tokens => entries.find(({ interactive }) => {
    const color = interactive?.style?.backgroundColor?.toLowerCase() || '';
    return tokens.some(token => color.includes(token));
  });

  const blueColors = ['56, 122, 255', '0, 173, 255', '61, 113, 249'];
  const pinkColors = ['245, 0, 155', '255, 0, 214', '238, 12, 142'];

  let blue = matchByColor(blueColors);
  let pink = matchByColor(pinkColors);

  if (!blue) blue = entries[0];
  if (!pink) pink = entries.length > 1 ? entries[entries.length - 1] : entries[0];

  return side === 'pink' ? pink : blue;
}

function prand(a,b){ return rand(a,b); }
function visible(el){ return isVisible(el); }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

function parsePct(col) {
  const pctEl = col.querySelector(SUMMARY_PERCENT_SEL);
  if (!pctEl) return null;
  const t = pctEl.textContent || '';
  const m = t.match(/(\d{1,3})\s*%/);
  const v = m ? parseInt(m[1], 10) : NaN;
  return Number.isFinite(v) ? v : null;
}

const POINT_KEYWORDS = ['point', 'points', 'channel points', 'prediction'];

function parsePointsValue(text) {
  if (!text) return null;
  const sanitized = String(text)
    .replace(/\u00a0|\u202f/g, ' ')
    .trim();
  if (!sanitized) return null;

  const cleaned = sanitized.replace(/\(.*?\)/g, ' ');
  let best = null;
  const re = /(\d+(?:[.,\s]\d+)*)(?:\s*([kmb]))?/ig;
  for (const match of cleaned.matchAll(re)) {
    let raw = match[1];
    if (!raw) continue;
    const suffix = (match[2] || '').toLowerCase();
    let valueStr = raw.replace(/\s+/g, '');
    if (suffix) {
      valueStr = valueStr.replace(',', '.');
    } else {
      valueStr = valueStr.replace(/[,\s]/g, '');
      if (/^\d{1,3}(?:\.\d{3})+$/.test(valueStr)) {
        valueStr = valueStr.replace(/\./g, '');
      }
    }
    const num = parseFloat(valueStr);
    if (!Number.isFinite(num)) continue;
    let mult = 1;
    if (suffix === 'k') mult = 1_000;
    else if (suffix === 'm') mult = 1_000_000;
    else if (suffix === 'b') mult = 1_000_000_000;
    const total = num * mult;
    if (!Number.isFinite(total)) continue;
    if (best == null || total > best) best = total;
  }

  return best == null ? null : Math.round(best);
}

function parseOutcomePoints(col) {
  if (!col) return null;
  const candidates = [];

  const directAttrs = [
    col.getAttribute?.('data-points'),
    col.dataset?.points,
    col.dataset?.totalPoints,
    col.dataset?.totalpoints
  ];
  for (const raw of directAttrs) {
    const val = parsePointsValue(raw);
    if (val != null) candidates.push(val);
  }

  const attrSelectors = [
    '[data-test-selector="prediction-summary-outcome__stat"]',
    '[data-test-selector*="points"]',
    '[class*="points"]'
  ];
  for (const sel of attrSelectors) {
    const el = col.querySelector(sel);
    if (!el) continue;
    const val = parsePointsValue(el.textContent);
    if (val != null) candidates.push(val);
  }

  const textNodes = Array.from(col.querySelectorAll('p, span, div, strong'));
  for (const el of textNodes) {
    const text = (el.textContent || '').trim();
    if (!text || text.includes('%')) continue;
    const lower = text.toLowerCase();
    const hasKeyword = POINT_KEYWORDS.some(keyword => lower.includes(keyword));
    const val = parsePointsValue(text);
    if (val == null) continue;
    if (hasKeyword || val >= 10) candidates.push(val);
  }

  if (!candidates.length) return null;
  return Math.max(...candidates);
}

const PREDICTION_TIMER_SELECTORS = [
  '[data-test-selector="prediction-timer__time-remaining"]',
  '[data-test-selector="progress-bar__time-remaining"]',
  '[data-test-selector="prediction-checkout-header__time-remaining"]',
  '[data-test-selector="predictions-list-item__subtitle"]',
  '[data-test-selector*="countdown"]',
  'time[data-test-selector*="countdown"]'
];

const TIMER_KEYWORDS = [
  'closing',
  'closes',
  'close in',
  'closes in',
  'lock in',
  'closing in',
  'remaining',
  'left',
  'прогноз',
  'лишилось',
  'залишилось'
];

function normalizeTimerText(text) {
  return String(text || '')
    .replace(/\u00a0|\u202f/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseCountdownSeconds(text) {
  if (!text) return null;
  const cleaned = normalizeTimerText(text);
  if (!cleaned) return null;

  const hourMinSec = cleaned.match(/(\d+)\s*h(?:ours?)?\s*(\d+)\s*m(?:in(?:ute)?s?)?\s*(\d+)\s*s(?:ec(?:ond)?s?)?/i);
  if (hourMinSec) {
    const hours = parseInt(hourMinSec[1], 10);
    const minutes = parseInt(hourMinSec[2], 10);
    const seconds = parseInt(hourMinSec[3], 10);
    if (Number.isFinite(hours) && Number.isFinite(minutes) && Number.isFinite(seconds)) {
      return hours * 3600 + minutes * 60 + seconds;
    }
  }

  const hourMin = cleaned.match(/(\d+)\s*h(?:ours?)?\s*(\d+)\s*m(?:in(?:ute)?s?)?/i);
  if (hourMin) {
    const hours = parseInt(hourMin[1], 10);
    const minutes = parseInt(hourMin[2], 10);
    if (Number.isFinite(hours) && Number.isFinite(minutes)) {
      return hours * 3600 + minutes * 60;
    }
  }

  const mm = cleaned.match(/(\d+)\s*:\s*(\d{2})/);
  if (mm) {
    const minutes = parseInt(mm[1], 10);
    const seconds = parseInt(mm[2], 10);
    if (Number.isFinite(minutes) && Number.isFinite(seconds)) {
      return minutes * 60 + seconds;
    }
  }

  const minSec = cleaned.match(/(\d+)\s*m\s*(\d+)\s*s/i);
  if (minSec) {
    const minutes = parseInt(minSec[1], 10);
    const seconds = parseInt(minSec[2], 10);
    if (Number.isFinite(minutes) && Number.isFinite(seconds)) {
      return minutes * 60 + seconds;
    }
  }

  const minsOnly = cleaned.match(/(\d+)\s*m(in(ute)?s?)?/i);
  if (minsOnly) {
    const minutes = parseInt(minsOnly[1], 10);
    if (Number.isFinite(minutes)) return minutes * 60;
  }

  const sec = cleaned.match(/(\d+)\s*(seconds?|sec|s)/i);
  if (sec) {
    const total = parseInt(sec[1], 10);
    if (Number.isFinite(total)) return total;
  }

  return null;
}

function isBareTimerText(text) {
  const cleaned = normalizeTimerText(text);
  if (!cleaned || cleaned.length > 24) return false;
  return /^(\d+\s*:\s*\d{2}|\d+\s*(h|m|s|sec|secs|second|seconds|minute|minutes)\b)/i.test(cleaned);
}

function getPredictionTimerSeconds(dialog) {
  for (const sel of PREDICTION_TIMER_SELECTORS) {
    const el = dialog.querySelector(sel);
    if (!el) continue;
    const sources = [
      el.textContent || '',
      el.getAttribute?.('aria-label') || '',
      el.getAttribute?.('title') || ''
    ];
    for (const info of sources) {
      const secs = parseCountdownSeconds(info);
      debugPredict('timer-candidate', { selector: sel, text: compactText(info), parsed: secs });
      if (secs != null) return secs;
    }
  }

  const nodes = Array.from(dialog.querySelectorAll('time, p, span, div'));
  let inspected = 0;
  for (const el of nodes) {
    if (inspected++ > 160) break;
    const sources = [
      el.textContent || '',
      el.getAttribute?.('aria-label') || '',
      el.getAttribute?.('title') || ''
    ];
    for (const raw of sources) {
      const text = (raw || '').trim();
      if (!text || !/\d/.test(text)) continue;
      const lower = text.toLowerCase();
      if (!TIMER_KEYWORDS.some(keyword => lower.includes(keyword)) && !isBareTimerText(text)) continue;
      const secs = parseCountdownSeconds(text);
      debugPredict('timer-fallback-candidate', { text: compactText(text), parsed: secs });
      if (secs != null) return secs;
    }
  }

  debugPredict('timer', { found: false });
  return null;
}

function ensureDialogState(dialog) {
  let state = dialogStates.get(dialog);
  if (!state) {
    state = {
      waiting: false,
      timeoutId: null,
      processing: false,
      done: false,
      timerCheckAttempts: 0,
      noTimerCloseId: null
    };
    dialogStates.set(dialog, state);
  }
  return state;
}

const MAX_TIMER_SEARCH_ATTEMPTS = 80;
const MISSING_TIMER_VOTE_ATTEMPTS = 6;

function getTargetCountdownSec() {
  const raw = Number.parseInt(CFG.predictCountdownSec, 10);
  if (!Number.isFinite(raw) || raw < 0) return 10;
  return Math.min(raw, 600);
}

function scheduleDialogCheck(dialog, delayMs, reason) {
  const state = ensureDialogState(dialog);
  if (state.timeoutId != null) {
    clearTimeout(state.timeoutId);
    pendingPredictionTimers.delete(state.timeoutId);
  }
  const delay = Math.max(200, delayMs || 0);
  const timeoutId = setTimeout(() => {
    pendingPredictionTimers.delete(timeoutId);
    const next = ensureDialogState(dialog);
    next.timeoutId = null;
    next.waiting = false;
    if (!CFG.enablePredict) return;
    handleRewardCenterDialog(dialog);
  }, delay);
  state.waiting = true;
  state.timeoutId = timeoutId;
  pendingPredictionTimers.add(timeoutId);
  if (reason) {
    log(`[Predict] ${reason} (retry in ${Math.round(delay / 1000)}s)`);
  }
}

function cancelNoTimerClose(state) {
  if (!state) return;
  if (state.noTimerCloseId != null) {
    clearTimeout(state.noTimerCloseId);
    pendingPredictionTimers.delete(state.noTimerCloseId);
    state.noTimerCloseId = null;
  }
}

function findRewardCenterCloseButton(dialog) {
  for (const sel of REWARDCENTER_CLOSE_SELECTORS) {
    const btn = dialog.querySelector(sel) || dialog.parentElement?.querySelector(sel);
    if (btn && visible(btn)) return btn;
  }
  return null;
}

function scheduleNoTimerClose(dialog, state) {
  if (!state) state = ensureDialogState(dialog);
  if (state.noTimerCloseId != null) return;

  const timeoutId = setTimeout(() => {
    pendingPredictionTimers.delete(timeoutId);
    const current = ensureDialogState(dialog);
    current.noTimerCloseId = null;

    if (!dialog?.isConnected) {
      log('[Predict] Dialog already absent before no-timer close');
      return;
    }

    let closed = false;
    const closeBtn = findRewardCenterCloseButton(dialog);
    if (closeBtn) {
      try {
        const evt = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
        closeBtn.dispatchEvent(evt);
        if (dialog.isConnected) {
          closeBtn.click();
        }
        closed = true;
      } catch (err) {
        console.warn('[Predict] Close button click failed:', err);
      }
    }

    if (!closed && dialog?.isConnected) {
      dialog.remove();
      closed = true;
    }

    current.done = true;
    current.processing = false;
    current.waiting = false;
    if (closed) {
      log('[Predict] Closed prediction dialog after missing timer for 10s');
    } else {
      log('[Predict] Failed to close prediction dialog after missing timer for 10s');
    }
  }, NO_TIMER_CLOSE_DELAY_MS);

  state.noTimerCloseId = timeoutId;
  pendingPredictionTimers.add(timeoutId);
  log(`[Predict] Timer missing; will close dialog in ${NO_TIMER_CLOSE_DELAY_MS / 1000}s`);
}

function hasActionablePredictionControls(dialog) {
  if (!dialog?.isConnected) return false;

  const input = qsOne(dialog, WAGER_INPUT_CANDIDATES);
  if (input && visible(input) && !input.disabled) return true;

  const quickBlue = dialog.querySelector(FIXED_BTN_BLUE_SEL);
  const quickPink = dialog.querySelector(FIXED_BTN_PINK_SEL);
  if ((quickBlue && visible(quickBlue) && !quickBlue.disabled) || (quickPink && visible(quickPink) && !quickPink.disabled)) {
    return true;
  }

  return describeCustomPredictionContainers(dialog).some(entry =>
    entry.voteButton && visible(entry.voteButton) && !entry.voteButton.disabled
  );
}

function isPredictionLockedText(text) {
  const normalized = String(text || '').toLowerCase();
  const compact = normalized.replace(/\s+/g, ' ');
  const lockedPhrases = [
    'submissions closed',
    'waiting for result',
    'waiting for outcome',
    'prediction closed',
    'prediction complete',
    'prediction locked',
    'прийом заявок завершено',
    'очікуємо на результат',
    'прием заявок завершен',
    'ожидаем результат'
  ];
  return lockedPhrases.some(phrase => compact.includes(phrase));
}

function pickSideByStrategy(dialog) {
  const cols = Array.from(dialog.querySelectorAll(SUMMARY_COLUMN_SEL)).filter(visible);
  const blue = cols[0];
  const pink = cols[1];
  const bluePoints = blue ? parseOutcomePoints(blue) : null;
  const pinkPoints = pink ? parseOutcomePoints(pink) : null;
  const bluePct = blue ? parsePct(blue) : null;
  const pinkPct = pink ? parsePct(pink) : null;

  const strategy = CFG.strategy || 'majority';
  debugPredict('side-inputs', { strategy, bluePoints, pinkPoints, bluePct, pinkPct });
  if (strategy === 'blue') return 'blue';
  if (strategy === 'pink') return 'pink';
  if (strategy === 'random') return Math.random() < 0.5 ? 'blue' : 'pink';

  if (strategy === 'majority' || strategy === 'minority') {
    const preferHigher = strategy === 'majority';

    const decide = (blueVal, pinkVal) => {
      const hasBlue = blueVal != null;
      const hasPink = pinkVal != null;
      if (!hasBlue && !hasPink) return null;
      if (hasBlue && !hasPink) return preferHigher ? 'blue' : 'pink';
      if (!hasBlue && hasPink) return preferHigher ? 'pink' : 'blue';
      if (blueVal === pinkVal) return 'tie';
      const blueHigher = blueVal > pinkVal;
      if (preferHigher) return blueHigher ? 'blue' : 'pink';
      return blueHigher ? 'pink' : 'blue';
    };

    const pointsDecision = decide(bluePoints, pinkPoints);
    if (pointsDecision === 'tie') return Math.random() < 0.5 ? 'blue' : 'pink';
    if (pointsDecision) return pointsDecision;

    const percentDecision = decide(bluePct, pinkPct);
    if (percentDecision === 'tie') return Math.random() < 0.5 ? 'blue' : 'pink';
    if (percentDecision) return percentDecision;

    return preferHigher ? 'blue' : 'pink';
  }

  return 'pink';
}
function qsOne(root, candidates) {
  for (const sel of candidates) {
    const el = root.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function findPredictionOpenButtons(root = document) {
  const buttons = new Set();

  const highlightRoot = root instanceof Element && root.matches?.(PREDICT_HIGHLIGHT_BTN_SEL)
    ? [root]
    : [];
  for (const btn of highlightRoot.concat(Array.from(root.querySelectorAll?.(PREDICT_HIGHLIGHT_BTN_SEL) || []))) {
    if (btn instanceof HTMLButtonElement) buttons.add(btn);
  }

  const balanceRoots = root instanceof Element && root.matches?.(CHANNEL_POINTS_BALANCE_SEL)
    ? [root]
    : [];
  for (const balance of balanceRoots.concat(Array.from(root.querySelectorAll?.(CHANNEL_POINTS_BALANCE_SEL) || []))) {
    const btn = balance.closest('button');
    if (btn) buttons.add(btn);
  }

  const itemRoots = root instanceof Element && root.matches?.(PREDICTION_REWARD_ITEM_SEL)
    ? [root]
    : [];
  for (const item of itemRoots.concat(Array.from(root.querySelectorAll?.(PREDICTION_REWARD_ITEM_SEL) || []))) {
    const btn = item.closest('button');
    if (btn) buttons.add(btn);
  }

  const result = Array.from(buttons).filter(btn => !btn.disabled && isVisible(btn));
  const debugOpenButtons = result.length ? debugPredict : debugPredictThrottled.bind(null, 'open-buttons-empty');
  debugOpenButtons('open-buttons', {
    count: result.length,
    buttons: result.slice(0, 5).map(btn => compactText(btn.textContent || btn.getAttribute('aria-label') || '', 120))
  });
  return result;
}

function findPredictionRewardItemButton(root = document) {
  for (const item of Array.from(root.querySelectorAll?.(PREDICTION_REWARD_ITEM_SEL) || [])) {
    const btn = item.closest('button');
    if (btn && !btn.disabled && isVisible(btn)) {
      debugElement('reward-item-button', btn);
      return btn;
    }
  }
  debugPredictThrottled('reward-item-button-missing', 'reward-item-button', { found: false });
  return null;
}

function findChannelPointsBalanceButton(root = document) {
  const balance = root instanceof Element && root.matches?.(CHANNEL_POINTS_BALANCE_SEL)
    ? root
    : root.querySelector?.(CHANNEL_POINTS_BALANCE_SEL);
  const btn = balance?.closest('button');
  const result = btn && !btn.disabled && isVisible(btn) ? btn : null;
  if (result) debugElement('balance-button', result);
  else debugPredictThrottled('balance-button-missing', 'balance-button', { found: false });
  return result;
}

function hasPredictionDialogMarkers(root) {
  return !!(
    root instanceof Element && root.matches?.(PREDICTION_DIALOG_MARKER_SEL) ||
    root?.querySelector?.(PREDICTION_DIALOG_MARKER_SEL)
  );
}

function findPredictionDialog(root = document) {
  if (root instanceof Element && root.matches?.(REWARDCENTER_DIALOG_SEL) && visible(root) && hasPredictionDialogMarkers(root)) {
    debugElement('prediction-dialog:strict-self', root);
    return root;
  }

  const strict = root.querySelector?.(REWARDCENTER_DIALOG_SEL);
  if (strict && visible(strict) && hasPredictionDialogMarkers(strict)) {
    debugElement('prediction-dialog:strict', strict);
    return strict;
  }

  const marker = root instanceof Element && root.matches?.(PREDICTION_DIALOG_MARKER_SEL)
    ? root
    : root.querySelector?.(PREDICTION_DIALOG_MARKER_SEL);
  if (marker && visible(marker)) {
    debugElement('prediction-dialog:marker', marker);
    const dialog = marker.closest('[role="dialog"]');
    if (dialog && visible(dialog)) {
      debugElement('prediction-dialog:by-marker-dialog', dialog);
      return dialog;
    }

    const predictionRoot = marker.closest(PREDICTION_ROOT_SEL);
    if (predictionRoot && visible(predictionRoot)) {
      debugElement('prediction-dialog:by-marker-root', predictionRoot);
      return predictionRoot;
    }
  }

  for (const dialog of Array.from(root.querySelectorAll?.('[role="dialog"]') || [])) {
    if (visible(dialog) && hasPredictionDialogMarkers(dialog)) {
      debugElement('prediction-dialog:any-dialog', dialog);
      return dialog;
    }
  }

  debugPredictThrottled('prediction-dialog-missing', 'prediction-dialog', { found: false });
  return null;
}

async function waitForPredictionDialog(timeout = 6000) {
  const t0 = performance.now();
  while (performance.now() - t0 < timeout) {
    const el = findPredictionDialog();
    if (el) return el;
    await sleep(250);
  }
  return null;
}

function clickElement(el) {
  if (!el || !el.isConnected || el.disabled || !visible(el)) {
    debugPredict('click-skipped', {
      hasElement: !!el,
      connected: !!el?.isConnected,
      disabled: !!el?.disabled,
      visible: !!(el && visible(el))
    });
    return false;
  }
  try {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    el.click?.();
    debugElement('clicked', el);
    return true;
  } catch (err) {
    console.warn('[Predict] Click failed:', err);
    return false;
  }
}

async function clickWithHumanDelay(btn, min=800,max=1800){
  const d = prand(min,max); await sleep(d);
  clickElement(btn);
  return d;
}

function setControlledInputValue(input, value) {
  if (!input) return false;
  const next = String(value);
  const proto = Object.getPrototypeOf(input);
  const valueSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  const ownValueSetter = Object.getOwnPropertyDescriptor(input, 'value')?.set;

  input.focus?.();
  input.click?.();

  if (valueSetter && ownValueSetter !== valueSetter) {
    valueSetter.call(input, next);
  } else {
    input.value = next;
  }

  try {
    input.setSelectionRange?.(next.length, next.length);
  } catch (_) {
    // Some number inputs do not support text selection.
  }

  input.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    cancelable: true,
    inputType: 'insertText',
    data: next
  }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.blur?.();
  input.focus?.();

  return input.value === next;
}

async function ensureCustomInput(dialog, side) {
  const grab = () => {
    const entries = describeCustomPredictionContainers(dialog);
    const entry = pickCustomPredictionEntry(entries, side);
    const input = entry?.input && visible(entry.input) ? entry.input : qsOne(dialog, WAGER_INPUT_CANDIDATES);
    return {
      input: input && visible(input) ? input : null,
      entry
    };
  };

  let { input, entry } = grab();
  if (input) return { input, entry };

  const toggle = dialog.querySelector(CUSTOM_TOGGLE_SEL);
  if (toggle && visible(toggle)) {
    await clickWithHumanDelay(toggle, 300, 700);
    await sleep(200);
    ({ input, entry } = grab());
    if (input) return { input, entry };
  }

  return { input: null, entry: null };
}

function getChannelPointsBalanceValue() {
  const balance = document.querySelector(CHANNEL_POINTS_BALANCE_SEL);
  const value = parsePointsValue(balance?.textContent || '');
  debugPredict('balance-value', {
    found: !!balance,
    text: compactText(balance?.textContent || ''),
    value
  });
  return value;
}

async function setWager(dialog, side) {
  const FIX = parseInt(CFG.wagerFixed || 0, 10) || 0;
  const PCT = parseInt(CFG.wagerPercent || 0, 10) || 0;
  debugPredict('set-wager:start', { side, fixed: FIX, percent: PCT });

  if (FIX > 0 || PCT > 0) {
    const { input, entry } = await ensureCustomInput(dialog, side);
    debugElement('wager-input', input);
    if (!input) {
      log('[Predict] No input field for custom wager.');
      debugPredict('set-wager:fallback', { reason: 'no-input' });
      return 'use-quick';
    }

    const targetEntry = entry || pickCustomPredictionEntry(describeCustomPredictionContainers(dialog), side);

    if (FIX > 0) {
      const wrote = setControlledInputValue(input, FIX);
      await sleep(100);
      log('[Predict] Fixed wager', FIX);
      debugPredict('set-wager:fixed', { value: FIX, inputValue: input.value, wrote });
      return { mode: 'custom', entry: targetEntry };
    }

    if (PCT > 0) {
      const maxBtn = targetEntry?.maxButton || qsOne(dialog, WAGER_MAX_BTN_CANDIDATES);
      let maxVal = parseInt(
        input.getAttribute('max') ||
        input.getAttribute('aria-valuemax') ||
        input.dataset?.max ||
        targetEntry?.container?.getAttribute?.('data-max') ||
        targetEntry?.container?.dataset?.max ||
        '0',
        10
      ) || 0;

      if (!maxVal && maxBtn && visible(maxBtn)) {
        await clickWithHumanDelay(maxBtn, 200, 500);
        await sleep(150);
        maxVal = parseInt(input.value || '0', 10) || maxVal;
      }

      if (!maxVal) {
        maxVal = getChannelPointsBalanceValue() || 0;
      }

      const desired = maxVal
        ? Math.max(MIN_PREDICTION_WAGER, Math.floor(maxVal * PCT / 100))
        : MIN_PREDICTION_WAGER;
      const wrote = setControlledInputValue(input, desired);
      await sleep(100);
      log(`[Predict] Max=${maxVal || 'unknown'} -> ${desired} (${PCT}%)`);
      debugPredict('set-wager:percent', { max: maxVal || null, desired, percent: PCT, inputValue: input.value, wrote });
      return { mode: 'custom', entry: targetEntry };
    }
  }

  if (document.querySelector(FIXED_BTN_BLUE_SEL) || document.querySelector(FIXED_BTN_PINK_SEL)) {
    debugPredict('set-wager:quick', { reason: 'fixed-buttons-found' });
    return 'use-quick';
  }

  debugPredict('set-wager:none');
  return false;
}

async function submitPrediction(dialog, side, wagerResult) {
  debugPredict('submit:start', { side, wagerResult: typeof wagerResult === 'object' ? wagerResult.mode : wagerResult });
  if (wagerResult && typeof wagerResult === 'object' && wagerResult.mode === 'custom') {
    const entry = wagerResult.entry || pickCustomPredictionEntry(describeCustomPredictionContainers(dialog), side);
    const voteBtn = entry?.voteButton;
    if (voteBtn && visible(voteBtn) && !voteBtn.disabled) {
      debugElement('submit:custom-vote-button', voteBtn);
      await clickWithHumanDelay(voteBtn, 250, 700);
      log('[Predict] Submitted via custom vote', side);
      return true;
    }
  }

  if (wagerResult === 'use-quick') {
    const quickBtn = side === 'blue'
      ? dialog.querySelector(FIXED_BTN_BLUE_SEL)
      : dialog.querySelector(FIXED_BTN_PINK_SEL);
    if (quickBtn && visible(quickBtn)) {
      debugElement('submit:quick-button', quickBtn);
      await clickWithHumanDelay(quickBtn, 200, 500);
      log('[Predict] Submitted via quick 10', side);
      return true;
    }
  }

  const submit = qsOne(dialog, SUBMIT_BTN_CANDIDATES) || dialog.querySelector('button[type="submit"]');
  if (submit && visible(submit) && !submit.disabled) {
    debugElement('submit:button', submit);
    await clickWithHumanDelay(submit, 250, 700);
    log('[Predict] Submitted.');
    return true;
  }

  log('[Predict] Submit not found.');
  debugPredict('submit:not-found', { dialogHtml: compactHtml(dialog, 1000) });
  return false;
}

async function handleRewardCenterDialog(dialog) {
  if (!CFG.enablePredict) return;
  debugElement('handle-dialog:start', dialog);
  const now = Date.now();
  const COOLDOWN = 60_000;
  if (now - lastPredictTs < COOLDOWN) {
    debugPredict('handle-dialog:cooldown', { msLeft: COOLDOWN - (now - lastPredictTs) });
    return;
  }

  const state = ensureDialogState(dialog);
  const dialogText = (dialog.textContent || '').toLowerCase();
  if (isPredictionLockedText(dialogText)) {
    debugPredict('handle-dialog:locked', { text: compactText(dialogText) });
    scheduleNoTimerClose(dialog, state);
    return;
  }
  if (state.done) {
    debugPredict('handle-dialog:skip', { reason: 'done' });
    return;
  }
  if (state.processing) {
    debugPredict('handle-dialog:skip', { reason: 'processing' });
    return;
  }

  const remaining = getPredictionTimerSeconds(dialog);
  const targetSec = getTargetCountdownSec();
  debugPredict('handle-dialog:timer', { remaining, targetSec });
  if (!Number.isFinite(remaining)) {
    state.timerCheckAttempts = (state.timerCheckAttempts || 0) + 1;
    if (hasActionablePredictionControls(dialog) && state.timerCheckAttempts >= MISSING_TIMER_VOTE_ATTEMPTS) {
      log('[Predict] Timer not visible; voting because prediction controls are ready.');
      debugPredict('handle-dialog:timer-missing-actionable', { attempts: state.timerCheckAttempts });
    } else if (state.timerCheckAttempts <= MAX_TIMER_SEARCH_ATTEMPTS) {
      const retryDelay = Math.min(2000, 300 + state.timerCheckAttempts * 150);
      scheduleDialogCheck(dialog, retryDelay, 'Timer not visible yet');
      return;
    } else {
      scheduleNoTimerClose(dialog, state);
      log('[Predict] Timer not found; waiting for auto-close.');
      return;
    }
  } else {
    state.timerCheckAttempts = 0;
  }

  if (Number.isFinite(remaining) && remaining <= 0) {
    scheduleNoTimerClose(dialog, state);
    log('[Predict] Timer at 0s; waiting for auto-close.');
    return;
  }

  cancelNoTimerClose(state);
  if (Number.isFinite(remaining) && remaining > targetSec) {
    const waitMs = Math.max((remaining - targetSec) * 1000, 500);
    scheduleDialogCheck(dialog, waitMs, `Timer at ${remaining}s (target ${targetSec}s)`);
    return;
  }

  if (state.timeoutId != null) {
    clearTimeout(state.timeoutId);
    pendingPredictionTimers.delete(state.timeoutId);
    state.timeoutId = null;
  }
  state.waiting = false;
  state.processing = true;

  try {
    const side = pickSideByStrategy(dialog);
    debugPredict('handle-dialog:side', { side });

    await clickWithHumanDelay(dialog, 300, 700);
    const wagerResult = await setWager(dialog, side);
    const ok = await submitPrediction(dialog, side, wagerResult);
    state.done = true;
    debugPredict('handle-dialog:submit-result', { ok });
    if (ok) {
      lastPredictTs = Date.now();
      scheduleNoTimerClose(dialog, state);
    }
  } catch (e) {
    state.done = true;
    console.warn('[Predict] Error:', e);
  } finally {
    state.processing = false;
  }
}

async function scheduleOpenPrediction(btn) {
  if (!CFG.enablePredict) return;
  if (scheduledOpenPredict.has(btn)) {
    debugPredict('open:skip', { reason: 'already-scheduled' });
    return;
  }
  scheduledOpenPredict.add(btn);
  debugElement('open:scheduled-button', btn);

  const d = rand(600, 1600);
  debugPredict('open:delay', { ms: d });
  setTimeout(async () => {
    if (!CFG.enablePredict) {
      debugPredict('open:abort', { reason: 'disabled' });
      scheduledOpenPredict.delete(btn);
      return;
    }
    if (!btn.isConnected || btn.disabled) {
      debugPredict('open:abort', { reason: 'button-unavailable', connected: btn.isConnected, disabled: btn.disabled });
      scheduledOpenPredict.delete(btn);
      return;
    }
    try {
      lastPredictOpenAttemptTs = Date.now();
      debugPredict('open:click-initial');
      clickElement(btn);

      let dialog = await waitForPredictionDialog(1500);
      debugElement('open:dialog-after-initial-click', dialog);
      if (!dialog) {
        const predictionItem = await (async function waitForPredictionItem(timeout=5000) {
          const t0 = performance.now();
          while (performance.now() - t0 < timeout) {
            const itemBtn = findPredictionRewardItemButton();
            if (itemBtn) return itemBtn;
            await sleep(100);
          }
          return null;
        })();
        debugElement('open:prediction-item-after-popover', predictionItem);
        if (predictionItem && predictionItem !== btn) {
          debugPredict('open:click-prediction-item');
          await clickWithHumanDelay(predictionItem, 200, 600);
        }
        dialog = await waitForPredictionDialog(6000);
        debugElement('open:dialog-after-item-click', dialog);
      }

      if (dialog) await handleRewardCenterDialog(dialog);
      else debugPredict('open:failed', { reason: 'dialog-not-found' });
    } catch(e) {
      console.warn('[Predict] open failed:', e);
      debugPredict('open:error', { message: String(e?.message || e) });
    } finally {
      setTimeout(()=>scheduledOpenPredict.delete(btn), 4000);
    }
  }, d);
}

function startPredict() {
  stopPredict();
  debugPredict('start', {
    strategy: CFG.strategy,
    wagerPercent: CFG.wagerPercent,
    wagerFixed: CFG.wagerFixed,
    predictCountdownSec: CFG.predictCountdownSec
  });

  // Watch highlight cards and the channel-points balance button that opens Reward Center.
  predictOpenObserver = new MutationObserver(muts => {
    for (const m of muts) {
      for (const node of m.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        findPredictionOpenButtons(node).forEach(scheduleOpenPrediction);
      }
    }
  });
  predictOpenObserver.observe(document.documentElement, { childList: true, subtree: true });
  findPredictionOpenButtons().forEach(scheduleOpenPrediction);

  // Watch for reward center dialogs
  rewardCenterObserver = new MutationObserver(muts => {
    for (const m of muts) {
      for (const node of m.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        const directDialog = findPredictionDialog(node);
        if (directDialog) {
          handleRewardCenterDialog(directDialog);
          continue;
        }
      }
    }
  });
  rewardCenterObserver.observe(document.documentElement, { childList: true, subtree: true });

  // Periodically check for an already open reward center dialog
  predictPollId = setInterval(() => {
    if (!CFG.enablePredict) return;
    debugPredictThrottled('poll-idle', 'poll', {}, 30_000);
    const d = findPredictionDialog();
    if (d) {
      handleRewardCenterDialog(d);
      return;
    }

    const predictionItem = findPredictionRewardItemButton();
    if (predictionItem) {
      debugPredict('poll:prediction-item-found');
      scheduleOpenPrediction(predictionItem);
      return;
    }

    const now = Date.now();
    if (now - lastPredictOpenAttemptTs > 30_000) {
      const balanceBtn = findChannelPointsBalanceButton();
      if (balanceBtn) {
        debugPredict('poll:balance-found');
        scheduleOpenPrediction(balanceBtn);
      }
    }
  }, PREDICT_POLL_INTERVAL_MS);

  log('[Predict] started');
}

function stopPredict() {
  if (predictOpenObserver) { predictOpenObserver.disconnect(); predictOpenObserver = null; }
  if (rewardCenterObserver) { rewardCenterObserver.disconnect(); rewardCenterObserver = null; }
  if (predictPollId) { clearInterval(predictPollId); predictPollId = null; }
  scheduledOpenPredict.clear?.();
  pendingPredictionTimers.forEach(id => clearTimeout(id));
  pendingPredictionTimers.clear();
  dialogStates = new WeakMap();
  log('[Predict] stopped');
}
// ========= bootstrap / toggles =========
function boot() {
  // BONUS
  if (CFG.enableBonus) startBonus(); else stopBonus();

  // OVERLAY
  if (CFG.enableOverlay) startOverlay(); else stopOverlay();

  // PREDICT
  if (CFG.enablePredict) startPredict(); else stopPredict();
}

waitForBody(loadSettings);



