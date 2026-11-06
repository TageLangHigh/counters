import WebSocketManager from './js/socket.js';
import { SessionTracker } from './js/sessionTracker.js';

const REPLAY_CHECK_INTERVAL_MS = 3000;
const STREAM_COMPANION_WATCHING = 8;
const RECORD_HIGHLIGHT_MS = 2600;
const COUNT_UP_MS = 900;
const COUNT_UP_STEP_MS = 30;

const GRADE_LABELS = { X: 'SS', XH: 'SS', SS: 'SS', SSH: 'SS', SH: 'S' };

const SOCKET_FILTERS = [
  { field: 'state', keys: ['name'] },
  { field: 'session', keys: ['playTime'] },
  { field: 'profile', keys: ['name'] },
  { field: 'directPath', keys: ['beatmapBackground'] },
  {
    field: 'beatmap',
    keys: [
      'artist',
      'title',
      'version',
      { field: 'stats', keys: ['maxCombo', { field: 'stars', keys: ['total'] }] },
    ],
  },
  {
    field: 'play',
    keys: [
      'playerName',
      'failed',
      'score',
      'accuracy',
      { field: 'combo', keys: ['max'] },
      { field: 'hits', keys: ['0'] },
      { field: 'mods', keys: ['name'] },
      { field: 'rank', keys: ['current'] },
      { field: 'pp', keys: ['current', 'fc'] },
    ],
  },
  {
    field: 'resultsScreen',
    keys: [
      'score',
      'accuracy',
      'maxCombo',
      'rank',
      { field: 'hits', keys: ['0'] },
      { field: 'mods', keys: ['name'] },
      { field: 'pp', keys: ['current', 'fc'] },
    ],
  },
];

const elementIds = [
  'card', 'grade', 'bestPp', 'passes', 'title', 'subtitle', 'stars', 'mods', 'accuracy',
  'combo', 'misses', 'live', 'liveLabel', 'livePp', 'liveFill', 'liveFc',
];
const elements = Object.fromEntries(elementIds.map((id) => [id, document.getElementById(id)]));

let recordTimeout = null;
let countUpTimer = null;

function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

function backgroundUrl(path) {
  const encodedPath = path.split(/[\\/]/).map(encodeURIComponent).join('/');
  return `url("/Songs/${encodedPath}")`;
}

// Uses a timer because animation frames stop while an OBS source is hidden,
// which would leave a wrong number on the card.
function countUpTo(element, target) {
  const start = Number(element.textContent) || 0;
  const startedAt = performance.now();
  clearInterval(countUpTimer);

  countUpTimer = setInterval(() => {
    const progress = Math.min((performance.now() - startedAt) / COUNT_UP_MS, 1);
    const eased = 1 - (1 - progress) ** 3;
    element.textContent = Math.round(start + (target - start) * eased);
    if (progress === 1) clearInterval(countUpTimer);
  }, COUNT_UP_STEP_MS);
}

function highlightRecord() {
  clearTimeout(recordTimeout);
  elements.card.classList.remove('is-record');
  void elements.card.offsetWidth; // restarts the animation when records follow each other
  elements.card.classList.add('is-record');
  recordTimeout = setTimeout(() => elements.card.classList.remove('is-record'), RECORD_HIGHLIGHT_MS);
}

function renderBest(best) {
  elements.card.classList.toggle('is-empty', !best);

  if (!best) {
    clearInterval(countUpTimer);
    elements.bestPp.textContent = '0';
    elements.card.style.removeProperty('--art');
    setText(elements.title, 'No pass yet this session');
    setText(elements.subtitle, 'Finish a map to set your best');
    return;
  }

  const combo = best.mapMaxCombo ? `${best.maxCombo}/${best.mapMaxCombo}x` : `${best.maxCombo}x`;

  elements.card.style.setProperty('--art', backgroundUrl(best.background));
  elements.grade.dataset.rank = best.rank;
  setText(elements.grade, GRADE_LABELS[best.rank] ?? best.rank);
  setText(elements.title, `${best.artist} - ${best.title}`);
  setText(elements.subtitle, `[${best.version}]`);
  setText(elements.stars, `${best.stars.toFixed(2)}★`);
  setText(elements.mods, best.mods || 'NM');
  setText(elements.accuracy, `${best.accuracy.toFixed(2)}%`);
  setText(elements.combo, combo);
  setText(elements.misses, String(best.misses));
}

function renderPassCount(passes) {
  setText(elements.passes, passes === 1 ? '1 pass' : `${passes} passes`);
}

function renderSession({ isNewBest }) {
  const best = tracker.best;
  renderBest(best);
  renderPassCount(tracker.passes);

  if (isNewBest) {
    countUpTo(elements.bestPp, Math.round(best.pp));
    highlightRecord();
  } else if (best) {
    setText(elements.bestPp, String(Math.round(best.pp)));
  }
}

function renderLive(data) {
  elements.live.hidden = !tracker.isPlaying;
  if (!tracker.isPlaying) return;

  const livePp = data.play.pp.current;
  const bestPp = tracker.best?.pp ?? 0;
  const isAhead = !tracker.watchingReplay && bestPp > 0 && livePp > bestPp;
  const progress = bestPp > 0 ? Math.min(livePp / bestPp, 1) : 0;

  elements.live.classList.toggle('is-ahead', isAhead);
  elements.liveFill.style.transform = `scaleX(${progress})`;
  setText(elements.liveLabel, tracker.watchingReplay ? 'Replay' : isAhead ? 'New best' : 'Live');
  setText(elements.livePp, String(Math.round(livePp)));
  setText(elements.liveFc, String(Math.round(data.play.pp.fc)));
}

async function checkForReplay() {
  if (!tracker.isPlaying || tracker.watchingReplay) return;

  try {
    const response = await fetch('/json/sc');
    const { status } = await response.json();
    if (status === STREAM_COMPANION_WATCHING && tracker.isPlaying) tracker.markAsReplay();
  } catch (error) {
    console.warn('[session-best] Replay check failed', error);
  }
}

const tracker = new SessionTracker({ storage: window.localStorage, onChange: renderSession });

renderSession({ isNewBest: false });
elements.card.addEventListener('dblclick', () => tracker.reset());
setInterval(checkForReplay, REPLAY_CHECK_INTERVAL_MS);

const socket = new WebSocketManager(window.location.host);
socket.api_v2((data) => {
  try {
    tracker.update(data);
    renderLive(data);
  } catch (error) {
    console.error('[session-best] Could not process update', error);
  }
}, SOCKET_FILTERS);
