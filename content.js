// == Twitch Helper ==
// Features: Bonus auto-claim, AdBlock overlay close, Predictions (dialog + highlight)
// Settings are synchronized via chrome.storage.sync (see popup.html)

// ========= settings =========
const DEFAULTS = {
  enableBonus: true,
  enableOverlay: true,
  enablePredict: false,

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

const REWARDCENTER_DIALOG_SEL =
  '[role="dialog"][aria-labelledby="channel-points-reward-center-header"]';

const SUMMARY_COLUMN_SEL = '.prediction-summary-outcome';
const SUMMARY_PERCENT_SEL = '[data-test-selector="prediction-summary-outcome__percentage"], .prediction-summary-outcome__percent-hero';
const FIXED_BTN_BLUE_SEL = '.fixed-prediction-button--blue';
const FIXED_BTN_PINK_SEL = '.fixed-prediction-button--pink';
const CUSTOM_TOGGLE_SEL = 'button[data-test-selector="prediction-checkout-active-footer__input-type-toggle"]';
const WAGER_INPUT_CANDIDATES = [
  'input[data-a-target="community-prediction-wager-input"]',
  'input[data-test-selector="prediction-wager-input"]',
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
  const re = /(\d+(?:[.,\s]\d+)?)(?:\s*([kmb]))?/ig;
  for (const match of cleaned.matchAll(re)) {
    let raw = match[1];
    if (!raw) continue;
    const suffix = (match[2] || '').toLowerCase();
    let valueStr = raw.replace(/\s+/g, '');
    if (suffix) {
      valueStr = valueStr.replace(',', '.');
    } else {
      valueStr = valueStr.replace(/,/g, '');
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
  '[data-test-selector*="countdown"]',
  'time[data-test-selector*="countdown"]'
];

const TIMER_KEYWORDS = ['closing', 'closes', 'close in', 'closes in', 'lock in', 'closing in'];

function parseCountdownSeconds(text) {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/\u00a0|\u202f/g, ' ')
    .trim();
  if (!cleaned) return null;

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

function getPredictionTimerSeconds(dialog) {
  for (const sel of PREDICTION_TIMER_SELECTORS) {
    const el = dialog.querySelector(sel);
    if (!el) continue;
    const info = el.textContent || el.getAttribute?.('aria-label') || '';
    const secs = parseCountdownSeconds(info);
    if (secs != null) return secs;
  }

  const nodes = Array.from(dialog.querySelectorAll('time, p, span, div'));
  let inspected = 0;
  for (const el of nodes) {
    if (inspected++ > 160) break;
    const sources = [
      el.textContent || '',
      el.getAttribute?.('aria-label') || ''
    ];
    for (const raw of sources) {
      const text = (raw || '').trim();
      if (!text || !/\d/.test(text)) continue;
      const lower = text.toLowerCase();
      if (!TIMER_KEYWORDS.some(keyword => lower.includes(keyword))) continue;
      const secs = parseCountdownSeconds(text);
      if (secs != null) return secs;
    }
  }

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
      timerCheckAttempts: 0
    };
    dialogStates.set(dialog, state);
  }
  return state;
}

const MAX_TIMER_SEARCH_ATTEMPTS = 80;

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

function pickSideByStrategy(dialog) {
  const cols = Array.from(dialog.querySelectorAll(SUMMARY_COLUMN_SEL)).filter(visible);
  const blue = cols[0];
  const pink = cols[1];
  const bluePoints = blue ? parseOutcomePoints(blue) : null;
  const pinkPoints = pink ? parseOutcomePoints(pink) : null;
  const bluePct = blue ? parsePct(blue) : null;
  const pinkPct = pink ? parsePct(pink) : null;

  const strategy = CFG.strategy || 'majority';
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

async function clickWithHumanDelay(btn, min=800,max=1800){
  const d = prand(min,max); await sleep(d);
  if (btn && btn.isConnected && !btn.disabled && visible(btn)) btn.click();
  return d;
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

async function setWager(dialog, side) {
  const FIX = parseInt(CFG.wagerFixed || 0, 10) || 0;
  const PCT = parseInt(CFG.wagerPercent || 0, 10) || 0;

  if (FIX > 0 || PCT > 0) {
    const { input, entry } = await ensureCustomInput(dialog, side);
    if (!input) {
      log('[Predict] No input field for custom wager.');
      return 'use-quick';
    }

    const targetEntry = entry || pickCustomPredictionEntry(describeCustomPredictionContainers(dialog), side);

    if (FIX > 0) {
      input.focus();
      input.value = String(FIX);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      log('[Predict] Fixed wager', FIX);
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
        log('[Predict] Unable to detect balance for percent wager; fallback to quick.');
        return 'use-quick';
      }

      const desired = Math.max(1, Math.floor(maxVal * PCT / 100));
      input.focus();
      input.value = String(desired);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      log(`[Predict] Max=${maxVal} -> ${desired} (${PCT}%)`);
      return { mode: 'custom', entry: targetEntry };
    }
  }

  if (document.querySelector(FIXED_BTN_BLUE_SEL) || document.querySelector(FIXED_BTN_PINK_SEL)) {
    return 'use-quick';
  }

  return false;
}

async function submitPrediction(dialog, side, wagerResult) {
  if (wagerResult && typeof wagerResult === 'object' && wagerResult.mode === 'custom') {
    const entry = wagerResult.entry || pickCustomPredictionEntry(describeCustomPredictionContainers(dialog), side);
    const voteBtn = entry?.voteButton;
    if (voteBtn && visible(voteBtn) && !voteBtn.disabled) {
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
      await clickWithHumanDelay(quickBtn, 200, 500);
      log('[Predict] Submitted via quick 10', side);
      return true;
    }
  }

  const submit = qsOne(dialog, SUBMIT_BTN_CANDIDATES) || dialog.querySelector('button[type="submit"]');
  if (submit && visible(submit) && !submit.disabled) {
    await clickWithHumanDelay(submit, 250, 700);
    log('[Predict] Submitted.');
    return true;
  }

  log('[Predict] Submit not found.');
  return false;
}

async function handleRewardCenterDialog(dialog) {
  if (!CFG.enablePredict) return;
  const now = Date.now();
  const COOLDOWN = 60_000;
  if (now - lastPredictTs < COOLDOWN) return;

  const state = ensureDialogState(dialog);
  if (state.done) return;
  if (state.processing) return;

  const remaining = getPredictionTimerSeconds(dialog);
  const targetSec = getTargetCountdownSec();
  if (!Number.isFinite(remaining)) {
    state.timerCheckAttempts = (state.timerCheckAttempts || 0) + 1;
    if (state.timerCheckAttempts <= MAX_TIMER_SEARCH_ATTEMPTS) {
      const retryDelay = Math.min(2000, 300 + state.timerCheckAttempts * 150);
      scheduleDialogCheck(dialog, retryDelay, 'Timer not visible yet');
      return;
    }
    log('[Predict] Timer not found; proceeding without countdown guard.');
  } else {
    state.timerCheckAttempts = 0;
    if (remaining > targetSec) {
      const waitMs = Math.max((remaining - targetSec) * 1000, 500);
      scheduleDialogCheck(dialog, waitMs, `Timer at ${remaining}s (target ${targetSec}s)`);
      return;
    }
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
    const txt = (dialog.textContent || '').toLowerCase();
    if (txt.includes('locked') || txt.includes('0:00')) {
      log('[Predict] locked, skip');
      state.done = true;
      return;
    }

    await clickWithHumanDelay(dialog, 300, 700);
    const wagerResult = await setWager(dialog, side);
    const ok = await submitPrediction(dialog, side, wagerResult);
    state.done = true;
    if (ok) {
      lastPredictTs = Date.now();
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
  if (scheduledOpenPredict.has(btn)) return;
  scheduledOpenPredict.add(btn);

  const d = rand(600, 1600);
  setTimeout(async () => {
    if (!CFG.enablePredict) { scheduledOpenPredict.delete(btn); return; }
    if (!btn.isConnected || btn.disabled) { scheduledOpenPredict.delete(btn); return; }
    try {
      btn.click();
      // Wait for the reward center dialog to appear
      const dialog = await (async function waitForDialog(timeout=6000){
        const t0 = performance.now();
        while (performance.now() - t0 < timeout) {
          const d = document.querySelector(REWARDCENTER_DIALOG_SEL);
          if (d && visible(d)) return d;
          await sleep(100);
        }
        return null;
      })();
      if (dialog) await handleRewardCenterDialog(dialog);
    } catch(e) {
      console.warn('[Predict] open failed:', e);
    } finally {
      setTimeout(()=>scheduledOpenPredict.delete(btn), 4000);
    }
  }, d);
}

function startPredict() {
  stopPredict();

  // Watch highlight cards for the Predict button
  predictOpenObserver = new MutationObserver(muts => {
    for (const m of muts) {
      for (const node of m.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches?.(PREDICT_HIGHLIGHT_BTN_SEL)) {
          if (!node.disabled && isVisible(node)) scheduleOpenPrediction(node);
          continue;
        }
        const btnInside = node.querySelector?.(PREDICT_HIGHLIGHT_BTN_SEL);
        if (btnInside && !btnInside.disabled && isVisible(btnInside)) {
          scheduleOpenPrediction(btnInside);
        }
      }
    }
  });
  predictOpenObserver.observe(document.documentElement, { childList: true, subtree: true });
  const existingBtn = document.querySelector(PREDICT_HIGHLIGHT_BTN_SEL);
  if (existingBtn && isVisible(existingBtn) && !existingBtn.disabled) scheduleOpenPrediction(existingBtn);

  // Watch for reward center dialogs
  rewardCenterObserver = new MutationObserver(muts => {
    for (const m of muts) {
      for (const node of m.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches?.(REWARDCENTER_DIALOG_SEL)) {
          if (visible(node)) handleRewardCenterDialog(node);
          continue;
        }
        const dialog = node.querySelector?.(REWARDCENTER_DIALOG_SEL);
        if (dialog && visible(dialog)) handleRewardCenterDialog(dialog);
      }
    }
  });
  rewardCenterObserver.observe(document.documentElement, { childList: true, subtree: true });

  // Periodically check for an already open reward center dialog
  predictPollId = setInterval(() => {
    if (!CFG.enablePredict) return;
    const d = document.querySelector(REWARDCENTER_DIALOG_SEL);
    if (d && visible(d)) handleRewardCenterDialog(d);
  }, 4000);

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
