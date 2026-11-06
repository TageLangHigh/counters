const STORAGE_KEY = 'session-best-v1';
const SESSION_IDLE_LIMIT_MS = 6 * 60 * 60 * 1000;
const PERSIST_INTERVAL_MS = 30 * 1000;

// tosu fills resultsScreen a few ticks after the state changes.
const RESULT_SETTLE_MS = 1500;
const SCORE_MATCH_TOLERANCE = 0.01;

// A single odd memory read must not wipe the session, so a lower game time has
// to hold for a while before it counts as a restart of osu!.
const RESTART_CONFIRM_TICKS = 20;

const MULTIPLAYER_RESULT_STATES = new Set(['rankingVs', 'rankingTagCoop', 'rankingTeam']);

function createSession(now) {
  return { best: null, passes: 0, lastPlayTime: 0, lastActivityAt: now };
}

function statsFromResult(result) {
  return {
    pp: result.pp.current,
    fcPp: result.pp.fc,
    accuracy: result.accuracy,
    maxCombo: result.maxCombo,
    misses: result.hits['0'],
    mods: result.mods.name,
    rank: result.rank,
  };
}

function statsFromPlay(play) {
  return {
    pp: play.pp.current,
    fcPp: play.pp.fc,
    accuracy: play.accuracy,
    maxCombo: play.combo.max,
    misses: play.hits['0'],
    mods: play.mods.name,
    rank: play.rank.current,
  };
}

function mapFromData({ beatmap, directPath }) {
  return {
    artist: beatmap.artist,
    title: beatmap.title,
    version: beatmap.version,
    stars: beatmap.stats.stars.total,
    mapMaxCombo: beatmap.stats.maxCombo,
    background: directPath.beatmapBackground,
  };
}

function isResultForPlay(result, play) {
  if (result.score <= 0 || result.pp.current <= 0) return false;
  return Math.abs(result.score - play.score) <= play.score * SCORE_MATCH_TOLERANCE;
}

/**
 * Follows the game state and remembers the best passed play of the session.
 *
 * Only a transition from gameplay to a results screen counts as a pass, which
 * leaves out fails, quits, and old scores opened from song select.
 */
export class SessionTracker {
  constructor({ storage, onChange, now = Date.now }) {
    this.storage = storage;
    this.onChange = onChange;
    this.now = now;

    this.previousState = null;
    this.lastPlayData = null;
    this.pendingPass = null;
    this.watchingReplay = false;
    this.restartTicks = 0;
    this.lastPersistAt = 0;

    this.session = this.loadSession();
  }

  get isPlaying() {
    return this.previousState === 'play';
  }

  get best() {
    return this.session.best;
  }

  get passes() {
    return this.session.passes;
  }

  markAsReplay() {
    this.watchingReplay = true;
  }

  reset() {
    this.session = createSession(this.now());
    this.pendingPass = null;
    this.saveSession();
    this.onChange({ isNewBest: false });
  }

  update(data) {
    const state = data.state.name;
    const leftGameplay = this.previousState === 'play' && state !== 'play';
    this.previousState = state;

    this.resetIfSessionEnded(data.session.playTime);
    if (this.pendingPass) this.settlePendingPass(data, state === 'play');

    if (state === 'play') {
      this.lastPlayData = data;
      this.session.lastActivityAt = this.now();
      this.persistOccasionally();
    } else if (leftGameplay) {
      this.handleGameplayEnd(state, data);
    }
  }

  handleGameplayEnd(state, data) {
    const playData = this.lastPlayData;
    const wasReplay = this.watchingReplay;
    this.lastPlayData = null;
    this.watchingReplay = false;

    const localPlayer = data.profile.name;
    const shownPlayer = playData.play.playerName;
    if (wasReplay || (localPlayer && shownPlayer && localPlayer !== shownPlayer)) return;

    if (state === 'resultScreen') {
      this.pendingPass = { playData, deadline: this.now() + RESULT_SETTLE_MS };
      this.settlePendingPass(data, false);
    } else if (MULTIPLAYER_RESULT_STATES.has(state) && !playData.play.failed) {
      this.recordPass(statsFromPlay(playData.play), playData);
    }
  }

  settlePendingPass(data, mustSettleNow) {
    const { playData, deadline } = this.pendingPass;

    if (isResultForPlay(data.resultsScreen, playData.play)) {
      this.pendingPass = null;
      this.recordPass(statsFromResult(data.resultsScreen), playData);
    } else if (mustSettleNow || this.now() >= deadline) {
      this.pendingPass = null;
      this.recordPass(statsFromPlay(playData.play), playData);
    }
  }

  recordPass(stats, playData) {
    const isNewBest = stats.pp > (this.session.best?.pp ?? 0);

    this.session.passes += 1;
    this.session.lastActivityAt = this.now();
    if (isNewBest) this.session.best = { ...stats, ...mapFromData(playData) };

    this.saveSession();
    this.onChange({ isNewBest });
  }

  resetIfSessionEnded(playTime) {
    const looksRestarted = playTime > 0 && playTime < this.session.lastPlayTime;
    this.restartTicks = looksRestarted ? this.restartTicks + 1 : 0;

    const gameRestarted = this.restartTicks >= RESTART_CONFIRM_TICKS;
    const idleTooLong = this.now() - this.session.lastActivityAt > SESSION_IDLE_LIMIT_MS;

    if (gameRestarted || idleTooLong) {
      this.restartTicks = 0;
      this.reset();
    }
    if (!looksRestarted && playTime > 0) this.session.lastPlayTime = playTime;
  }

  loadSession() {
    const now = this.now();
    try {
      const saved = JSON.parse(this.storage.getItem(STORAGE_KEY));
      if (saved && now - saved.lastActivityAt <= SESSION_IDLE_LIMIT_MS) return saved;
    } catch (error) {
      console.warn('[session-best] Could not read the saved session', error);
    }
    return createSession(now);
  }

  persistOccasionally() {
    if (this.now() - this.lastPersistAt >= PERSIST_INTERVAL_MS) this.saveSession();
  }

  saveSession() {
    this.lastPersistAt = this.now();
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(this.session));
    } catch (error) {
      console.warn('[session-best] Could not save the session', error);
    }
  }
}
