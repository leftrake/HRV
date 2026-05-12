'use strict';

const STORAGE_KEY = 'hrv_entries';

// ── Storage ──────────────────────────────────────────────────────────────────

function loadEntries() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
  catch { return []; }
}

function saveEntries(entries) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

// ── HRV classification ────────────────────────────────────────────────────────

function hrvClass(hrv) {
  if (hrv >= 70) return { label: 'Great', cls: 'badge-great', color: '#34d399' };
  if (hrv >= 50) return { label: 'Good',  cls: 'badge-good',  color: '#5b8dee' };
  if (hrv >= 35) return { label: 'OK',    cls: 'badge-ok',    color: '#fbbf24' };
  return           { label: 'Low',   cls: 'badge-low',   color: '#f87171' };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const ACTIVITY_ICONS = {
  'Running': '🏃', 'Cycling': '🚴', 'Strength training': '🏋️',
  'Yoga': '🧘', 'Meditation': '🌿', 'Walking': '🚶',
  'Swimming': '🏊', 'Rest day': '😴',
};

function actIcon(type) { return ACTIVITY_ICONS[type] || '🏃'; }

function fmtDist(meters) {
  if (!meters) return '';
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

function fmtDur(seconds) {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
    : `${m}:${String(s).padStart(2,'0')}`;
}

function optInt(id)   { const v = parseInt(document.getElementById(id).value, 10);   return isNaN(v) ? null : v; }
function optFloat(id) { const v = parseFloat(document.getElementById(id).value);       return isNaN(v) ? null : v; }

// ── Activities storage ────────────────────────────────────────────────────────

const ACTIVITIES_KEY = 'strava_activities';
function loadActivities() {
  try { return JSON.parse(localStorage.getItem(ACTIVITIES_KEY) || '[]'); }
  catch { return []; }
}
function saveActivities(acts) { localStorage.setItem(ACTIVITIES_KEY, JSON.stringify(acts)); }

// ── GitHub Gist sync ──────────────────────────────────────────────────────────

const GistSync = {
  TOKEN_KEY:     'gist_token',
  GIST_ID_KEY:   'gist_id',
  LAST_SYNC_KEY: 'gist_last_sync',
  FILENAME:      'hrv-wellness-data.json',

  getToken()    { return localStorage.getItem(this.TOKEN_KEY)   || ''; },
  getGistId()   { return localStorage.getItem(this.GIST_ID_KEY) || ''; },
  isConfigured(){ return !!(this.getToken() && this.getGistId()); },

  packData() {
    return {
      version: 1,
      exportedAt: Date.now(),
      entries:    loadEntries(),
      activities: loadActivities(),
    };
  },

  mergeEntries(local, remote) {
    const map = new Map();
    for (const e of [...local, ...remote]) {
      const cur = map.get(e.date);
      if (!cur || (e.updatedAt || 0) >= (cur.updatedAt || 0)) map.set(e.date, e);
    }
    return [...map.values()].sort((a, b) => b.date.localeCompare(a.date));
  },

  mergeActivities(local, remote) {
    const map = new Map();
    for (const a of [...local, ...remote]) map.set(a.id, a);
    return [...map.values()];
  },

  unpackData(data) {
    if (!data || data.version !== 1) return;
    saveEntries(this.mergeEntries(loadEntries(), data.entries || []));
    saveActivities(this.mergeActivities(loadActivities(), data.activities || []));
  },

  async _req(method, path, token, body) {
    const res = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      localStorage.setItem('gist_token_invalid', '1');
      throw new Error('token_expired');
    }
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    localStorage.removeItem('gist_token_invalid');
    return res.json();
  },

  async findGist(token) {
    const gists = await this._req('GET', '/gists?per_page=100', token);
    const found = gists.find(g => g.files && g.files[this.FILENAME]);
    return found ? found.id : null;
  },

  async createGist(token) {
    const g = await this._req('POST', '/gists', token, {
      description: 'HRV Wellness Tracker data',
      public: false,
      files: { [this.FILENAME]: { content: JSON.stringify(this.packData()) } },
    });
    return g.id;
  },

  async push(token, gistId) {
    await this._req('PATCH', `/gists/${gistId}`, token, {
      files: { [this.FILENAME]: { content: JSON.stringify(this.packData()) } },
    });
    localStorage.setItem(this.LAST_SYNC_KEY, Date.now().toString());
  },

  async pull(token, gistId) {
    const g    = await this._req('GET', `/gists/${gistId}`, token);
    const file = g.files?.[this.FILENAME];
    if (!file) return;
    const text    = file.truncated ? await (await fetch(file.raw_url)).text() : file.content;
    const content = JSON.parse(text);
    this.unpackData(content);
    localStorage.setItem(this.LAST_SYNC_KEY, Date.now().toString());
  },

  async sync() {
    const token  = this.getToken();
    const gistId = this.getGistId();
    if (!token || !gistId) throw new Error('Not configured');
    await this.pull(token, gistId);
    await this.push(token, gistId);
    updateGistUI();
    refreshAllViews();
  },

  // Called once on page load; skips if synced recently
  async autoSync() {
    if (!this.isConfigured()) return;
    const last = parseInt(localStorage.getItem(this.LAST_SYNC_KEY) || '0', 10);
    if (Date.now() - last < 5 * 60 * 1000) return;
    try { await this.sync(); } catch (e) { console.warn('GistSync auto:', e); }
  },

  // Fire-and-forget push after each save
  pushSilent() {
    if (!this.isConfigured()) return;
    this.push(this.getToken(), this.getGistId())
      .then(updateGistUI)
      .catch(e => console.warn('GistSync push:', e));
  },
};

// ── Race Goal Tracker ────────────────────────────────────────────────────────

const RaceGoal = {
  KEY: 'race_goal',

  load()    { try { return JSON.parse(localStorage.getItem(this.KEY) || 'null'); } catch { return null; } },
  save(g)   { localStorage.setItem(this.KEY, JSON.stringify(g)); },
  clear()   { localStorage.removeItem(this.KEY); },

  daysUntil(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const t = new Date(); t.setHours(0, 0, 0, 0);
    return Math.ceil((d - t) / 86400000);
  },

  linReg(points) {
    const n = points.length;
    if (n < 2) return null;
    const xm = points.reduce((s, p) => s + p.x, 0) / n;
    const ym = points.reduce((s, p) => s + p.y, 0) / n;
    const num = points.reduce((s, p) => s + (p.x - xm) * (p.y - ym), 0);
    const den = points.reduce((s, p) => s + (p.x - xm) ** 2, 0);
    if (!den) return null;
    const m = num / den, b = ym - m * xm;
    return { slope: m, predict: x => +(m * x + b).toFixed(1) };
  },

  project(entries) {
    const goal = this.load();
    if (!goal?.date || !goal?.hrv || entries.length < 3) return null;
    const days = this.daysUntil(goal.date);
    if (days <= 0) return { past: true, goal };

    const epoch = new Date('2020-01-01').getTime();
    const toX   = d => (new Date(d + 'T12:00:00') - epoch) / 86400000;
    const reg   = this.linReg(entries.map(e => ({ x: toX(e.date), y: e.hrv })));
    if (!reg) return null;

    const projected  = Math.max(1, reg.predict(toX(goal.date)));
    const recent     = entries.slice(-7);
    const currentAvg = +(recent.reduce((s, e) => s + e.hrv, 0) / recent.length).toFixed(1);
    return { goal, days, projected, currentAvg, onTrack: projected >= goal.hrv };
  },
};

// ── Streak tracking ───────────────────────────────────────────────────────────

const Streaks = {
  _addDays(dateStr, n) {
    const d = new Date(dateStr + 'T12:00:00');
    d.setDate(d.getDate() + n);
    return localDateStr(d);
  },

  compute(allEntries) {
    if (!allEntries.length) return { log: 0, hot: 0, best: 0 };

    const sorted   = allEntries.slice().sort((a, b) => a.date.localeCompare(b.date));
    const dateSet  = new Set(sorted.map(e => e.date));
    const entryMap = new Map(sorted.map(e => [e.date, e]));
    const overall  = sorted.reduce((s, e) => s + e.hrv, 0) / sorted.length;

    // Current log streak — walk back from today or yesterday
    let log = 0;
    const t = todayStr(), y = yesterdayStr();
    let cur = dateSet.has(t) ? t : dateSet.has(y) ? y : null;
    while (cur && dateSet.has(cur)) { log++; cur = this._addDays(cur, -1); }

    // Longest ever log streak
    let best = 0, run = 0, prev = null;
    for (const e of sorted) {
      run = (prev && this._addDays(prev, 1) === e.date) ? run + 1 : 1;
      if (run > best) best = run;
      prev = e.date;
    }
    // Include current streak in best
    if (log > best) best = log;

    // Above-baseline streak — consecutive logged days ending now where hrv >= overall mean
    let hot = 0;
    cur = dateSet.has(t) ? t : dateSet.has(y) ? y : null;
    while (cur && entryMap.has(cur)) {
      if (entryMap.get(cur).hrv >= overall) { hot++; cur = this._addDays(cur, -1); }
      else break;
    }

    return { log, hot, best };
  },
};

// ── Strava sync ───────────────────────────────────────────────────────────────

const StravaSync = {
  RACE_RE: /\b(race|800m|1500m|1600m|mile|5k|10k|half.?marathon|\bhm\b|marathon|meet|invitational|championship|qualifier|\btri\b|triathlon|\bxc\b|cross.?country)\b/i,

  processActivity(raw) {
    const type   = Strava.mapType(raw.sport_type || raw.type);
    const effort = raw.suffer_score ?? raw.relative_effort ?? this.estimateEffort(raw);
    const isRace = ['Race','VirtualRace'].includes(raw.sport_type) || this.RACE_RE.test(raw.name || '');
    return {
      id:           raw.id,
      date:         (raw.start_date_local || raw.start_date || '').slice(0, 10),
      startTime:    raw.start_date_local,
      stravaType:   raw.sport_type || raw.type,
      mappedType:   type,
      name:         raw.name,
      distanceM:    raw.distance || 0,
      durationS:    raw.moving_time || 0,
      avgHR:        raw.average_heartrate ? Math.round(raw.average_heartrate) : null,
      maxHR:        raw.max_heartrate     ? Math.round(raw.max_heartrate)     : null,
      avgPaceSecKm: raw.average_speed > 0 ? Math.round(1000 / raw.average_speed) : null,
      elevationM:   Math.round(raw.total_elevation_gain || 0),
      effort:       Math.round(effort || 0),
      isRace,
      raceConfirmed: false,
      raceDetails:  null,
    };
  },

  estimateEffort(raw) {
    if (!raw.moving_time) return 0;
    const hrs = raw.moving_time / 3600;
    const hrF = raw.average_heartrate ? Math.max(0, (raw.average_heartrate - 60) / 110) : 0.45;
    const typeM = ['Run','VirtualRun','TrailRun'].includes(raw.sport_type) ? 1.2
                : ['WeightTraining','Workout','Crossfit'].includes(raw.sport_type) ? 0.85 : 1.0;
    return Math.round(hrs * hrF * 100 * typeM);
  },

  async _fetch(after, before, page = 1) {
    const t = Strava.token;
    if (!t) throw new Error('Not connected');
    const url = new URL('https://www.strava.com/api/v3/athlete/activities');
    url.searchParams.set('after', after);
    url.searchParams.set('before', before);
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', page);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${t.access_token}` } });
    if (res.status === 429) throw new Error('Rate limited — try again in a few minutes');
    if (!res.ok) throw new Error(`Strava API ${res.status}`);
    return res.json();
  },

  async backfill(days = 90, onProgress) {
    await Strava.refreshIfNeeded();
    const end    = Math.floor(Date.now() / 1000);
    const start  = end - days * 86400;
    const existing = new Set(loadActivities().map(a => a.id));
    const fetched = [];
    let page = 1;
    while (true) {
      onProgress?.(`Fetching page ${page}…`);
      const batch = await this._fetch(start, end, page);
      if (!batch.length) break;
      for (const raw of batch) {
        if (!existing.has(raw.id)) fetched.push(this.processActivity(raw));
      }
      if (batch.length < 100) break;
      page++;
    }
    if (fetched.length) {
      const all = [...loadActivities(), ...fetched].sort((a, b) => b.date.localeCompare(a.date));
      saveActivities(all);
      this._queueRaces(fetched.filter(a => a.isRace));
    }
    localStorage.setItem('strava_last_sync', String(Date.now()));
    return fetched.length;
  },

  async syncRecent(onProgress) {
    await Strava.refreshIfNeeded();
    const lastSync = parseInt(localStorage.getItem('strava_last_sync') || '0', 10);
    const after  = lastSync ? Math.floor(lastSync / 1000) - 3600 : Math.floor(Date.now() / 1000) - 86400;
    const before = Math.floor(Date.now() / 1000);
    onProgress?.('Checking for new activities…');
    const batch    = await this._fetch(after, before).catch(() => []);
    const existing = new Set(loadActivities().map(a => a.id));
    const newActs  = batch.map(r => this.processActivity(r)).filter(a => !existing.has(a.id));
    if (newActs.length) {
      const all = [...loadActivities(), ...newActs].sort((a, b) => b.date.localeCompare(a.date));
      saveActivities(all);
      this._queueRaces(newActs.filter(a => a.isRace));
    }
    localStorage.setItem('strava_last_sync', String(Date.now()));
    return newActs.length;
  },

  async autoSync() {
    if (!Strava.isConnected()) return;
    const lastSync   = parseInt(localStorage.getItem('strava_last_sync') || '0', 10);
    const hoursSince = (Date.now() - lastSync) / 3_600_000;
    if (hoursSince < 6) return;
    try { await this.syncRecent(); } catch {}
  },

  _queueRaces(races) {
    const q = JSON.parse(localStorage.getItem('race_queue') || '[]');
    races.forEach(r => { if (!q.includes(r.id)) q.push(r.id); });
    localStorage.setItem('race_queue', JSON.stringify(q));
  },

  processRaceQueue() {
    const q = JSON.parse(localStorage.getItem('race_queue') || '[]');
    if (!q.length) return;
    const act = loadActivities().find(a => a.id === q[0]);
    if (act) showRaceModal(act);
    else {
      localStorage.setItem('race_queue', JSON.stringify(q.slice(1)));
      this.processRaceQueue();
    }
  },
};

// ── Training load ─────────────────────────────────────────────────────────────

const TrainingLoad = {
  K_ATL: 1 - Math.exp(-1 / 7),
  K_CTL: 1 - Math.exp(-1 / 42),

  dayEffort(activities, date) {
    return activities.filter(a => a.date === date).reduce((s, a) => s + (a.effort || 0), 0);
  },

  compute(activities, startDate, endDate) {
    const days = [];
    const d = new Date(startDate + 'T12:00:00');
    const end = new Date(endDate + 'T12:00:00');
    while (d <= end) { days.push(d.toISOString().slice(0, 10)); d.setDate(d.getDate() + 1); }
    let atl = 0, ctl = 0;
    const series = {};
    for (const date of days) {
      const effort = this.dayEffort(activities, date);
      const tsb    = ctl - atl;
      atl = atl + this.K_ATL * (effort - atl);
      ctl = ctl + this.K_CTL * (effort - ctl);
      series[date] = { effort, atl: +atl.toFixed(1), ctl: +ctl.toFixed(1), tsb: +tsb.toFixed(1) };
    }
    return series;
  },

  latest(activities) {
    const end   = todayStr();
    const s90 = new Date(); s90.setDate(s90.getDate() - 90);
    const start = localDateStr(s90);
    return this.compute(activities, start, end)[end] || { atl: 0, ctl: 0, tsb: 0, effort: 0 };
  },
};

// ── Taper Detection ───────────────────────────────────────────────────────────

const TaperDetector = {
  MIN_DROP_DAYS: 3,

  detect(activities) {
    const today = todayStr();
    const s = new Date(); s.setDate(s.getDate() - 90);
    const start = localDateStr(s);
    const series = TrainingLoad.compute(activities, start, today);
    const dates  = Object.keys(series).sort();
    if (dates.length < 4) return null;

    const todayData = series[today];
    // TSB must be positive (form > fatigue)
    if (!todayData || todayData.tsb <= 0) return null;

    // ATL must have been dropping for MIN_DROP_DAYS consecutive days ending today
    let dropDays = 0;
    for (let i = dates.length - 1; i > 0; i--) {
      if (series[dates[i]].atl < series[dates[i - 1]].atl) dropDays++;
      else break;
    }
    if (dropDays < this.MIN_DROP_DAYS) return null;

    // Find start of this taper run: earliest consecutive day where TSB was positive
    let taperStart = today;
    for (let i = dates.length - 2; i >= 0; i--) {
      if (series[dates[i]].tsb > 0) taperStart = dates[i];
      else break;
    }

    const startMs   = new Date(taperStart + 'T12:00:00').getTime();
    const todayMs   = new Date(today       + 'T12:00:00').getTime();
    const dayCount  = Math.round((todayMs - startMs) / 86400000) + 1;

    // Find next upcoming race: confirmed activities first, then RaceGoal
    const upcoming = activities
      .filter(a => a.isRace && a.raceConfirmed && a.date > today)
      .sort((a, b) => a.date.localeCompare(b.date));

    let nextRace = null;
    if (upcoming.length) {
      const r = upcoming[0];
      const daysToRace = Math.round(
        (new Date(r.date + 'T12:00:00') - new Date(today + 'T12:00:00')) / 86400000
      );
      nextRace = { date: r.date, name: r.name || 'Race', daysToRace };
    } else {
      const goal = RaceGoal.load();
      if (goal?.date > today) {
        const daysToRace = Math.round(
          (new Date(goal.date + 'T12:00:00') - new Date(today + 'T12:00:00')) / 86400000
        );
        nextRace = { date: goal.date, name: goal.name || 'Goal Race', daysToRace };
      }
    }

    return { startDate: taperStart, dayCount, dropDays, tsb: todayData.tsb, nextRace };
  },
};

// ── Training Plan Generator ───────────────────────────────────────────────────

const TrainingPlan = {
  KEY: 'hrv_plan',

  PHASES: {
    base:  { label: 'Base',  color: '#3b82f6', desc: 'Aerobic foundation' },
    build: { label: 'Build', color: '#f59e0b', desc: 'Volume & intensity' },
    peak:  { label: 'Peak',  color: '#ef4444', desc: 'Race-specific sharpness' },
    taper: { label: 'Taper', color: '#34d399', desc: 'Freshen & sharpen' },
  },

  SESSION: {
    rest:      { label: 'Rest',      color: '#525d78', effortPct: 0.00 },
    easy:      { label: 'Easy',      color: '#34d399', effortPct: 0.10 },
    medium:    { label: 'Aerobic',   color: '#60a5fa', effortPct: 0.15 },
    long:      { label: 'Long',      color: '#a78bfa', effortPct: 0.20 },
    tempo:     { label: 'Tempo',     color: '#f59e0b', effortPct: 0.22 },
    intervals: { label: 'Intervals', color: '#f87171', effortPct: 0.25 },
  },

  // Mon–Sun day patterns per phase
  PATTERNS: {
    base:  ['easy', 'medium',    'easy', 'long',   'easy', 'rest',  'easy'],
    build: ['easy', 'intervals', 'easy', 'tempo',  'rest', 'long',  'easy'],
    peak:  ['easy', 'intervals', 'easy', 'tempo',  'rest', 'intervals', 'long'],
    taper: ['easy', 'tempo',     'easy', 'easy',   'rest', 'easy',  'rest'],
  },

  DESCS: {
    run: {
      rest:      'Full rest or gentle walk',
      easy:      'Easy aerobic run — conversational pace, RPE 5',
      medium:    { base: 'Steady run + 4×20 s strides', build: 'Aerobic run with 3×10 min at marathon pace', default: 'Aerobic run' },
      long:      { base: 'Long easy run — 75–90 min', build: 'Long run — 80–100 min, last 20 at tempo', peak: 'Long run — 70–80 min at easy effort', taper: 'Easy long run — 50–60 min', default: 'Long run' },
      tempo:     { base: '20 min tempo effort (RPE 7)', build: '2×15 min tempo, 3 min rest', peak: '3×10 min at threshold', default: 'Tempo run' },
      intervals: { build: '6×800 m at 5 k pace, 90 s rest', peak: '5×1000 m at 3 k–5 k pace, 2 min rest', default: '4×400 m at mile pace' },
    },
    bike: {
      rest:      'Full rest or light spinning',
      easy:      'Easy spin — Z1/Z2, 45–60 min',
      medium:    { base: 'Aerobic ride + 4×1 min openers', default: 'Aerobic Z2 ride' },
      long:      { base: 'Long Z2 endurance ride — 2–2.5 hr', taper: 'Easy endurance spin — 90 min', default: 'Long endurance ride' },
      tempo:     { build: '2×20 min sweet spot (88–93% FTP)', peak: '3×15 min at threshold', default: 'Threshold ride' },
      intervals: { build: '5×5 min VO2max (106–120% FTP), 5 min rest', peak: '8×3 min VO2max, 3 min rest', default: 'VO2max intervals' },
    },
    swim: {
      rest:      'Full rest or active recovery',
      easy:      'Easy aerobic swim — 1,500–2,000 m, technique focus',
      medium:    { default: 'Aerobic set — 2,000–2,500 m at cruise pace' },
      long:      { default: 'Endurance set — 3,000–4,000 m, negative split' },
      tempo:     { default: '5×400 m at CSS pace' },
      intervals: { default: '10×100 m at race pace, 20 s rest' },
    },
  },

  _desc(type, phase, sport) {
    const src = (this.DESCS[sport] || this.DESCS.run)[type];
    if (!src) return `${type} session`;
    if (typeof src === 'string') return src;
    return src[phase] || src.default || `${type} session`;
  },

  _allocatePhases(totalWeeks) {
    const taper = Math.max(1, Math.round(totalWeeks * 0.12));
    const peak  = Math.max(1, Math.round(totalWeeks * 0.13));
    const build = Math.max(2, Math.round(totalWeeks * 0.45));
    const base  = Math.max(2, totalWeeks - build - peak - taper);
    return { base, build, peak, taper };
  },

  _phaseAt(weekIdx, alloc) {
    if (weekIdx < alloc.base)                        return 'base';
    if (weekIdx < alloc.base + alloc.build)          return 'build';
    if (weekIdx < alloc.base + alloc.build + alloc.peak) return 'peak';
    return 'taper';
  },

  _targetCTL(weekIdx, startCTL, peakCTL, alloc) {
    const rampEnd = alloc.base + alloc.build;
    const peakEnd = rampEnd + alloc.peak;
    if (weekIdx <= rampEnd) return startCTL + (peakCTL - startCTL) * (weekIdx / rampEnd);
    if (weekIdx <= peakEnd) return peakCTL;
    return peakCTL * (1 - 0.12 * (weekIdx - peakEnd) / alloc.taper);
  },

  generate(raceDate, sport = 'run', currentCTL = 30) {
    const today = todayStr();
    const daysUntil = Math.round(
      (new Date(raceDate + 'T12:00:00') - new Date(today + 'T12:00:00')) / 86400000
    );
    const totalWeeks = Math.round(daysUntil / 7);
    if (totalWeeks < 4 || totalWeeks > 26) return null;

    const alloc   = this._allocatePhases(totalWeeks);
    const baseCTL = Math.max(currentCTL, 20);
    const peakCTL = Math.min(baseCTL + 6 * (alloc.base + alloc.build), baseCTL * 1.65);

    // Start on the Monday of the current week
    const startD = new Date(today + 'T12:00:00');
    const dow = startD.getDay();
    startD.setDate(startD.getDate() - (dow === 0 ? 6 : dow - 1));

    const weeks = [];
    for (let w = 0; w < totalWeeks; w++) {
      const phase     = this._phaseAt(w, alloc);
      const targetCTL = this._targetCTL(w + 1, baseCTL, peakCTL, alloc);
      const weeklyEff = targetCTL * 7;
      const pattern   = this.PATTERNS[phase];
      const totalPct  = pattern.reduce((s, t) => s + this.SESSION[t].effortPct, 0);

      const days = pattern.map((type, i) => {
        const d = new Date(startD);
        d.setDate(d.getDate() + w * 7 + i);
        const effort = totalPct > 0
          ? Math.round(weeklyEff * this.SESSION[type].effortPct / totalPct)
          : 0;
        return {
          date:        localDateStr(d),
          dow:         i,
          sessionType: type,
          label:       this.SESSION[type].label,
          effort,
          description: this._desc(type, phase, sport),
          adapted:     null,
        };
      });

      weeks.push({ weekNum: w + 1, phase, targetCTL: Math.round(targetCTL), days });
    }

    return { createdAt: today, raceDate, sport, startCTL: Math.round(baseCTL), peakCTL: Math.round(peakCTL), totalWeeks, alloc, weeks };
  },

  // Simulate CTL/ATL/TSB forward from today using planned efforts
  project(plan, activities) {
    const today  = todayStr();
    const actual = TrainingLoad.latest(activities);
    let ctl = actual.ctl, atl = actual.atl;
    const out = {};
    for (const week of plan.weeks) {
      for (const day of week.days) {
        if (day.date <= today) continue;
        ctl = ctl + TrainingLoad.K_CTL * (day.effort - ctl);
        atl = atl + TrainingLoad.K_ATL * (day.effort - atl);
        out[day.date] = { ctl: +ctl.toFixed(1), atl: +atl.toFixed(1), tsb: +(ctl - atl).toFixed(1) };
      }
    }
    return out;
  },

  getTodaySession(plan) {
    if (!plan) return null;
    const today = todayStr();
    for (const week of plan.weeks) {
      const day = week.days.find(d => d.date === today);
      if (day) return { day, week };
    }
    return null;
  },

  adaptSession(day, readiness, sport) {
    if (!day || day.sessionType === 'rest') return { ...day, adapted: 'full' };
    if (readiness >= 70) return { ...day, adapted: 'full' };
    if (readiness >= 40) {
      const DOWN = { intervals: 'tempo', tempo: 'medium', long: 'medium', medium: 'easy', easy: 'easy' };
      const newType = DOWN[day.sessionType] || 'easy';
      return {
        ...day, adapted: 'modified', sessionType: newType,
        label:       this.SESSION[newType].label + ' ↓',
        description: 'HRV moderate — scaled back one level. Original: ' + day.description,
        effort:      Math.round(day.effort * 0.65),
      };
    }
    return {
      ...day, adapted: 'recovery', sessionType: 'easy',
      label:       'Recovery (auto)',
      description: 'HRV suppressed — easy recovery or rest today. Reschedule the key session.',
      effort:      Math.round(day.effort * 0.25),
    };
  },

  load()  { try { return JSON.parse(localStorage.getItem(this.KEY) || 'null'); } catch { return null; } },
  save(p) { localStorage.setItem(this.KEY, JSON.stringify(p)); },
  clear() { localStorage.removeItem(this.KEY); },
};

// ── WeatherService ────────────────────────────────────────────────────────────
// Uses Open-Meteo (free, no key required) for historical + forecast weather.

const WeatherService = {
  LAT_KEY:   'wx_lat',
  LON_KEY:   'wx_lon',
  CACHE_KEY: 'wx_cache',
  ELEV_KEY:  'wx_elevation',

  getCoords() {
    const lat = parseFloat(localStorage.getItem(this.LAT_KEY));
    const lon = parseFloat(localStorage.getItem(this.LON_KEY));
    return (!isNaN(lat) && !isNaN(lon)) ? { lat, lon } : null;
  },

  saveCoords(lat, lon) {
    localStorage.setItem(this.LAT_KEY, lat.toFixed(4));
    localStorage.setItem(this.LON_KEY, lon.toFixed(4));
    localStorage.removeItem(this.ELEV_KEY);
  },

  clear() {
    [this.LAT_KEY, this.LON_KEY, this.ELEV_KEY].forEach(k => localStorage.removeItem(k));
  },

  _cacheGet(date) {
    try { return JSON.parse(localStorage.getItem(this.CACHE_KEY) || '{}')[date] ?? null; }
    catch { return null; }
  },

  _cacheSet(date, data) {
    try {
      const c = JSON.parse(localStorage.getItem(this.CACHE_KEY) || '{}');
      c[date] = data;
      const keys = Object.keys(c).sort();
      if (keys.length > 400) keys.slice(0, keys.length - 400).forEach(k => delete c[k]);
      localStorage.setItem(this.CACHE_KEY, JSON.stringify(c));
    } catch {}
  },

  async fetch(date, lat, lon) {
    const hit = this._cacheGet(date);
    if (hit) return hit;

    const isPast = date < todayStr();
    const base   = isPast
      ? 'https://archive-api.open-meteo.com/v1/archive'
      : 'https://api.open-meteo.com/v1/forecast';

    const params = new URLSearchParams({
      latitude:   lat.toFixed(4),
      longitude:  lon.toFixed(4),
      start_date: date,
      end_date:   date,
      daily:      'temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max',
      hourly:     'relativehumidity_2m',
      timezone:   'auto',
    });

    const res = await fetch(`${base}?${params}`);
    if (!res.ok) throw new Error(`Weather API ${res.status}`);
    const j = await res.json();

    // Morning humidity average (hours 6–10)
    const humHours = j.hourly?.relativehumidity_2m?.slice(6, 10) ?? [];
    const humidity = humHours.length
      ? Math.round(humHours.reduce((s, v) => s + v, 0) / humHours.length)
      : null;

    const data = {
      tempMaxC: j.daily?.temperature_2m_max?.[0]  ?? null,
      tempMinC: j.daily?.temperature_2m_min?.[0]  ?? null,
      precipMM: j.daily?.precipitation_sum?.[0]   ?? null,
      windKph:  j.daily?.windspeed_10m_max?.[0]   ?? null,
      humidity,
    };

    if (isPast) this._cacheSet(date, data);
    return data;
  },

  async fetchElevation(lat, lon) {
    const cached = localStorage.getItem(this.ELEV_KEY);
    if (cached !== null) return +cached;
    const res = await fetch(
      `https://api.open-meteo.com/v1/elevation?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`
    );
    if (!res.ok) return null;
    const j    = await res.json();
    const elev = j.elevation?.[0] ?? null;
    if (elev != null) localStorage.setItem(this.ELEV_KEY, String(elev));
    return elev;
  },

  requestLocation() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Geolocation not supported by this browser'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        pos => {
          this.saveCoords(pos.coords.latitude, pos.coords.longitude);
          resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        },
        err => reject(new Error(err.message || 'Location access denied')),
        { timeout: 10000 }
      );
    });
  },

  // Fetch weather for all entries that don't have it yet; saves mutated entries array
  async backfill(entries, onProgress) {
    const coords = this.getCoords();
    if (!coords) return 0;
    const missing = entries.filter(e => e.hrv && !e.weather);
    let count = 0;
    for (const e of missing) {
      try { e.weather = await this.fetch(e.date, coords.lat, coords.lon); count++; } catch {}
      onProgress?.(count, missing.length);
      if (count % 10 === 0) await new Promise(r => setTimeout(r, 100));
    }
    return count;
  },
};

// ── Narrative Engine ──────────────────────────────────────────────────────────
// Uses Claude (Anthropic API) to generate a plain-language monthly fitness
// summary from stored HRV + training data. No backend required — calls the
// API directly from the browser using the user's own API key.

const NarrativeEngine = {
  KEY:     'hrv_narratives',
  API_KEY: 'anthropic_key',

  load()     { try { return JSON.parse(localStorage.getItem(this.KEY) || '[]'); } catch { return []; } },
  save(arr)  { localStorage.setItem(this.KEY, JSON.stringify(arr.slice(0, 24))); },
  getApiKey(){ return localStorage.getItem(this.API_KEY) || ''; },
  saveApiKey(k){ localStorage.setItem(this.API_KEY, k); },
  clearApiKey(){ localStorage.removeItem(this.API_KEY); },
  getForMonth(mk){ return this.load().find(n => n.month === mk) ?? null; },

  prevMonth(mk) {
    const [y, m] = mk.split('-').map(Number);
    return m === 1 ? `${y-1}-12` : `${y}-${String(m-1).padStart(2,'0')}`;
  },

  monthLabel(mk) {
    const NAMES = ['January','February','March','April','May','June',
                   'July','August','September','October','November','December'];
    const [y, m] = mk.split('-').map(Number);
    return `${NAMES[m-1]} ${y}`;
  },

  daysInMonth(mk) {
    const [y, m] = mk.split('-').map(Number);
    return new Date(y, m, 0).getDate();
  },

  // Average days to return to HRV baseline after hard sessions in a date range
  _recovWindow(entries, activities, start, end) {
    const byDate = Object.fromEntries(entries.map(e => [e.date, e]));
    const hard   = activities.filter(a =>
      a.date >= start && a.date <= end && (a.effort || 0) >= RecoveryAnalytics.EFFORT_THRESHOLD
    );
    const lags = [];
    for (const act of hard) {
      const b = AdaptiveBaseline.compute(entries, act.date);
      if (!b) continue;
      for (let lag = 1; lag <= 5; lag++) {
        const d = new Date(act.date + 'T12:00:00');
        d.setDate(d.getDate() + lag);
        const e = byDate[localDateStr(d)];
        if (e?.hrv && e.hrv >= b.baseline) { lags.push(lag); break; }
      }
    }
    return lags.length >= 3
      ? +(lags.reduce((s, v) => s + v, 0) / lags.length).toFixed(1)
      : null;
  },

  computeStats(mk, entries, activities) {
    const [y, m]  = mk.split('-').map(Number);
    const start   = `${mk}-01`;
    const end     = localDateStr(new Date(y, m, 0));
    const prevMk  = this.prevMonth(mk);
    const [py, pm] = prevMk.split('-').map(Number);
    const pStart  = `${prevMk}-01`;
    const pEnd    = localDateStr(new Date(py, pm, 0));

    const avg = arr => arr.reduce((s, v) => s + v, 0) / arr.length;

    const monthE  = entries.filter(e => e.date >= start && e.date <= end && e.hrv > 0);
    const prevE   = entries.filter(e => e.date >= pStart && e.date <= pEnd && e.hrv > 0);
    if (monthE.length < 3) return null;

    const sorted  = monthE.slice().sort((a, b) => a.date.localeCompare(b.date));
    const hrvs    = monthE.map(e => e.hrv);
    const allHRVs = entries.map(e => e.hrv).filter(Boolean);

    const avgHRV   = +avg(hrvs).toFixed(1);
    const maxHRV   = Math.max(...hrvs);
    const minHRV   = Math.min(...hrvs);
    const startHRV = sorted[0].hrv;
    const endHRV   = sorted.at(-1).hrv;
    const prevAvg  = prevE.length >= 5 ? +avg(prevE.map(e => e.hrv)).toFixed(1) : null;
    const allAvg   = allHRVs.length ? +avg(allHRVs).toFixed(1) : null;

    const suppressed = monthE.filter(e => {
      const b = AdaptiveBaseline.compute(entries, e.date);
      return b && AdaptiveBaseline.isSuppressed(e.hrv, b);
    }).length;

    const flagCounts = {};
    monthE.forEach(e => (e.flags||[]).forEach(f => { flagCounts[f] = (flagCounts[f]||0)+1; }));

    const sleepE = monthE.filter(e => e.sleepDuration);
    const avgSleep    = sleepE.length ? +avg(sleepE.map(e => e.sleepDuration)).toFixed(1) : null;
    const shortNights = sleepE.filter(e => e.sleepDuration < 6).length;
    const sqE = monthE.filter(e => e.sleepQuality);
    const avgSQ = sqE.length ? +avg(sqE.map(e => e.sleepQuality)).toFixed(1) : null;

    const s90 = new Date(start); s90.setDate(s90.getDate() - 90);
    const series   = TrainingLoad.compute(activities, localDateStr(s90), end);
    const startLoad = series[start] || { atl: 0, ctl: 0, tsb: 0 };
    const endLoad   = series[end]   || { atl: 0, ctl: 0, tsb: 0 };
    const mDates    = Object.keys(series).filter(d => d >= start && d <= end);
    const peakATL   = mDates.length ? Math.max(...mDates.map(d => series[d].atl)) : 0;
    const peakDay   = mDates.find(d => series[d].atl === peakATL);

    const monthActs = activities.filter(a => a.date >= start && a.date <= end);
    const typeCounts = {};
    monthActs.forEach(a => {
      const t = a.mappedType || a.type || 'Other';
      typeCounts[t] = (typeCounts[t]||0) + 1;
    });

    const wxE = monthE.filter(e => e.weather?.tempMaxC != null);
    const avgTemp   = wxE.length ? +avg(wxE.map(e => e.weather.tempMaxC)).toFixed(0) : null;
    const rainyDays = monthE.filter(e => (e.weather?.precipMM ?? 0) > 1).length;

    return {
      mk, start, end, label: this.monthLabel(mk),
      daysLogged: monthE.length, daysInMonth: this.daysInMonth(mk),
      avgHRV, maxHRV, minHRV,
      maxDay: monthE.find(e => e.hrv === maxHRV)?.date,
      minDay: monthE.find(e => e.hrv === minHRV)?.date,
      startHRV, endHRV, prevAvg, allAvg, suppressed, flagCounts,
      avgSleep, shortNights, avgSQ,
      startLoad, endLoad, peakATL, peakDay,
      totalSessions: monthActs.length, typeCounts,
      races: monthActs.filter(a => a.isRace && a.raceConfirmed).map(r => ({ name: r.name, date: r.date })),
      recovWindow:     this._recovWindow(entries, activities, start, end),
      prevRecovWindow: this._recovWindow(entries, activities, pStart, pEnd),
      avgTemp, rainyDays, wxDays: wxE.length,
    };
  },

  buildPrompt(s) {
    const fd = d => d ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric' }) : '?';
    const dlt = (a, b) => a != null && b != null
      ? (a - b >= 0 ? `+${(a-b).toFixed(1)}` : `${(a-b).toFixed(1)}`)
      : null;

    const lines = [
      `Month: ${s.label}`,
      `Days logged: ${s.daysLogged} / ${s.daysInMonth}`,
      ``,
      `HRV:`,
      `  Average: ${s.avgHRV} ms${s.prevAvg ? ` (prior month: ${s.prevAvg} ms, ${dlt(s.avgHRV, s.prevAvg)} ms)` : ''}`,
      `  Range: ${s.minHRV} ms (${fd(s.minDay)}) – ${s.maxHRV} ms (${fd(s.maxDay)})`,
      `  Arc: ${s.startHRV} ms at start → ${s.endHRV} ms at end (${s.endHRV > s.startHRV ? 'rising' : s.endHRV < s.startHRV ? 'falling' : 'flat'})`,
      `  Suppression events: ${s.suppressed} day${s.suppressed !== 1 ? 's' : ''}`,
      s.allAvg ? `  All-time mean: ${s.allAvg} ms  (this month is ${dlt(s.avgHRV, s.allAvg)} ms)` : null,
      Object.keys(s.flagCounts).length
        ? `  Flags: ${Object.entries(s.flagCounts).map(([f,n])=>`${f} ×${n}`).join(', ')}`
        : null,
      ``,
      `Training:`,
      s.totalSessions > 0
        ? `  Sessions: ${s.totalSessions}${Object.keys(s.typeCounts).length ? ' ('+Object.entries(s.typeCounts).map(([t,n])=>`${t} ×${n}`).join(', ')+')' : ''}`
        : `  Sessions: 0 (no activity data logged)`,
      s.endLoad.ctl > 0 ? `  Fitness (CTL): ${s.startLoad.ctl.toFixed(0)} → ${s.endLoad.ctl.toFixed(0)} (${dlt(s.endLoad.ctl, s.startLoad.ctl)})` : null,
      s.endLoad.atl > 0 ? `  Fatigue (ATL): started at ${s.startLoad.atl.toFixed(0)}, peaked at ${s.peakATL.toFixed(0)}, ended at ${s.endLoad.atl.toFixed(0)}` : null,
      (s.startLoad.tsb !== 0 || s.endLoad.tsb !== 0)
        ? `  Form (TSB): ${s.startLoad.tsb.toFixed(0)} → ${s.endLoad.tsb.toFixed(0)}`
        : null,
      s.races.length ? `  Races: ${s.races.map(r=>`${r.name} (${fd(r.date)})`).join(', ')}` : null,
      ``,
      `Recovery:`,
      s.recovWindow != null
        ? `  Avg days to HRV baseline after hard sessions: ${s.recovWindow}${s.prevRecovWindow != null ? ` (prior month: ${s.prevRecovWindow} — ${s.recovWindow < s.prevRecovWindow ? 'improving ↑' : s.recovWindow > s.prevRecovWindow ? 'slower ↓' : 'unchanged'})` : ''}`
        : `  Insufficient hard-session data`,
      ``,
      `Sleep:`,
      s.avgSleep != null ? `  Average: ${s.avgSleep}h / night` : `  No sleep data logged`,
      s.avgSQ != null ? `  Quality: ${s.avgSQ}/5` : null,
      s.shortNights > 0 ? `  Short nights (<6h): ${s.shortNights}` : null,
    ];

    if (s.wxDays >= 5) {
      lines.push(``, `Weather:`, `  Avg max temperature: ${s.avgTemp}°C, rainy days: ${s.rainyDays}`);
    }

    return lines.filter(l => l !== null).join('\n');
  },

  async generate(mk, apiKey, entries, activities) {
    const stats = this.computeStats(mk, entries, activities);
    if (!stats) throw new Error('Not enough data — log at least 3 days in this month.');

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'x-api-key':                               apiKey,
        'anthropic-version':                       '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'content-type':                            'application/json',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system: `You are an experienced endurance performance coach writing a monthly fitness narrative for an athlete. Based on their HRV and training data, write 2–3 flowing paragraphs (150–220 words). Be specific with numbers. Sound like a real coach speaking directly to the athlete — honest, analytical, encouraging. Cover what changed and why it matters, any patterns worth noting, and one concrete priority for next month. No bullet points, no headers, no markdown.`,
        messages: [{ role: 'user', content: this.buildPrompt(stats) }],
      }),
    });

    if (res.status === 401) throw new Error('Invalid API key — check your Anthropic key in Connect → AI Narratives.');
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `API error ${res.status}`);
    }
    const j    = await res.json();
    const text = j.content?.[0]?.text?.trim() || '';
    if (!text) throw new Error('Empty response from API.');

    const narrative = {
      month: mk, label: stats.label, text,
      generatedAt: Date.now(),
      stats: {
        daysLogged: stats.daysLogged, avgHRV: stats.avgHRV, prevAvg: stats.prevAvg,
        suppressed: stats.suppressed, totalSessions: stats.totalSessions,
        recovWindow: stats.recovWindow,
      },
    };
    this.save([narrative, ...this.load().filter(n => n.month !== mk)]);
    return narrative;
  },

  // On app load: silently generate last completed month if API key is set and narrative is missing
  async autoGenerate(entries, activities) {
    const key = this.getApiKey();
    if (!key) return;
    const now  = new Date();
    const prev = this.prevMonth(`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`);
    if (this.getForMonth(prev)) return;
    const [py, pm] = prev.split('-').map(Number);
    const pStart = `${prev}-01`, pEnd = localDateStr(new Date(py, pm, 0));
    if (entries.filter(e => e.date >= pStart && e.date <= pEnd).length < 3) return;
    try { await this.generate(prev, key, entries, activities); } catch {}
  },
};

// ── Recovery analytics ────────────────────────────────────────────────────────

const RecoveryAnalytics = {
  EFFORT_THRESHOLD: 40,

  baselineHRV(entries) {
    const vals = entries.slice(0, 28).map(e => e.hrv).filter(v => v > 0);
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
  },

  // Returns { activityType: { '1': avgPctChange, '2': ..., '3': ... } }
  correlations(activities, entries) {
    const baseline = this.baselineHRV(entries);
    if (!baseline || entries.length < 10) return {};
    const byDate = Object.fromEntries(entries.map(e => [e.date, e]));
    const data = {};
    for (const act of activities) {
      if ((act.effort || 0) < this.EFFORT_THRESHOLD) continue;
      for (let lag = 1; lag <= 3; lag++) {
        const d = new Date(act.date + 'T12:00:00');
        d.setDate(d.getDate() + lag);
        const entry = byDate[d.toISOString().slice(0, 10)];
        if (!entry?.hrv) continue;
        const pct = ((entry.hrv - baseline) / baseline) * 100;
        ((data[act.mappedType] ??= {})[lag] ??= []).push(pct);
      }
    }
    const out = {};
    for (const [type, lags] of Object.entries(data)) {
      for (const [lag, vals] of Object.entries(lags)) {
        if (vals.length < 3) continue;
        (out[type] ??= {})[lag] = +(vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(1);
      }
    }
    return out;
  },

  isPostWorkoutSuppression(entry, activities, entries) {
    const baseline = this.baselineHRV(entries);
    if (!baseline || !entry.hrv) return false;
    if ((entry.hrv - baseline) / baseline > -0.08) return false;
    const prev = new Date(entry.date + 'T12:00:00');
    prev.setDate(prev.getDate() - 1);
    const prevStr = prev.toISOString().slice(0, 10);
    return activities.some(a => a.date === prevStr && (a.effort || 0) >= this.EFFORT_THRESHOLD);
  },
};

function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function todayStr()     { return localDateStr(); }
function yesterdayStr() { const d = new Date(); d.setDate(d.getDate() - 1); return localDateStr(d); }

// ── Strava ───────────────────────────────────────────────────────────────────

const Strava = {
  ACTIVITY_MAP: {
    Run: 'Running', VirtualRun: 'Running',
    Ride: 'Cycling', VirtualRide: 'Cycling', EBikeRide: 'Cycling',
    WeightTraining: 'Strength training', Workout: 'Strength training',
    Yoga: 'Yoga',
    Walk: 'Walking', Hike: 'Walking',
    Swim: 'Swimming',
    Meditation: 'Meditation',
  },

  get config() {
    try { return JSON.parse(localStorage.getItem('strava_config') || 'null'); }
    catch { return null; }
  },

  get token() {
    try { return JSON.parse(localStorage.getItem('strava_token') || 'null'); }
    catch { return null; }
  },

  isConnected() {
    const t = this.token;
    return !!(t && t.access_token && t.expires_at > Math.floor(Date.now() / 1000));
  },

  redirectUri() {
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    return url.toString();
  },

  domain() {
    return window.location.hostname || 'localhost';
  },

  authorize(clientId) {
    const url = new URL('https://www.strava.com/oauth/authorize');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', this.redirectUri());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('approval_prompt', 'auto');
    url.searchParams.set('scope', 'activity:read_all,profile:read_all');
    window.location.href = url.toString();
  },

  async exchangeCode(code) {
    const cfg = this.config;
    if (!cfg) throw new Error('No Strava config found');
    const res = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id:     cfg.clientId,
        client_secret: cfg.clientSecret,
        code,
        grant_type: 'authorization_code',
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || 'Token exchange failed');
    }
    const data = await res.json();
    localStorage.setItem('strava_token', JSON.stringify(data));
    return data;
  },

  async refreshIfNeeded() {
    const t = this.token;
    if (!t) return false;
    if (t.expires_at > Math.floor(Date.now() / 1000) + 300) return true;
    const cfg = this.config;
    if (!cfg) return false;
    try {
      const res = await fetch('https://www.strava.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id:     cfg.clientId,
          client_secret: cfg.clientSecret,
          refresh_token: t.refresh_token,
          grant_type: 'refresh_token',
        }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      localStorage.setItem('strava_token', JSON.stringify({ ...t, ...data }));
      return true;
    } catch { return false; }
  },

  async fetchActivitiesForDate(dateStr) {
    await this.refreshIfNeeded();
    const t = this.token;
    if (!t) throw new Error('Not connected');
    const after  = Math.floor(new Date(dateStr + 'T00:00:00').getTime() / 1000);
    const before = Math.floor(new Date(dateStr + 'T23:59:59').getTime() / 1000);
    const res = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?after=${after}&before=${before}&per_page=20`,
      { headers: { Authorization: `Bearer ${t.access_token}` } }
    );
    if (!res.ok) throw new Error('Failed to fetch activities');
    return res.json();
  },

  disconnect() {
    localStorage.removeItem('strava_token');
  },

  mapType(stravaType) {
    return this.ACTIVITY_MAP[stravaType] || stravaType;
  },
};

// ── Garmin CSV parser ─────────────────────────────────────────────────────────

const Garmin = {
  parseCSVLine(line) {
    const values = [];
    let cur = '', inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { values.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    values.push(cur.trim());
    return values;
  },

  parse(text) {
    const lines = text.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) throw new Error('CSV has no data rows');

    const rawHeaders = this.parseCSVLine(lines[0]);
    const headers = rawHeaders.map(h => h.replace(/"/g, '').trim().toLowerCase());

    const col = (names) => {
      for (const n of names) {
        const i = headers.indexOf(n);
        if (i >= 0) return i;
      }
      return -1;
    };

    // Determine format: activities vs health summary
    const actTypeIdx = col(['activity type', 'activity_type', 'type']);
    const dateIdx    = col(['date', 'calendardate', 'calendar_date', 'date (local)', 'timestamp']);
    const hrvIdx     = col([
      'lastnight5minhigh', 'hrv7dayaverage', 'avg_hrv', 'avghrv', 'hrv_ms', 'hrv',
      'lastnight hrv', 'hrv status', 'rmssd',
    ]);
    const sleepIdx   = col(['sleepscore', 'sleep_score', 'sleep score', 'avgsleepduration']);
    const stressIdx  = col(['avgstresslevel', 'avg_stress', 'stress', 'averagestresslevel']);
    const distIdx    = col(['distance']);
    const timeIdx    = col(['time', 'duration', 'elapsed time']);

    if (dateIdx < 0) throw new Error('Could not find a Date column in this CSV');

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const vals = this.parseCSVLine(lines[i]);
      const get  = (idx) => idx >= 0 ? (vals[idx] || '').replace(/"/g, '').trim() : '';

      const rawDate = get(dateIdx);
      if (!rawDate) continue;
      const date = rawDate.slice(0, 10); // YYYY-MM-DD
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

      if (actTypeIdx >= 0) {
        // Activities format
        const rawType = get(actTypeIdx);
        if (!rawType) continue;
        rows.push({
          kind:     'activity',
          date,
          activity: this.mapActivityType(rawType),
          distance: get(distIdx),
          time:     get(timeIdx),
        });
      } else {
        // Health summary format
        const hrv    = parseFloat(get(hrvIdx))   || null;
        const sleep  = parseFloat(get(sleepIdx)) || null;
        const stress = parseFloat(get(stressIdx))|| null;
        if (!hrv && !sleep && !stress) continue;
        rows.push({ kind: 'health', date, hrv, sleep, stress });
      }
    }

    if (!rows.length) throw new Error('No usable rows found in CSV');
    return rows;
  },

  mapActivityType(raw) {
    const t = raw.toLowerCase().replace(/[\s-]/g, '_');
    const map = {
      running: 'Running', trail_running: 'Running', treadmill_running: 'Running',
      cycling: 'Cycling', indoor_cycling: 'Cycling', biking: 'Cycling',
      strength_training: 'Strength training', weight_training: 'Strength training',
      yoga: 'Yoga',
      walking: 'Walking', hiking: 'Walking',
      swimming: 'Swimming', open_water_swimming: 'Swimming',
      meditation: 'Meditation',
      rest: 'Rest day',
    };
    return map[t] || raw;
  },
};

// ── AdaptiveBaseline ──────────────────────────────────────────────────────────

const AdaptiveBaseline = {
  // Computes 60-day rolling baseline (HRV from entries *before* asOfDate)
  compute(entries, asOfDate) {
    const day = new Date(asOfDate + 'T12:00:00');
    day.setDate(day.getDate() - 1);
    const start = new Date(day); start.setDate(start.getDate() - 59);
    const window = entries
      .filter(e => e.date >= start.toISOString().slice(0,10) && e.date <= day.toISOString().slice(0,10) && e.hrv > 0)
      .map(e => e.hrv);
    if (window.length < 7) return null;
    const mean = window.reduce((s,v)=>s+v,0) / window.length;
    const sd   = Math.sqrt(window.reduce((s,v)=>s+Math.pow(v-mean,2),0) / window.length);
    return { baseline: +mean.toFixed(1), stdDev: +sd.toFixed(1), n: window.length, threshold: +(mean - sd).toFixed(1) };
  },
  isSuppressed(hrv, b) { return b != null && hrv < b.threshold; },
  consecutiveSuppressedDays(entries, asOfDate) {
    let count = 0;
    const sorted = [...entries].sort((a,b)=>b.date.localeCompare(a.date));
    for (const e of sorted) {
      if (e.date > asOfDate) continue;
      const b = this.compute(entries, e.date);
      if (b && e.hrv && this.isSuppressed(e.hrv, b)) count++;
      else break;
    }
    return count;
  },
};

// ── ReadinessScore ────────────────────────────────────────────────────────────

const ReadinessScore = {
  WEIGHTS: { hrv: 0.5, trend: 0.2, sleep: 0.2, subjective: 0.1 },
  compute(entry, entries) {
    const b = AdaptiveBaseline.compute(entries, entry.date);
    let hrvScore = 50;
    if (b && entry.hrv) {
      const dev = (entry.hrv - b.baseline) / Math.max(b.stdDev, 1);
      hrvScore = Math.max(0, Math.min(100, 50 + dev * 25));
    }
    // 3-day trend — filter before entry.date so this works even for unsaved entries
    const sorted = [...entries].sort((a,b)=>a.date.localeCompare(b.date));
    const recent = sorted.filter(e => e.date < entry.date).slice(-3).map(e=>e.hrv).filter(Boolean);
    let trendScore = 50;
    if (recent.length >= 2) {
      const chg = (recent.at(-1) - recent[0]) / recent[0] * 100;
      trendScore = Math.max(0, Math.min(100, 50 + chg * 5));
    }
    // Sleep
    let sleepScore = 50;
    if (entry.sleepDuration) {
      const h = entry.sleepDuration;
      sleepScore = h >= 9 ? 90 : h >= 7 ? 70 + (h-7)*20 : h >= 5 ? 30 + (h-5)*20 : h*6;
    }
    // sleepQuality is 1-5 tap scale; fall back to old sleep slider (1-10)
    const rawQuality = entry.sleepQuality ? (entry.sleepQuality / 5) * 100 : (entry.sleep / 10) * 100;
    sleepScore = (sleepScore + rawQuality) / 2;
    const feelMap = {4: 100, 3: 70, 2: 45, 1: 15};
    const subjectiveScore = entry.feelToday ? (feelMap[entry.feelToday] ?? 50) : (entry.mood / 10) * 100;
    const W = this.WEIGHTS;
    const baseScore =
      hrvScore * W.hrv + trendScore * W.trend + sleepScore * W.sleep + subjectiveScore * W.subjective;
    // Apply flag penalties: illness -15, others -8 each
    const flags = entry.flags || [];
    const flagPenalty = (flags.includes('illness') ? 15 : 0)
      + flags.filter(f => f !== 'illness').length * 8;
    const score = Math.round(Math.max(0, Math.min(100, baseScore - flagPenalty)));
    return {
      score,
      inputs: { hrvScore: +hrvScore.toFixed(1), trendScore: +trendScore.toFixed(1), sleepScore: +sleepScore.toFixed(1), subjectiveScore: +subjectiveScore.toFixed(1), weights: {...W}, baseline: b },
    };
  },
  label(score) {
    if (score >= 70) return { text: 'Optimal',  cls: 'rs-green',  color: '#34d399' };
    if (score >= 40) return { text: 'Moderate', cls: 'rs-yellow', color: '#fbbf24' };
    return               { text: 'Low',      cls: 'rs-red',    color: '#f87171' };
  },
};

// ── SuppressionAlerts ─────────────────────────────────────────────────────────

const SuppressionAlerts = {
  SUGGESTIONS: [
    'Reduce training intensity or take a full rest day.',
    'Prioritise 8+ hours of sleep tonight.',
    'Consider a 20-minute walk instead of your planned session.',
    'Avoid alcohol and increase protein to support recovery.',
    'Consistent sleep schedule, dark room, no screens 30 min before bed.',
  ],
  load() { try { return JSON.parse(localStorage.getItem('suppression_alerts')||'[]'); } catch { return []; } },
  save(alerts) { localStorage.setItem('suppression_alerts', JSON.stringify(alerts.slice(0,100))); },
  check(entries) {
    const today = todayStr();
    const n = AdaptiveBaseline.consecutiveSuppressedDays(entries, today);
    if (n < 3) return null;
    const existing = this.load().find(a => a.date === today);
    if (existing) return null;
    const alert = { id: Date.now(), date: today, type: 'possible_overreach', consecutiveDays: n,
      suggestion: this.SUGGESTIONS[n % this.SUGGESTIONS.length], acknowledged: false };
    this.save([alert, ...this.load()]);
    return alert;
  },
  acknowledge(id) {
    const alerts = this.load().map(a => a.id === id ? {...a, acknowledged: true} : a);
    this.save(alerts);
  },
};

// ── WeeklyDigest ──────────────────────────────────────────────────────────────

const WeeklyDigest = {
  load() { try { return JSON.parse(localStorage.getItem('weekly_digests')||'[]'); } catch { return []; } },
  tryGenerate(entries, activities) {
    if (new Date().getDay() !== 0) return null;
    const weekEnd = todayStr();
    if (this.load().find(d=>d.weekEnding===weekEnd)) return null;
    const weekStart = new Date(weekEnd+'T12:00:00'); weekStart.setDate(weekStart.getDate()-6);
    const ws = weekStart.toISOString().slice(0,10);
    const priorEnd = new Date(weekStart); priorEnd.setDate(priorEnd.getDate()-1);
    const priorStart = new Date(priorEnd); priorStart.setDate(priorStart.getDate()-6);
    const thisW  = entries.filter(e=>e.date>=ws && e.date<=weekEnd);
    const priorW = entries.filter(e=>e.date>=priorStart.toISOString().slice(0,10) && e.date<=priorEnd.toISOString().slice(0,10));
    const avg = arr => arr.length ? arr.reduce((s,v)=>s+v,0)/arr.length : null;
    const avgHRV = avg(thisW.map(e=>e.hrv).filter(Boolean));
    const priorAvgHRV = avg(priorW.map(e=>e.hrv).filter(Boolean));
    const avgSleep = avg(thisW.map(e=>e.sleepDuration).filter(Boolean));
    const loadSeries = TrainingLoad.compute(activities, ws, weekEnd);
    const totalATL = avg(Object.values(loadSeries).map(d=>d.atl)) || 0;
    const tsbEnd = loadSeries[weekEnd]?.tsb || 0;
    const suppressionEvents = thisW.filter(e=>{const b=AdaptiveBaseline.compute(entries,e.date);return b&&e.hrv&&AdaptiveBaseline.isSuppressed(e.hrv,b);}).length;
    const hrvChange = (priorAvgHRV&&avgHRV) ? ((avgHRV-priorAvgHRV)/priorAvgHRV*100).toFixed(0) : null;
    const parts = [];
    if (hrvChange!==null) parts.push(+hrvChange>3?`HRV up ${hrvChange}%`:+hrvChange<-3?`HRV down ${Math.abs(hrvChange)}%`:'HRV steady');
    if (avgSleep) parts.push(avgSleep>=7.5?`sleep averaged ${(+avgSleep).toFixed(1)}h`:`sleep short at ${(+avgSleep).toFixed(1)}h — prioritise rest`);
    parts.push(totalATL<20?'load was light':totalATL<50?'load was moderate':'load was high');
    if (suppressionEvents>=3) parts.push(`${suppressionEvents} suppression days — watch your load`);
    const tsbNote = tsbEnd>10?"You're entering next week fresh.":tsbEnd>-5?"Entering next week balanced.":"Entering next week carrying fatigue — consider an easy start.";
    const body = parts.join(', ')+'.';
    const summary = body.charAt(0).toUpperCase()+body.slice(1)+' '+tsbNote;
    const digest = { weekEnding:weekEnd, weekStarting:ws, avgHRV:avgHRV?+avgHRV.toFixed(1):null, priorAvgHRV:priorAvgHRV?+priorAvgHRV.toFixed(1):null, avgSleep:avgSleep?+avgSleep.toFixed(1):null, totalATL:+totalATL.toFixed(1), tsbEntering:tsbEnd, suppressionEvents, summary, generatedAt:Date.now() };
    this.save([digest, ...this.load()].slice(0,52));
    return digest;
  },
  save(d) { localStorage.setItem('weekly_digests', JSON.stringify(d)); },
};

// ── RecoveryCurve ─────────────────────────────────────────────────────────────

const RecoveryCurve = {
  compute(entries, activities) {
    const byType = {};
    for (const act of activities.filter(a=>(a.effort||0)>=RecoveryAnalytics.EFFORT_THRESHOLD)) {
      const b = AdaptiveBaseline.compute(entries, act.date);
      if (!b) continue;
      let days = null;
      for (let d=1; d<=14; d++) {
        const cd = new Date(act.date+'T12:00:00'); cd.setDate(cd.getDate()+d);
        const e = entries.find(e=>e.date===cd.toISOString().slice(0,10));
        if (e?.hrv && Math.abs(e.hrv-b.baseline)/b.baseline<=0.05) { days=d; break; }
      }
      if (days!==null) (byType[act.mappedType]??=[]).push(days);
    }
    return Object.entries(byType)
      .filter(([,d])=>d.length>=2)
      .map(([type,days])=>({ type, avgDays:+(days.reduce((s,v)=>s+v,0)/days.length).toFixed(1), count:days.length }))
      .sort((a,b)=>b.avgDays-a.avgDays);
  },
};

// ── InsightCards ──────────────────────────────────────────────────────────────

const InsightCards = {
  STORAGE: 'insight_cards_dismissed',
  load() { try { return JSON.parse(localStorage.getItem(this.STORAGE)||'[]'); } catch { return []; } },
  isDismissed(key) { return this.load().includes(key); },
  dismiss(key) { const d = this.load(); if (!d.includes(key)) { d.push(key); localStorage.setItem(this.STORAGE, JSON.stringify(d.slice(-50))); } },
};

// ── InsightEngine ─────────────────────────────────────────────────────────────

const InsightEngine = {
  generate(entries, activities) {
    const insights = [];
    // Rule 1: consecutive suppression
    const consec = AdaptiveBaseline.consecutiveSuppressedDays(entries, todayStr());
    if (consec >= 2) insights.push({ priority:1, icon:'⚠️', text:`You've been below your HRV baseline for ${consec} consecutive days — consider reducing intensity today.` });
    // Rule 2: high form window
    const load = TrainingLoad.latest(activities);
    if (load.tsb > 15 && load.ctl > 20) insights.push({ priority:2, icon:'🎯', text:`Form score is +${load.tsb} with high fitness — a good window for a hard effort or race.` });
    // Rule 3: morning vs evening timing
    const mve = this._morningVsEvening(activities, entries);
    if (mve) insights.push({ priority:3, ...mve });
    // Rule 4: HRV rising streak
    const sorted = [...entries].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,7);
    const rising = sorted.length>=5 && sorted.every((e,i)=>i===0||e.hrv<=sorted[i-1].hrv);
    if (rising) insights.push({ priority:2, icon:'📈', text:`HRV has trended up for ${sorted.length} consecutive days — strong recovery signal.` });
    // Rule 5: pre-PR pattern
    const prIns = this._prPattern(activities, entries);
    if (prIns) insights.push({ priority:3, ...prIns });
    return insights.sort((a,b)=>a.priority-b.priority).slice(0,5);
  },
  _morningVsEvening(activities, entries) {
    const byDate = Object.fromEntries(entries.map(e=>[e.date,e]));
    const m=[], ev=[];
    for (const act of activities) {
      if (!act.startTime) continue;
      const hr = new Date(act.startTime).getHours();
      const nd = new Date(act.date+'T12:00:00'); nd.setDate(nd.getDate()+1);
      const ne = byDate[nd.toISOString().slice(0,10)];
      const b  = AdaptiveBaseline.compute(entries, act.date);
      if (!ne?.hrv||!b) continue;
      const pct = (ne.hrv-b.baseline)/b.baseline*100;
      if (hr<12) m.push(pct); else if (hr>=17) ev.push(pct);
    }
    if (m.length<3||ev.length<3) return null;
    const am = m.reduce((s,v)=>s+v,0)/m.length, ae = ev.reduce((s,v)=>s+v,0)/ev.length;
    if (Math.abs(am-ae)<5) return null;
    const better = am>ae?'morning':'evening', diff = Math.abs(am-ae).toFixed(0);
    return { icon:'🕐', text:`Your HRV is ${diff}% higher the day after ${better} workouts vs ${am>ae?'evening':'morning'} workouts.` };
  },
  _prPattern(activities, entries) {
    const races = activities.filter(a=>a.isRace&&a.raceConfirmed);
    if (races.length<3) return null;
    const hrvsPreRace = races.map(r=>{
      const d7=new Date(r.date+'T12:00:00'); d7.setDate(d7.getDate()-7);
      const w=entries.filter(e=>e.date>=d7.toISOString().slice(0,10)&&e.date<r.date&&e.hrv);
      return w.length?w.reduce((s,e)=>s+e.hrv,0)/w.length:null;
    }).filter(Boolean);
    if (hrvsPreRace.length<3) return null;
    const avg = (hrvsPreRace.reduce((s,v)=>s+v,0)/hrvsPreRace.length).toFixed(0);
    return { icon:'🏆', text:`Your last ${hrvsPreRace.length} races had a pre-race 7-day avg HRV of ${avg} ms. Use this as your target readiness window.` };
  },
};

// ── Notifications ─────────────────────────────────────────────────────────────

const Notifs = {
  async request() {
    if (!('Notification' in window)||Notification.permission==='denied') return false;
    if (Notification.permission==='granted') return true;
    return (await Notification.requestPermission())==='granted';
  },
  async send(title, body, tag='hrv') {
    if (Notification.permission!=='granted') return;
    const n = new Notification(title, { body, icon:'./icon.png', tag, badge:'./icon.png' });
    setTimeout(()=>n.close(), 10000);
  },
  async checkAll(entries, activities) {
    const alert = SuppressionAlerts.check(entries);
    if (alert) await this.send('HRV Tracker — Possible Overreach', `${alert.consecutiveDays} days below baseline. ${alert.suggestion}`, 'suppression');
    const digest = WeeklyDigest.tryGenerate(entries, activities);
    if (digest) await this.send('Weekly HRV Digest', digest.summary, 'weekly-digest');
    if (Notification.permission === 'granted') {
      const now = new Date();
      const todayEntry = entries.find(e => e.date === todayStr());

      // Morning check-in reminder
      const morningTime = localStorage.getItem('notif_time');
      if (morningTime) {
        const [h, m] = morningTime.split(':').map(Number);
        const target = new Date(); target.setHours(h, m, 0, 0);
        const lastNotif = parseInt(localStorage.getItem('last_checkin_notif')||'0',10);
        if (Math.abs(now - target) < 5*60*1000 && !todayEntry && Date.now()-lastNotif > 23*3600*1000) {
          localStorage.setItem('last_checkin_notif', String(Date.now()));
          await this.send('Time to log your HRV!', 'Open HRV Tracker to log today\'s check-in.', 'checkin');
        }
      }

      // End-of-day reminder — fires if no entry yet, or entry is missing key fields
      const eodTime = localStorage.getItem('notif_eod_time');
      if (eodTime) {
        const [h, m] = eodTime.split(':').map(Number);
        const target = new Date(); target.setHours(h, m, 0, 0);
        const lastEod = parseInt(localStorage.getItem('last_eod_notif')||'0',10);
        const entryIncomplete = !todayEntry || !todayEntry.activities?.length || !todayEntry.sleepDuration;
        if (Math.abs(now - target) < 5*60*1000 && entryIncomplete && Date.now()-lastEod > 23*3600*1000) {
          localStorage.setItem('last_eod_notif', String(Date.now()));
          const msg = !todayEntry
            ? "You haven't logged today yet — add your HRV and how you felt."
            : "Don't forget to log today's activities and sleep before bed.";
          await this.send('Complete today\'s log', msg, 'eod-reminder');
        }
      }
    }
  },
};

// ── OAuth callback (runs on page load) ───────────────────────────────────────

(async function handleOAuthCallback() {
  const params = new URLSearchParams(window.location.search);
  const code   = params.get('code');
  const error  = params.get('error');

  if (!code && !error) return;

  // Clean URL immediately
  window.history.replaceState({}, '', window.location.pathname);

  if (error) {
    alert('Strava authorization was denied or cancelled.');
    return;
  }

  if (code) {
    try {
      const data = await Strava.exchangeCode(code);
      const name = data.athlete
        ? `${data.athlete.firstname} ${data.athlete.lastname}`.trim()
        : 'Athlete';
      localStorage.setItem('strava_athlete', name);
      setTimeout(async () => {
        document.querySelector('[data-tab="connect"]')?.click();
        updateStravaUI();
        // Backfill 90 days on first connect
        try {
          const n = await StravaSync.backfill(90, t => updateSyncProgress(t));
          updateSyncProgress(`Synced ${n} activities from the last 90 days.`, true);
          updateStravaUI();
          StravaSync.processRaceQueue();
        } catch (err) {
          updateSyncProgress(`Backfill failed: ${err.message}`, true);
        }
      }, 100);
    } catch (err) {
      alert(`Strava connection failed: ${err.message}`);
    }
  }
})();

// ── Today's Session Card (Log tab) ───────────────────────────────────────────

function renderTodaySession() {
  const el = document.getElementById('today-session-card');
  if (!el) return;

  const plan = TrainingPlan.load();
  const result = TrainingPlan.getTodaySession(plan);
  if (!plan || !result) { el.classList.add('hidden'); return; }

  let { day, week } = result;
  const phaseInfo = TrainingPlan.PHASES[week.phase];

  // Adapt if today is already logged
  const todayEntry = loadEntries().find(e => e.date === todayStr());
  if (todayEntry) {
    const rs = ReadinessScore.compute(todayEntry, loadEntries());
    day = TrainingPlan.adaptSession(day, rs.score, plan.sport);
  }

  const sInfo = TrainingPlan.SESSION[day.sessionType] || TrainingPlan.SESSION.easy;
  const adaptedTag = !todayEntry
    ? `<span class="tsc-tag">Log HRV to adapt</span>`
    : day.adapted === 'full'
    ? `<span class="tsc-tag tsc-tag-full">On plan ✓</span>`
    : day.adapted === 'modified'
    ? `<span class="tsc-tag tsc-tag-mod">Modified ↓</span>`
    : `<span class="tsc-tag tsc-tag-rec">Recovery ↓</span>`;

  el.classList.remove('hidden');
  el.innerHTML = `
    <div class="tsc-header">
      <div class="tsc-dot" style="background:${sInfo.color}"></div>
      <div class="tsc-type">${day.label}</div>
      ${adaptedTag}
      <div class="tsc-phase" style="color:${phaseInfo.color}">${phaseInfo.label}</div>
    </div>
    <div class="tsc-desc">${day.description}</div>`;
}

// ── Training Plan Section (Trends tab) ───────────────────────────────────────

function renderPlanSection() {
  const el = document.getElementById('plan-section');
  if (!el) return;

  const plan = TrainingPlan.load();

  if (!plan) {
    const goal = RaceGoal.load();
    el.innerHTML = `
      <div class="plan-setup">
        <div class="plan-setup-row">
          <div class="plan-field">
            <label>Race date</label>
            <input type="date" id="plan-race-date" value="${goal?.date || ''}" />
          </div>
          <div class="plan-field">
            <label>Sport</label>
            <select id="plan-sport">
              <option value="run">Run</option>
              <option value="bike">Bike</option>
              <option value="swim">Swim</option>
            </select>
          </div>
        </div>
        <button type="button" id="plan-generate-btn">Generate Plan</button>
        <p class="footnote" style="margin-top:8px">Builds a periodized Base → Build → Peak → Taper plan from today to your race. Each morning, your HRV readiness score automatically upgrades or downscales the day's session.</p>
      </div>`;

    document.getElementById('plan-generate-btn')?.addEventListener('click', () => {
      const raceDate = document.getElementById('plan-race-date')?.value;
      const sport    = document.getElementById('plan-sport')?.value || 'run';
      if (!raceDate) { alert('Pick a race date first.'); return; }
      const currentCTL = TrainingLoad.latest(loadActivities()).ctl || 30;
      const newPlan = TrainingPlan.generate(raceDate, sport, currentCTL);
      if (!newPlan) { alert('Race must be 4–26 weeks away to generate a plan.'); return; }
      TrainingPlan.save(newPlan);
      renderPlanSection();
      renderTodaySession();
      renderLoadChart(+rangeSelect.value);
    });
    return;
  }

  const today      = todayStr();
  const projection = TrainingPlan.project(plan, loadActivities());
  const daysLeft   = Math.round((new Date(plan.raceDate + 'T12:00:00') - new Date(today + 'T12:00:00')) / 86400000);
  const raceProj   = projection[plan.raceDate];

  // Phase timeline bar
  const totalW   = plan.totalWeeks;
  const phaseBar = Object.entries(plan.alloc).map(([phase, wks]) => {
    const pct   = (wks / totalW * 100).toFixed(1);
    const info  = TrainingPlan.PHASES[phase];
    return `<div class="plan-phase-seg" style="width:${pct}%;background:${info.color}" title="${info.label} — ${wks} wk">
              <span class="plan-phase-seg-label">${info.label}</span>
            </div>`;
  }).join('');

  const DOW_LABELS = ['M','T','W','T','F','S','S'];

  const weekRows = plan.weeks.map(week => {
    const isCurrent = week.days.some(d => d.date === today);
    const isPast    = week.days.every(d => d.date < today);
    const info      = TrainingPlan.PHASES[week.phase];

    const pills = week.days.map(day => {
      const s       = TrainingPlan.SESSION[day.sessionType] || TrainingPlan.SESSION.easy;
      const isToday = day.date === today;
      const past    = day.date < today;
      return `<div class="plan-pill ${isToday ? 'plan-pill-today' : ''} ${past ? 'plan-pill-past' : ''}"
                   style="--pill:${s.color}"
                   title="${day.date} · ${day.label}: ${day.description}">
                <span class="plan-pill-dow">${DOW_LABELS[day.dow]}</span>
                <span class="plan-pill-type">${day.sessionType === 'rest' ? '·' : day.label[0]}</span>
              </div>`;
    }).join('');

    return `<div class="plan-week ${isCurrent ? 'plan-week-current' : ''} ${isPast ? 'plan-week-past' : ''}">
              <div class="plan-week-hdr">
                <span class="plan-wk-num">Wk ${week.weekNum}</span>
                <span class="plan-wk-phase" style="color:${info.color}">${info.label}</span>
                <span class="plan-wk-ctl">CTL ~${week.targetCTL}</span>
              </div>
              <div class="plan-pills">${pills}</div>
            </div>`;
  }).join('');

  el.innerHTML = `
    <div class="plan-overview">
      <div class="plan-ov-stat">
        <div class="plan-ov-val">${daysLeft > 0 ? daysLeft : '0'}</div>
        <div class="plan-ov-lbl">Days to race</div>
      </div>
      <div class="plan-ov-stat">
        <div class="plan-ov-val" style="color:var(--accent)">${plan.peakCTL}</div>
        <div class="plan-ov-lbl">Peak CTL target</div>
      </div>
      ${raceProj ? `<div class="plan-ov-stat">
        <div class="plan-ov-val ${raceProj.tsb > 0 ? 'tc-fresh' : 'tc-fatigued'}">${raceProj.tsb > 0 ? '+' : ''}${raceProj.tsb}</div>
        <div class="plan-ov-lbl">Projected TSB on race day</div>
      </div>` : ''}
      <div class="plan-ov-stat">
        <div class="plan-ov-val">${plan.totalWeeks}</div>
        <div class="plan-ov-lbl">Weeks total</div>
      </div>
    </div>
    <div class="plan-phase-bar">${phaseBar}</div>
    <div class="plan-weeks">${weekRows}</div>
    <div style="margin-top:14px;display:flex;gap:8px;align-items:center">
      <button type="button" id="plan-clear-btn" class="secondary small">Clear Plan</button>
      <span class="footnote">Built ${plan.createdAt} · ${plan.sport}</span>
    </div>`;

  document.getElementById('plan-clear-btn')?.addEventListener('click', () => {
    if (!confirm('Remove this training plan?')) return;
    TrainingPlan.clear();
    renderPlanSection();
    renderTodaySession();
    renderLoadChart(+rangeSelect.value);
  });
}

// ── Fitness Today Card ────────────────────────────────────────────────────────

function renderFitnessCard() {
  const el = document.getElementById('fitness-today-card');
  if (!el) return;

  const entries    = loadEntries();
  const activities = loadActivities();

  if (!entries.length && !activities.length) { el.classList.add('hidden'); return; }

  const load    = TrainingLoad.latest(activities);
  const { log } = Streaks.compute(entries);

  const tsbSign  = load.tsb > 0 ? '+' : '';
  const tsbCls   = load.tsb > 10 ? 'tc-fresh' : load.tsb > -10 ? 'tc-neutral' : 'tc-fatigued';
  const tsbLabel = load.tsb > 10 ? 'Fresh' : load.tsb > -10 ? 'Neutral' : 'Fatigued';

  // Readiness from today's entry, if logged
  const todayEntry = entries.find(e => e.date === todayStr());
  let readinessHTML = '';
  if (todayEntry) {
    const rs  = ReadinessScore.compute(todayEntry, entries);
    const lbl = ReadinessScore.label(rs.score);
    readinessHTML = `
      <div class="ftc-divider"></div>
      <div class="ftc-readiness">
        <span class="ftc-rs-score" style="color:${lbl.color}">${rs.score}</span>
        <span class="ftc-rs-label" style="color:${lbl.color}">${lbl.text}</span>
        <span class="ftc-rs-sub">Readiness</span>
      </div>`;
  } else {
    readinessHTML = `
      <div class="ftc-divider"></div>
      <div class="ftc-readiness ftc-nolog">
        <span class="ftc-rs-sub">Not logged today</span>
      </div>`;
  }

  el.classList.remove('hidden');
  el.innerHTML = `
    <div class="ftc-stats">
      <div class="ftc-stat">
        <div class="ftc-val" style="color:var(--accent)">${load.ctl > 0 ? load.ctl : '—'}</div>
        <div class="ftc-lbl">Fitness</div>
      </div>
      <div class="ftc-stat">
        <div class="ftc-val" style="color:var(--red)">${load.atl > 0 ? load.atl : '—'}</div>
        <div class="ftc-lbl">Fatigue</div>
      </div>
      <div class="ftc-stat">
        <div class="ftc-val ${tsbCls}">${load.ctl > 0 ? tsbSign + load.tsb : '—'}</div>
        <div class="ftc-lbl">Form · ${load.ctl > 0 ? tsbLabel : '–'}</div>
      </div>
      <div class="ftc-stat">
        <div class="ftc-val" style="color:var(--yellow)">${log || '—'}</div>
        <div class="ftc-lbl">Day streak</div>
      </div>
    </div>${readinessHTML}`;
}

// ── Tab navigation ────────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'log')      renderFitnessCard();
    if (btn.dataset.tab === 'history')  { renderHistory(); checkSuppressionBanner(); }
    if (btn.dataset.tab === 'trends')   renderTrends();
    if (btn.dataset.tab === 'connect')  { updateStravaUI(); updateWeatherUI(); updateAIUI(); renderManualRaceList(); }
    if (btn.dataset.tab === 'insights') renderInsightsTab();
  });
});

// ── Swipe navigation between tabs ────────────────────────────────────────────

(function initSwipeNav() {
  const TAB_ORDER = ['log', 'history', 'trends', 'insights', 'connect', 'glossary'];
  const SWIPE_THRESHOLD = 50;
  let touchStartX = 0;
  let touchStartY = 0;
  let touchStartTarget = null;

  function activeTabIndex() {
    const active = document.querySelector('.tab-btn.active');
    return active ? TAB_ORDER.indexOf(active.dataset.tab) : 0;
  }

  function switchToTab(index, dir) {
    const tab = TAB_ORDER[index];
    const btn = document.querySelector(`.tab-btn[data-tab="${tab}"]`);
    if (!btn) return;
    document.body.dataset.swipeDir = dir; // 'left' | 'right' — read by CSS
    btn.click();
    // Clear after animation completes so button-click transitions use the neutral fade
    setTimeout(() => delete document.body.dataset.swipeDir, 250);
  }

  function isInsideHorizontalScroller(el) {
    while (el && el !== document.body) {
      const style = window.getComputedStyle(el);
      const overflowX = style.overflowX;
      if ((overflowX === 'auto' || overflowX === 'scroll') && el.scrollWidth > el.clientWidth) return true;
      el = el.parentElement;
    }
    return false;
  }

  document.addEventListener('touchstart', e => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchStartTarget = e.target;
  }, { passive: true });

  document.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dx) < Math.abs(dy)) return;
    if (isInsideHorizontalScroller(touchStartTarget)) return;
    const idx = activeTabIndex();
    // Swipe left → next tab (content arrives from right)
    if (dx < 0 && idx < TAB_ORDER.length - 1) switchToTab(idx + 1, 'left');
    // Swipe right → prev tab (content arrives from left)
    if (dx > 0 && idx > 0) switchToTab(idx - 1, 'right');
  }, { passive: true });
})();

// ── Weather strip (Log form) ──────────────────────────────────────────────────

let _pendingWeather = null;

function wxIcon(wx) {
  if (!wx) return '🌤';
  if ((wx.precipMM ?? 0) > 1)   return '🌧';
  if ((wx.tempMaxC ?? 20) > 32) return '🔥';
  if ((wx.tempMaxC ?? 20) > 22) return '☀️';
  if ((wx.tempMaxC ?? 20) < 5)  return '🥶';
  return '🌤';
}

function showWeatherStrip(wx) {
  const strip = document.getElementById('weather-strip');
  if (!strip) return;
  if (!wx) { strip.classList.add('hidden'); return; }
  const parts = [];
  if (wx.tempMaxC != null) parts.push(`<strong>${Math.round(wx.tempMaxC)}°C</strong>`);
  if (wx.humidity  != null) parts.push(`${wx.humidity}% RH`);
  if ((wx.precipMM ?? 0) > 0.1) parts.push(`${wx.precipMM.toFixed(1)} mm rain`);
  if ((wx.windKph  ?? 0) > 20)  parts.push(`${Math.round(wx.windKph)} km/h wind`);
  strip.innerHTML = `<span class="wx-icon">${wxIcon(wx)}</span> ${parts.join(' · ')}`;
  strip.classList.remove('hidden');
}

async function updateWeatherStrip(date) {
  const strip = document.getElementById('weather-strip');
  if (!strip) return;
  _pendingWeather = null;
  const coords = WeatherService.getCoords();
  if (!coords) { strip.classList.add('hidden'); return; }
  strip.innerHTML = '<span class="wx-loading">…</span>';
  strip.classList.remove('hidden');
  try {
    const wx    = await WeatherService.fetch(date, coords.lat, coords.lon);
    _pendingWeather = wx;
    showWeatherStrip(wx);
  } catch {
    strip.classList.add('hidden');
  }
}

// ── Log form ──────────────────────────────────────────────────────────────────

const form      = document.getElementById('entry-form');
const dateInput = document.getElementById('entry-date');
const hrvInput  = document.getElementById('hrv');
const msgEl     = document.getElementById('form-message');
const indicator = document.getElementById('hrv-indicator');

// Date quick buttons
dateInput.value = todayStr();
updateDateDisplay();
updateDateQuickBtns();
updateWeatherStrip(dateInput.value);

document.querySelectorAll('.date-quick-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const d = new Date();
    d.setDate(d.getDate() + +btn.dataset.offset);
    dateInput.value = localDateStr(d);
    updateDateDisplay();
    updateDateQuickBtns();
    clearStravaCards();
    updateWeatherStrip(dateInput.value);
  });
});

dateInput.addEventListener('change', () => {
  updateDateDisplay();
  updateDateQuickBtns();
  clearStravaCards();
  updateWeatherStrip(dateInput.value);
});

function updateDateDisplay() {
  const val = dateInput.value;
  const el  = document.getElementById('date-display');
  if (!val) { el.innerHTML = ''; return; }
  const formatted = new Date(val + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
  const rel = val === todayStr() ? 'Today' : val === yesterdayStr() ? 'Yesterday' : '';
  el.innerHTML = rel
    ? `${formatted} <span class="date-relative">— ${rel}</span>`
    : formatted;
}

function updateDateQuickBtns() {
  const val = dateInput.value;
  document.querySelectorAll('.date-quick-btn').forEach(btn => {
    const target = +btn.dataset.offset === 0 ? todayStr() : yesterdayStr();
    btn.classList.toggle('active', val === target);
  });
}

['energy', 'stress', 'mood'].forEach(id => {
  const slider  = document.getElementById(id);
  const display = document.getElementById(`${id}-val`);
  slider.addEventListener('input', () => { display.textContent = slider.value; });
});

// Sleep duration slider
document.getElementById('sleep-duration').addEventListener('input', function() {
  document.getElementById('sleep-duration-val').textContent = this.value + 'h';
});

// Feel tap buttons
document.querySelectorAll('.feel-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.feel-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('feel-today').value = btn.dataset.value;
  });
});

// Sleep quality tap buttons
document.querySelectorAll('.quality-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.quality-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('sleep-quality').value = btn.dataset.value;
  });
});

hrvInput.addEventListener('input', updateHrvIndicator);
function updateHrvIndicator() {
  const v = parseInt(hrvInput.value, 10);
  indicator.style.background = v >= 1 ? hrvClass(v).color : 'var(--border)';
}

form.addEventListener('submit', e => {
  e.preventDefault();
  const date = dateInput.value;
  const hrv  = parseInt(hrvInput.value, 10);
  if (!date || !hrv) { showMsg('Please fill in date and HRV.', 'error'); return; }

  const activities = [
    ...[...document.querySelectorAll('#activity-tags input:checked')].map(el => el.value),
    ...document.getElementById('custom-activity').value
      .split(',').map(s => s.trim()).filter(Boolean),
  ];

  const sleepQuality = parseInt(document.getElementById('sleep-quality').value, 10) || 3;
  const entry = {
    id:           Date.now(),
    date,
    hrv,
    energy:       +document.getElementById('energy').value,
    stress:       +document.getElementById('stress').value,
    sleep:        sleepQuality * 2, // map 1-5 → 2-10 for backwards compat
    mood:         +document.getElementById('mood').value,
    activities,
    notes:        document.getElementById('notes').value.trim(),
    feelToday:    parseInt(document.getElementById('feel-today').value, 10) || null,
    sleepQuality,
    flags:        [...document.querySelectorAll('.flag-btn input:checked')].map(cb => cb.value),
    restingHR:    optInt('resting-hr'),
    readiness:    optInt('readiness'),
    sleepDuration:optFloat('sleep-duration'),
    respRate:     optFloat('resp-rate'),
    spo2:         optFloat('spo2'),
    bodyBattery:  optInt('body-battery'),
    weather:      _pendingWeather ?? null,
    ...(pendingStravaActivities.length && {
      stravaActivities: pendingStravaActivities.map(a => ({
        name:      a.name,
        type:      Strava.mapType(a.sport_type || a.type),
        distanceM: a.distance          || 0,
        durationS: a.moving_time       || 0,
        avgHR:     a.average_heartrate ? Math.round(a.average_heartrate) : null,
        maxHR:     a.max_heartrate     ? Math.round(a.max_heartrate)     : null,
        elevationM:a.total_elevation_gain || 0,
      })),
    }),
  };

  const _readiness = ReadinessScore.compute(entry, loadEntries());
  entry.readinessScore = _readiness.score;
  entry.readinessInputs = _readiness.inputs;
  entry.baselineSnapshot = AdaptiveBaseline.compute(loadEntries(), entry.date);
  entry.createdAt = entry.createdAt || Date.now();
  entry.updatedAt = Date.now();

  const entries = loadEntries();
  const idx = entries.findIndex(en => en.date === date);
  if (idx >= 0) { entries[idx] = entry; showMsg('Entry updated!', 'success'); }
  else          { entries.push(entry);  showMsg('Entry saved!', 'success'); }
  entries.sort((a, b) => b.date.localeCompare(a.date));
  saveEntries(entries);
  GistSync.pushSilent();
  showReadinessResult(_readiness);
  Notifs.checkAll(loadEntries(), loadActivities());
  renderFitnessCard();
  renderTodaySession();
  resetForm();
  delete form.dataset.editingId;
});

document.getElementById('clear-btn').addEventListener('click', resetForm);

function resetForm() {
  form.reset();
  dateInput.value = todayStr();
  updateDateDisplay();
  updateDateQuickBtns();
  ['energy', 'stress', 'mood'].forEach(id => {
    document.getElementById(id).value = 5;
    document.getElementById(`${id}-val`).textContent = '5';
  });
  indicator.style.background = 'var(--border)';
  ['resting-hr','readiness','resp-rate','spo2','body-battery'].forEach(id => {
    document.getElementById(id).value = '';
  });
  // Reset sleep section
  const sleepSlider = document.getElementById('sleep-duration');
  if (sleepSlider) { sleepSlider.value = 7; document.getElementById('sleep-duration-val').textContent = '7h'; }
  document.querySelector('#sleep-quality').value = '3';
  document.querySelectorAll('.quality-btn').forEach(b => b.classList.toggle('active', b.dataset.value === '3'));
  // Reset feel tap
  document.getElementById('feel-today').value = '';
  document.querySelectorAll('.feel-btn').forEach(b => b.classList.remove('active'));
  // Reset flags
  document.querySelectorAll('.flag-btn input').forEach(cb => { cb.checked = false; });
  clearStravaCards();
  document.getElementById('readiness-result')?.classList.add('hidden');
  _pendingWeather = null;
  updateWeatherStrip(todayStr());
  document.getElementById('save-btn').textContent = 'Save Entry';
  delete form.dataset.editingId;
}

function showReadinessResult(result) {
  const lbl = ReadinessScore.label(result.score);
  const rec = result.score >= 70 ? { text: 'Hard effort OK', color: 'var(--green)' }
            : result.score >= 55 ? { text: 'Moderate training', color: 'var(--yellow)' }
            : result.score >= 40 ? { text: 'Easy session only', color: 'var(--yellow)' }
            : { text: 'Rest recommended', color: 'var(--red)' };
  const el = document.getElementById('readiness-result');
  if (!el) return;
  el.innerHTML = `
    <div class="rs-card">
      <div class="rs-score ${lbl.cls}">${result.score}</div>
      <div class="rs-info">
        <div class="rs-label">${lbl.text} Readiness</div>
        <div class="rs-rec" style="color:${rec.color}">${rec.text}</div>
        <div class="rs-breakdown">
          HRV ${result.inputs.hrvScore.toFixed(0)} · Trend ${result.inputs.trendScore.toFixed(0)} · Sleep ${result.inputs.sleepScore.toFixed(0)} · Feel ${result.inputs.subjectiveScore.toFixed(0)}
        </div>
      </div>
    </div>`;
  el.classList.remove('hidden');
}

function showMsg(text, type) {
  msgEl.textContent = text;
  msgEl.className = `message ${type}`;
  clearTimeout(msgEl._t);
  msgEl._t = setTimeout(() => { msgEl.className = 'message hidden'; }, 3000);
}

// ── Strava import button (Log tab) ────────────────────────────────────────────

const stravaImportBtn = document.getElementById('import-strava-btn');
const stravaImportMsg = document.getElementById('strava-import-msg');
let pendingStravaActivities = [];

function updateStravaImportBtn() {
  const connected = Strava.isConnected();
  stravaImportBtn.classList.toggle('strava-connected', connected);
  stravaImportBtn.title = connected
    ? 'Import Strava activities for the selected date'
    : 'Connect Strava first (Connect tab)';
}
updateStravaImportBtn();

stravaImportBtn.addEventListener('click', async () => {
  if (!Strava.isConnected()) {
    showImportMsg(stravaImportMsg, 'Connect Strava first — go to the Connect tab.', 'error');
    return;
  }
  const dateStr = dateInput.value || todayStr();
  stravaImportBtn.disabled = true;
  stravaImportBtn.textContent = 'Loading…';
  try {
    const activities = await Strava.fetchActivitiesForDate(dateStr);
    if (!activities.length) {
      showImportMsg(stravaImportMsg, 'No Strava activities found for this date.', 'info');
      return;
    }
    pendingStravaActivities = activities;

    // Check matching checkboxes
    const knownTypes = new Set(['Running','Cycling','Strength training','Yoga','Meditation','Walking','Swimming','Rest day']);
    const mapped = activities.map(a => Strava.mapType(a.sport_type || a.type));
    document.querySelectorAll('#activity-tags input[type="checkbox"]').forEach(cb => {
      if (mapped.includes(cb.value)) cb.checked = true;
    });
    const custom = mapped.filter(m => !knownTypes.has(m));
    if (custom.length) {
      const cf = document.getElementById('custom-activity');
      cf.value = [...new Set([...cf.value.split(',').map(s=>s.trim()).filter(Boolean), ...custom])].join(', ');
    }

    renderStravaCards(activities);
    showImportMsg(stravaImportMsg, `${activities.length} activit${activities.length === 1 ? 'y' : 'ies'} imported from Strava.`, 'success');
  } catch (err) {
    showImportMsg(stravaImportMsg, `Strava error: ${err.message}`, 'error');
  } finally {
    stravaImportBtn.disabled = false;
    stravaImportBtn.textContent = 'Import from Strava';
  }
});

function renderStravaCards(activities) {
  const container = document.getElementById('strava-activity-cards');
  container.innerHTML = `<div class="strava-act-cards">${activities.map(a => {
    const type = Strava.mapType(a.sport_type || a.type);
    const meta = [
      fmtDist(a.distance),
      fmtDur(a.moving_time),
      a.average_heartrate ? `♥ ${Math.round(a.average_heartrate)} bpm` : '',
      a.total_elevation_gain ? `↑ ${Math.round(a.total_elevation_gain)} m` : '',
    ].filter(Boolean).join(' · ');
    return `<div class="strava-act-card">
      <span class="act-emoji">${actIcon(type)}</span>
      <div class="act-info">
        <div class="act-name">${a.name}</div>
        ${meta ? `<div class="act-meta">${meta}</div>` : ''}
      </div>
      <span class="act-source-badge">Strava</span>
    </div>`;
  }).join('')}</div>`;
  container.classList.remove('hidden');
}

function clearStravaCards() {
  pendingStravaActivities = [];
  const c = document.getElementById('strava-activity-cards');
  c.innerHTML = '';
  c.classList.add('hidden');
}

function showImportMsg(el, text, type) {
  el.textContent = text;
  el.className = `import-msg ${type}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = 'import-msg hidden'; }, 4000);
}

function loadEntryIntoForm(entry) {
  // Switch to log tab
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector('[data-tab="log"]').classList.add('active');
  document.getElementById('tab-log').classList.add('active');

  // Fill fields
  dateInput.value = entry.date;
  updateDateDisplay();
  updateDateQuickBtns();
  hrvInput.value = entry.hrv || '';
  updateHrvIndicator();

  ['energy', 'stress', 'mood'].forEach(id => {
    document.getElementById(id).value = entry[id] ?? 5;
    document.getElementById(`${id}-val`).textContent = entry[id] ?? 5;
  });

  // Sleep section
  const sleepSlider = document.getElementById('sleep-duration');
  if (sleepSlider) {
    sleepSlider.value = entry.sleepDuration ?? 7;
    document.getElementById('sleep-duration-val').textContent = (entry.sleepDuration ?? 7) + 'h';
  }
  const sq = entry.sleepQuality ?? 3;
  document.getElementById('sleep-quality').value = sq;
  document.querySelectorAll('.quality-btn').forEach(b => b.classList.toggle('active', +b.dataset.value === sq));

  // Feel tap
  const ft = entry.feelToday ?? null;
  document.getElementById('feel-today').value = ft ?? '';
  document.querySelectorAll('.feel-btn').forEach(b => b.classList.toggle('active', +b.dataset.value === ft));

  // Flags
  document.querySelectorAll('.flag-btn input').forEach(cb => {
    cb.checked = (entry.flags || []).includes(cb.value);
  });

  // Activities — check matching boxes, put rest in custom field
  const known = new Set(['Running','Cycling','Strength training','Yoga','Meditation','Walking','Swimming','Rest day']);
  document.querySelectorAll('#activity-tags input[type="checkbox"]').forEach(cb => {
    cb.checked = (entry.activities || []).includes(cb.value);
  });
  const custom = (entry.activities || []).filter(a => !known.has(a));
  document.getElementById('custom-activity').value = custom.join(', ');

  // Restore Strava cards if saved
  clearStravaCards();
  if (entry.stravaActivities?.length) {
    pendingStravaActivities = entry.stravaActivities.map(a => ({
      name: a.name, sport_type: a.type,
      distance: a.distanceM, moving_time: a.durationS,
      average_heartrate: a.avgHR, total_elevation_gain: a.elevationM,
    }));
    renderStravaCards(pendingStravaActivities);
  }

  // Device readings
  const deviceFields = { 'resting-hr': 'restingHR', 'readiness': 'readiness',
    'resp-rate': 'respRate', 'spo2': 'spo2', 'body-battery': 'bodyBattery' };
  Object.entries(deviceFields).forEach(([id, key]) => {
    document.getElementById(id).value = entry[key] ?? '';
  });

  document.getElementById('notes').value = entry.notes || '';

  // Weather strip — reuse saved data or re-fetch
  if (entry.weather) {
    _pendingWeather = entry.weather;
    showWeatherStrip(entry.weather);
  } else {
    updateWeatherStrip(entry.date);
  }

  // Scroll form into view and flag as editing
  document.getElementById('save-btn').textContent = 'Update Entry';
  form.dataset.editingId = entry.id;
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── History ───────────────────────────────────────────────────────────────────

const historyList   = document.getElementById('history-list');
const historySearch = document.getElementById('history-search');

historySearch.addEventListener('input', renderHistory);

document.getElementById('export-btn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(loadEntries(), null, 2)], { type: 'application/json' });
  const a    = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'hrv-entries.json' });
  a.click();
});

document.getElementById('export-csv-btn').addEventListener('click', () => {
  const entries = loadEntries();
  if (!entries.length) return;
  const headers = ['date','hrv','energy','stress','sleep','mood','restingHR','readiness','sleepDuration','respRate','spo2','bodyBattery','readinessScore','activities','notes'];
  const rows = entries.map(e => headers.map(h => {
    const v = h === 'activities' ? (e.activities||[]).join(';') : e[h];
    return v == null ? '' : String(v).includes(',') ? `"${v}"` : v;
  }).join(','));
  const csv = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'hrv-entries.csv' });
  a.click();
});

function renderHistory() {
  const q = historySearch.value.toLowerCase();
  const entries = loadEntries().filter(en =>
    !q ||
    en.notes?.toLowerCase().includes(q) ||
    en.activities?.some(a => a.toLowerCase().includes(q)) ||
    en.date.includes(q)
  );

  if (!entries.length) {
    historyList.innerHTML = '<div class="empty-state">No entries yet. Start logging!</div>';
    return;
  }

  historyList.innerHTML = entries.map(entryCardHTML).join('');
  historyList.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!confirm('Delete this entry?')) return;
      saveEntries(loadEntries().filter(en => en.id !== +btn.dataset.id));
      renderHistory();
    });
  });
  historyList.querySelectorAll('.edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const entry = loadEntries().find(en => en.id === +btn.dataset.id);
      if (entry) loadEntryIntoForm(entry);
    });
  });
}

function entryCardHTML(en) {
  const cls  = hrvClass(en.hrv);
  const date = new Date(en.date + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  });
  const notes = en.notes ? `<div class="entry-notes">"${en.notes}"</div>` : '';
  const rsLabel = en.readinessScore != null ? ReadinessScore.label(en.readinessScore) : null;
  const rsBadge = rsLabel ? `<span class="rs-badge ${rsLabel.cls}">${en.readinessScore}</span>` : '';
  const feelLabels = {4:'😄 Great', 3:'🙂 Good', 2:'😐 Average', 1:'😓 Rough'};
  const flagIcons = {illness:'🤒', stress:'😰', alcohol:'🍺', travel:'✈️'};
  const flagsHTML = en.flags?.length
    ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">${en.flags.map(f=>`<span class="activity-pill">${flagIcons[f]||''} ${f}</span>`).join('')}</div>`
    : '';

  // Prefer rich Strava rows; fall back to simple pills
  let activityHTML = '';
  if (en.stravaActivities?.length) {
    const rows = en.stravaActivities.map(a => {
      const meta = [
        fmtDist(a.distanceM),
        fmtDur(a.durationS),
        a.avgHR ? `♥ ${a.avgHR} bpm` : '',
        a.elevationM ? `↑ ${a.elevationM} m` : '',
      ].filter(Boolean).join(' · ');
      return `<div class="history-strava-act">${actIcon(a.type)} <strong>${a.name}</strong>${meta ? ` <span class="act-stat">· ${meta}</span>` : ''}</div>`;
    }).join('');
    activityHTML = `<div class="history-strava-acts">${rows}</div>`;
  } else if (en.activities?.length) {
    const pills = en.activities.map(a => `<span class="activity-pill">${actIcon(a)} ${a}</span>`).join('');
    activityHTML = `<div class="entry-activities">${pills}</div>`;
  }

  return `
    <div class="entry-card">
      <div class="entry-header">
        <span class="entry-date">${date}</span>
        <span>${rsBadge}<span class="entry-hrv">${en.hrv}</span><span class="hrv-badge ${cls.cls}">${cls.label}</span></span>
        <div class="card-actions">
          <button class="edit-btn" data-id="${en.id}" title="Edit">Edit</button>
          <button class="delete-btn" data-id="${en.id}" title="Delete">✕</button>
        </div>
      </div>
      ${raceBadgeHTML(en)}
      ${flagsHTML}
      <div class="entry-metrics">
        ${en.feelToday ? `<div class="metric">Feel <span>${feelLabels[en.feelToday]||''}</span></div>` : ''}
        <div class="metric">Energy <span>${en.energy}/10</span></div>
        <div class="metric">Stress <span>${en.stress}/10</span></div>
        ${en.sleepQuality ? `<div class="metric">Sleep quality <span>${en.sleepQuality}/5 ⭐</span></div>` : `<div class="metric">Sleep <span>${en.sleep}/10</span></div>`}
        <div class="metric">Mood <span>${en.mood}/10</span></div>
      </div>
      ${deviceMetricsHTML(en)}
      ${activityHTML}
      ${suppressionFlagHTML(en)}
      ${notes}
    </div>`;
}

function suppressionFlagHTML(en) {
  const activities = loadActivities();
  const entries    = loadEntries();
  if (!RecoveryAnalytics.isPostWorkoutSuppression(en, activities, entries)) return '';
  return '<span class="suppression-flag">Post-workout suppression</span>';
}

function raceBadgeHTML(en) {
  const activities = loadActivities();
  const acts = activities.filter(a => a.date === en.date && a.isRace && a.raceConfirmed);
  if (!acts.length) return '';
  return acts.map(a => `<span class="race-badge">🏁 ${a.name}${a.raceDetails?.place ? ' · ' + a.raceDetails.place : ''}</span>`).join(' ');
}

function deviceMetricsHTML(en) {
  const items = [
    en.restingHR    != null ? `Resting HR <span>${en.restingHR} bpm</span>` : '',
    en.readiness    != null ? `Readiness <span>${en.readiness}/100</span>` : '',
    en.sleepDuration!= null ? `Sleep <span>${en.sleepDuration}h</span>` : '',
    en.respRate     != null ? `Resp. <span>${en.respRate}/min</span>` : '',
    en.spo2         != null ? `SpO2 <span>${en.spo2}%</span>` : '',
    en.bodyBattery  != null ? `Battery <span>${en.bodyBattery}/100</span>` : '',
  ].filter(Boolean);
  if (!items.length) return '';
  return `<div class="entry-device-metrics">${items.map(i => `<div class="metric">${i}</div>`).join('')}</div>`;
}

// ── Trends ────────────────────────────────────────────────────────────────────

const rangeSelect = document.getElementById('range-select');
rangeSelect.addEventListener('change', renderTrends);

let chart = null;

function renderTrends() {
  const days = +rangeSelect.value;
  let entries = loadEntries().slice().sort((a, b) => a.date.localeCompare(b.date));
  if (days > 0) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cs = localDateStr(cutoff);
    entries = entries.filter(en => en.date >= cs);
  }
  renderStats(entries);
  renderTaperBanner();
  renderStreaks();
  renderHeatmap();
  renderChart(entries);
  renderRaceGoal();
  renderLoadChart(days);
  renderInsights();
  renderPlanSection();
}

// ── Season Heatmap ────────────────────────────────────────────────────────────

function hmColor(rs) {
  if (rs >= 80) return '#34d399';
  if (rs >= 65) return 'rgba(52,211,153,.58)';
  if (rs >= 50) return 'rgba(251,191,36,.75)';
  if (rs >= 35) return 'rgba(248,113,113,.72)';
  return 'rgba(220,38,38,.85)';
}

function renderHeatmap() {
  const grid = document.getElementById('hm-grid');
  const monthsEl = document.getElementById('hm-months');
  if (!grid) return;

  const allEntries = loadEntries();
  const entryMap  = new Map(allEntries.map(e => [e.date, e]));
  const raceDates = new Set(loadActivities().filter(a => a.isRace).map(a => a.date));
  const avgHrv    = allEntries.length
    ? allEntries.reduce((s, e) => s + e.hrv, 0) / allEntries.length : 60;

  // 52 full weeks ending today, starting on Monday
  const today    = new Date(); today.setHours(12, 0, 0, 0);
  const todayStr = localDateStr(today);
  const todayDow = (today.getDay() + 6) % 7; // 0=Mon
  const start    = new Date(today);
  start.setDate(today.getDate() - todayDow - 51 * 7);

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const monthLabels = [];
  let lastMonth = -1, weekIdx = 0;

  grid.innerHTML = '';

  const cur = new Date(start);
  while (localDateStr(cur) <= todayStr) {
    const dow     = (cur.getDay() + 6) % 7;
    const dateStr = localDateStr(cur);

    if (dow === 0) {
      const m = cur.getMonth();
      if (m !== lastMonth) { monthLabels.push({ weekIdx, label: MONTHS[m] }); lastMonth = m; }
    }

    const entry = entryMap.get(dateStr);
    const cell  = document.createElement('div');
    cell.className    = 'hm-cell';
    cell.dataset.date = dateStr;

    if (entry) {
      const rs = entry.readinessScore
        ?? Math.min(100, Math.max(0, 50 + (entry.hrv - avgHrv) / avgHrv * 50));
      cell.style.background = hmColor(rs);
      cell.dataset.hrv = entry.hrv;
      cell.dataset.rs  = Math.round(rs);
      if (raceDates.has(dateStr)) cell.classList.add('hm-race');
    }

    grid.appendChild(cell);
    if (dow === 6) weekIdx++;
    cur.setDate(cur.getDate() + 1);
  }

  // Month labels — positioned by pixel offset
  if (monthsEl) {
    monthsEl.innerHTML = '';
    const CELL = 13, GAP = 3;
    monthLabels.forEach(({ weekIdx: wi, label }) => {
      const span = document.createElement('span');
      span.textContent = label;
      span.style.left  = `${wi * (CELL + GAP)}px`;
      monthsEl.appendChild(span);
    });
  }

  // Scroll to the right end so the most recent weeks are visible
  const scrollEl = grid.closest('.heatmap-scroll');
  if (scrollEl) requestAnimationFrame(() => { scrollEl.scrollLeft = scrollEl.scrollWidth; });
}

// Heatmap tooltip listeners — registered once at startup, delegated to current cells
(function initHeatmapListeners() {
  const grid    = document.getElementById('hm-grid');
  const tooltip = document.getElementById('hm-tooltip');
  if (!grid || !tooltip) return;

  grid.addEventListener('mouseover', e => {
    const cell = e.target.closest('.hm-cell');
    if (!cell) return;
    showHmTooltip(tooltip, cell);
  });
  grid.addEventListener('mouseleave', () => tooltip.classList.add('hidden'));

  grid.addEventListener('touchstart', e => {
    const cell = e.changedTouches[0]
      ? document.elementFromPoint(e.changedTouches[0].clientX, e.changedTouches[0].clientY)?.closest('.hm-cell')
      : null;
    if (!cell) return;
    e.preventDefault();
    showHmTooltip(tooltip, cell);
    setTimeout(() => tooltip.classList.add('hidden'), 2500);
  }, { passive: false });
})();

function showHmTooltip(tooltip, cell) {
  const dateStr = cell.dataset.date;
  if (!dateStr) return;
  const d = new Date(dateStr + 'T12:00:00');
  const label = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  let html = `<div class="hmt-date">${label}</div>`;
  if (cell.dataset.hrv) {
    html += `<div class="hmt-row">HRV <strong>${cell.dataset.hrv} ms</strong></div>`;
    html += `<div class="hmt-row">Readiness <strong>${cell.dataset.rs}</strong></div>`;
    if (cell.classList.contains('hm-race')) html += `<div class="hmt-row">🏁 Race day</div>`;
  } else {
    html += `<div class="hmt-row hmt-muted">No entry</div>`;
  }
  tooltip.innerHTML = html;
  tooltip.classList.remove('hidden');
  const r = cell.getBoundingClientRect();
  tooltip.style.left = `${r.left + r.width / 2}px`;
  tooltip.style.top  = `${r.top - 6}px`;
}

function renderTaperBanner() {
  const el = document.getElementById('taper-banner');
  if (!el) return;
  const taper = TaperDetector.detect(loadActivities());
  if (!taper) { el.innerHTML = ''; return; }

  const raceHtml = taper.nextRace
    ? `<div class="taper-race">🏁 ${taper.nextRace.name} in <strong>${taper.nextRace.daysToRace}</strong> day${taper.nextRace.daysToRace !== 1 ? 's' : ''}</div>`
    : `<div class="taper-race taper-race-hint">Add a goal race to see your countdown →</div>`;

  el.innerHTML = `
    <div class="taper-card">
      <div class="taper-header">
        <span class="taper-pill">TAPER</span>
        <span class="taper-day">Day ${taper.dayCount}</span>
        <span class="taper-tsb">Form +${taper.tsb.toFixed(1)}</span>
      </div>
      <div class="taper-body">
        Load has been dropping for ${taper.dropDays} consecutive day${taper.dropDays !== 1 ? 's' : ''} and your form score is positive — classic taper signal. Keep intensity sharp, volume low.
      </div>
      ${raceHtml}
    </div>`;
}

function renderStreaks() {
  const el = document.getElementById('streaks-row');
  if (!el) return;
  const { log, hot, best } = Streaks.compute(loadEntries());

  const card = (icon, value, label, color) =>
    `<div class="streak-card">
      <div class="streak-icon">${icon}</div>
      <div class="streak-val" style="color:${color}">${value}</div>
      <div class="streak-label">${label}</div>
     </div>`;

  el.innerHTML =
    card('🔥', log,  `Day${log  !== 1 ? 's' : ''} logged`,    log  > 0 ? 'var(--accent)' : 'var(--text-muted)') +
    card('⚡', hot,  `Above baseline`,                          hot  > 0 ? 'var(--green)'  : 'var(--text-muted)') +
    card('🏆', best, `Best ever`,                               best > 0 ? 'var(--yellow)'  : 'var(--text-muted)');
}

function renderStats(entries) {
  const grid = document.getElementById('stats-grid');
  if (!entries.length) { grid.innerHTML = '<div class="empty-state">No data for this range.</div>'; return; }
  const avg  = arr => (arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(1);
  const hrvs = entries.map(e => e.hrv);
  const trend = entries.length >= 2
    ? (entries.at(-1).hrv - entries[0].hrv > 0 ? '↑' : '↓') : '—';

  const hrEntries = entries.filter(e => e.restingHR != null);
  const hrStat = hrEntries.length
    ? `<div class="stat-card"><div class="stat-value" style="color:var(--red)">${(hrEntries.reduce((s,e)=>s+e.restingHR,0)/hrEntries.length).toFixed(0)}</div><div class="stat-label">Avg Resting HR</div></div>`
    : '';
  const load = TrainingLoad.latest(loadActivities());
  const loadStat = load.ctl > 0
    ? `<div class="stat-card"><div class="stat-value" style="color:var(--accent)">${load.ctl}</div><div class="stat-label">Fitness (CTL)</div></div>`
    : '';

  grid.innerHTML = `
    <div class="stat-card"><div class="stat-value" style="color:var(--accent)">${avg(hrvs)}</div><div class="stat-label">Avg HRV (ms)</div></div>
    <div class="stat-card"><div class="stat-value" style="color:var(--green)">${Math.max(...hrvs)}</div><div class="stat-label">Peak HRV</div></div>
    <div class="stat-card"><div class="stat-value" style="color:var(--red)">${Math.min(...hrvs)}</div><div class="stat-label">Low HRV</div></div>
    <div class="stat-card"><div class="stat-value">${trend}</div><div class="stat-label">Trend</div></div>
    <div class="stat-card"><div class="stat-value">${entries.length}</div><div class="stat-label">Entries</div></div>
    <div class="stat-card"><div class="stat-value" style="color:var(--accent)">${avg(entries.map(e => e.energy))}</div><div class="stat-label">Avg Energy</div></div>
    ${hrStat}${loadStat}`;
}

function renderChart(entries) {
  const ctx = document.getElementById('hrv-chart').getContext('2d');
  if (chart) { chart.destroy(); chart = null; }
  if (!entries.length) return;

  const labels  = entries.map(en => new Date(en.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
  const hrvData = entries.map(e => e.hrv);

  // 7-day rolling average
  const rollingAvg = hrvData.map((_, i) => {
    const window = hrvData.slice(Math.max(0, i - 6), i + 1).filter(v => v != null);
    return window.length ? +(window.reduce((s, v) => s + v, 0) / window.length).toFixed(1) : null;
  });

  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'HRV (ms)',
          data: hrvData,
          borderColor: '#5b8dee',
          backgroundColor: 'rgba(91,141,238,.12)',
          borderWidth: 2.5,
          pointBackgroundColor: hrvData.map(v => hrvClass(v).color),
          pointRadius: 5,
          pointHoverRadius: 7,
          tension: 0.35,
          fill: true,
        },
        {
          label: '7-day avg',
          data: rollingAvg,
          borderColor: 'rgba(251,191,36,.8)',
          borderWidth: 2,
          borderDash: [6, 3],
          pointRadius: 0,
          tension: 0.4,
          fill: false,
          spanGaps: true,
        },
        {
          label: 'Mood',
          data: entries.map(e => e.mood),
          borderColor: '#34d399',
          borderWidth: 1.5,
          borderDash: [4, 4],
          pointRadius: 3,
          tension: 0.35,
          fill: false,
          yAxisID: 'y2',
        },
        ...(entries.some(e => e.restingHR != null) ? [{
          label: 'Resting HR',
          data: entries.map(e => e.restingHR ?? null),
          borderColor: '#f87171',
          borderWidth: 1.5,
          borderDash: [2, 3],
          pointRadius: 3,
          tension: 0.35,
          fill: false,
          spanGaps: true,
          yAxisID: 'y3',
        }] : []),
        // Race goal target line
        ...(() => {
          const g = RaceGoal.load();
          if (!g?.hrv) return [];
          return [{
            label: `Target HRV (${g.hrv} ms)`,
            data: Array(entries.length).fill(g.hrv),
            borderColor: 'rgba(52,211,153,.55)',
            borderWidth: 1.5,
            borderDash: [6, 4],
            pointRadius: 0,
            fill: false,
            tension: 0,
          }];
        })(),
      ],
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#8891a8', font: { size: 12 } } },
        tooltip: {
          backgroundColor: '#1a1d27',
          borderColor: '#2e3348',
          borderWidth: 1,
          titleColor: '#e8eaf0',
          bodyColor: '#8891a8',
          callbacks: {
            afterBody: (items) => {
              const en = entries[items[0].dataIndex];
              const acts = en.activities?.join(', ') || '—';
              return [`Energy: ${en.energy}/10`, `Stress: ${en.stress}/10`, `Sleep: ${en.sleep}/10`, `Activities: ${acts}`];
            },
          },
        },
      },
      scales: {
        x:  { ticks: { color: '#8891a8' }, grid: { color: '#2e3348' } },
        y:  { ticks: { color: '#8891a8' }, grid: { color: '#2e3348' }, title: { display: true, text: 'HRV (ms)', color: '#8891a8' } },
        y2: { position: 'right', min: 1, max: 10, ticks: { color: '#8891a8' }, grid: { drawOnChartArea: false }, title: { display: true, text: 'Mood (1–10)', color: '#8891a8' } },
        y3: { position: 'right', display: entries.some(e => e.restingHR != null), ticks: { color: '#f87171' }, grid: { drawOnChartArea: false }, title: { display: true, text: 'Resting HR', color: '#f87171' } },
      },
    },
  });
}

// ── Race Goal Tracker UI ─────────────────────────────────────────────────────

function renderRaceGoal() {
  const resultEl = document.getElementById('race-goal-result');
  const clearBtn = document.getElementById('clear-race-goal-btn');
  if (!resultEl) return;

  const goal = RaceGoal.load();

  // Pre-fill form inputs
  const dateEl = document.getElementById('goal-race-date');
  const hrvEl  = document.getElementById('goal-hrv');
  const nameEl = document.getElementById('goal-race-name');
  if (goal) {
    if (dateEl) dateEl.value = goal.date || '';
    if (hrvEl)  hrvEl.value  = goal.hrv  || '';
    if (nameEl) nameEl.value = goal.name || '';
    clearBtn?.classList.remove('hidden');
  } else {
    clearBtn?.classList.add('hidden');
    resultEl.innerHTML = '';
    return;
  }

  const allEntries = loadEntries().slice().sort((a, b) => a.date.localeCompare(b.date));
  const proj = RaceGoal.project(allEntries);

  if (!proj) {
    resultEl.innerHTML = '<p class="rg-hint">Log at least 3 HRV entries to see your projection.</p>';
    return;
  }
  if (proj.past) {
    resultEl.innerHTML = '<p class="rg-hint">Race date has passed — set a new goal to start tracking.</p>';
    return;
  }

  const { days, projected, currentAvg, onTrack } = proj;
  const diff    = +(projected - goal.hrv).toFixed(1);
  const diffStr = diff >= 0 ? `+${diff}` : `${diff}`;
  const statusCls  = onTrack ? 'on-track' : 'off-track';
  const statusIcon = onTrack ? '✅' : '⚠️';
  const statusMsg  = onTrack
    ? `On track — projected ${Math.abs(diff)} ms above target`
    : `Behind — projected ${Math.abs(diff)} ms below target`;

  const dateStr  = new Date(goal.date + 'T12:00:00')
    .toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const raceLine = goal.name ? `${goal.name} · ${dateStr}` : dateStr;

  resultEl.innerHTML = `
    <div class="rg-separator"></div>
    <div class="rg-header">
      <span class="rg-race-name">🏁 ${raceLine}</span>
      <span class="rg-days-badge">${days} day${days !== 1 ? 's' : ''} away</span>
    </div>
    <div class="rg-stats">
      <div class="rg-stat">
        <span class="rg-stat-val">${currentAvg}</span>
        <span class="rg-stat-lbl">Current avg <em>7-day</em></span>
      </div>
      <span class="rg-arrow">→</span>
      <div class="rg-stat">
        <span class="rg-stat-val" style="color:var(--accent)">${projected}</span>
        <span class="rg-stat-lbl">Projected <em>race day</em></span>
      </div>
      <span class="rg-arrow">vs</span>
      <div class="rg-stat">
        <span class="rg-stat-val" style="color:var(--green)">${goal.hrv}</span>
        <span class="rg-stat-lbl">Your target</span>
      </div>
    </div>
    <div class="rg-status ${statusCls}">${statusIcon} ${statusMsg}</div>
  `;
}

document.getElementById('save-race-goal-btn')?.addEventListener('click', () => {
  const date = document.getElementById('goal-race-date')?.value;
  const hrv  = parseInt(document.getElementById('goal-hrv')?.value, 10);
  const name = document.getElementById('goal-race-name')?.value.trim() || '';
  if (!date) { alert('Please enter a race date.'); return; }
  if (!hrv || hrv < 1) { alert('Please enter a target HRV.'); return; }
  if (RaceGoal.daysUntil(date) <= 0) { alert('Race date must be in the future.'); return; }
  RaceGoal.save({ date, hrv, name });
  renderRaceGoal();
  renderChart(loadEntries().slice().sort((a, b) => a.date.localeCompare(b.date)));
});

document.getElementById('clear-race-goal-btn')?.addEventListener('click', () => {
  RaceGoal.clear();
  const dateEl = document.getElementById('goal-race-date');
  const hrvEl  = document.getElementById('goal-hrv');
  const nameEl = document.getElementById('goal-race-name');
  if (dateEl) dateEl.value = '';
  if (hrvEl)  hrvEl.value  = '';
  if (nameEl) nameEl.value = '';
  renderRaceGoal();
  renderTrends();
});

// ── Connect tab ───────────────────────────────────────────────────────────────

function updateStravaUI() {
  const connected = Strava.isConnected();
  document.getElementById('strava-status-dot').className = `status-dot ${connected ? 'connected' : 'disconnected'}`;
  document.getElementById('strava-status-dot').title = connected ? 'Connected' : 'Not connected';
  document.getElementById('strava-setup-form').classList.toggle('hidden', connected);
  document.getElementById('strava-connected-view').classList.toggle('hidden', !connected);
  document.getElementById('strava-domain-display').textContent = Strava.domain();

  if (connected) {
    document.getElementById('strava-athlete-name').textContent =
      localStorage.getItem('strava_athlete') || 'Athlete';
  }

  // Pre-fill saved credentials
  const cfg = Strava.config;
  if (cfg && !connected) {
    document.getElementById('strava-client-id').value     = cfg.clientId     || '';
    document.getElementById('strava-client-secret').value = cfg.clientSecret || '';
  }

  updateStravaImportBtn();
  updateSyncStatus();

  updateNotifPermissionBtn();
}

document.getElementById('strava-connect-btn').addEventListener('click', () => {
  const clientId     = document.getElementById('strava-client-id').value.trim();
  const clientSecret = document.getElementById('strava-client-secret').value.trim();
  if (!clientId || !clientSecret) {
    alert('Please enter both Client ID and Client Secret.');
    return;
  }
  localStorage.setItem('strava_config', JSON.stringify({ clientId, clientSecret }));
  Strava.authorize(clientId);
});

document.getElementById('strava-disconnect-btn').addEventListener('click', () => {
  Strava.disconnect();
  updateStravaUI();
});

// ── Garmin CSV import ─────────────────────────────────────────────────────────

let garminParsedRows = [];

document.getElementById('garmin-act-btn').addEventListener('click', () => {
  document.getElementById('garmin-act-file').click();
});
document.getElementById('garmin-hrv-btn').addEventListener('click', () => {
  document.getElementById('garmin-hrv-file').click();
});

document.getElementById('garmin-act-file').addEventListener('change', e => handleGarminFile(e.target.files[0]));
document.getElementById('garmin-hrv-file').addEventListener('change', e => handleGarminFile(e.target.files[0]));

function handleGarminFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const rows = Garmin.parse(e.target.result);
      garminParsedRows = rows;
      showGarminPreview(rows);
    } catch (err) {
      showGarminMsg(`Could not parse CSV: ${err.message}`, 'error');
    }
  };
  reader.readAsText(file);
  // Reset file inputs so the same file can be re-selected
  document.getElementById('garmin-act-file').value = '';
  document.getElementById('garmin-hrv-file').value = '';
}

function showGarminPreview(rows) {
  const preview = document.getElementById('garmin-preview');
  const list    = document.getElementById('garmin-preview-list');
  preview.classList.remove('hidden');

  // Group activity rows by date
  const byDate = {};
  rows.forEach(r => {
    if (!byDate[r.date]) byDate[r.date] = { date: r.date, activities: [], hrv: null, sleep: null, stress: null };
    if (r.kind === 'activity') byDate[r.date].activities.push(r.activity);
    if (r.kind === 'health') {
      if (r.hrv)    byDate[r.date].hrv    = r.hrv;
      if (r.sleep)  byDate[r.date].sleep  = r.sleep;
      if (r.stress) byDate[r.date].stress = r.stress;
    }
  });

  const sorted = Object.values(byDate).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 60);

  list.innerHTML = sorted.map(d => {
    const dateStr = new Date(d.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const details = [
      d.hrv ? `HRV: ${d.hrv} ms` : '',
      d.activities.length ? d.activities.join(', ') : '',
      d.sleep  ? `Sleep: ${d.sleep}` : '',
      d.stress ? `Stress: ${d.stress}` : '',
    ].filter(Boolean).join(' · ');

    return `
      <div class="preview-row">
        <input type="checkbox" class="garmin-row-check" data-date="${d.date}" checked />
        <span class="pr-date">${dateStr}</span>
        ${d.hrv ? `<span class="pr-hrv">${d.hrv} ms</span>` : ''}
        <span class="pr-detail">${details || '—'}</span>
      </div>`;
  }).join('');
}

document.getElementById('garmin-import-confirm').addEventListener('click', () => {
  const checked = [...document.querySelectorAll('.garmin-row-check:checked')].map(cb => cb.dataset.date);
  if (!checked.length) { showGarminMsg('No rows selected.', 'error'); return; }

  // Rebuild date map from parsed rows
  const byDate = {};
  garminParsedRows.forEach(r => {
    if (!byDate[r.date]) byDate[r.date] = { date: r.date, activities: [], hrv: null, sleep: null, stress: null };
    if (r.kind === 'activity') byDate[r.date].activities.push(r.activity);
    if (r.kind === 'health') {
      if (r.hrv)    byDate[r.date].hrv    = r.hrv;
      if (r.sleep)  byDate[r.date].sleep  = r.sleep;
      if (r.stress) byDate[r.date].stress = r.stress;
    }
  });

  const entries = loadEntries();
  let added = 0, updated = 0;

  checked.forEach(date => {
    const d   = byDate[date];
    if (!d) return;

    const existing = entries.find(en => en.date === date);
    if (existing) {
      if (d.hrv)              existing.hrv        = Math.round(d.hrv);
      if (d.activities.length) existing.activities = [...new Set([...(existing.activities||[]), ...d.activities])];
      updated++;
    } else {
      entries.push({
        id:         Date.now() + Math.random(),
        date,
        hrv:        d.hrv ? Math.round(d.hrv) : null,
        energy:     5,
        stress:     d.stress ? Math.min(10, Math.round(d.stress / 10)) : 5,
        sleep:      d.sleep  ? Math.min(10, Math.round(d.sleep  / 10)) : 5,
        mood:       5,
        activities: d.activities,
        notes:      'Imported from Garmin',
      });
      added++;
    }
  });

  entries.sort((a, b) => b.date.localeCompare(a.date));
  saveEntries(entries);

  document.getElementById('garmin-preview').classList.add('hidden');
  garminParsedRows = [];
  showGarminMsg(`Imported ${added} new + updated ${updated} existing entries.`, 'success');
});

document.getElementById('garmin-import-cancel').addEventListener('click', () => {
  document.getElementById('garmin-preview').classList.add('hidden');
  garminParsedRows = [];
});

const garminImportMsg = document.getElementById('garmin-import-msg');
function showGarminMsg(text, type) {
  garminImportMsg.textContent = text;
  garminImportMsg.className = `import-msg ${type}`;
  clearTimeout(garminImportMsg._t);
  garminImportMsg._t = setTimeout(() => { garminImportMsg.className = 'import-msg hidden'; }, 5000);
}

// ── Training load chart ───────────────────────────────────────────────────────

let loadChart = null;

const TYPE_COLOR = {
  'Running':          'rgba(248,113,113,.75)',
  'Cycling':          'rgba(251,191,36,.75)',
  'Strength training':'rgba(91,141,238,.75)',
  'Swimming':         'rgba(52,211,153,.75)',
  'Walking':          'rgba(148,163,184,.5)',
  'Yoga':             'rgba(167,139,250,.75)',
  'Meditation':       'rgba(167,139,250,.5)',
};
const DEFAULT_COLOR = 'rgba(100,116,139,.6)';

function renderLoadChart(rangeDays = 30) {
  const activities = loadActivities();
  const empty = document.getElementById('load-chart-empty');
  const wrap  = document.getElementById('load-chart-wrap');

  if (!activities.length) {
    if (loadChart) { loadChart.destroy(); loadChart = null; }
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  const end   = todayStr();
  const days  = rangeDays > 0 ? rangeDays : 90;
  const _s = new Date(); _s.setDate(_s.getDate() - days); const start = localDateStr(_s);
  const series = TrainingLoad.compute(activities, start, end);

  // Build projection overlay if a plan exists
  const plan = TrainingPlan.load();
  const projection = plan ? TrainingPlan.project(plan, activities) : {};
  const projDates  = Object.keys(projection).sort();
  const capDate    = plan ? plan.raceDate : null;
  const futureDates = projDates.filter(d => d > end && (!capDate || d <= capDate));

  // Merged date arrays: historical + future
  const allDates  = [...Object.keys(series), ...futureDates];
  const efforts   = allDates.map(d => d <= end ? series[d]?.effort ?? 0 : null);
  const atls      = allDates.map(d => d <= end ? series[d]?.atl   ?? 0 : null);
  const ctls      = allDates.map(d => d <= end ? series[d]?.ctl   ?? 0 : null);
  const tsbs      = allDates.map(d => d <= end ? series[d]?.tsb   ?? 0 : null);
  // Projected CTL starts from today's actual value so lines connect
  const projCTLs  = allDates.map((d, i) => {
    if (d < end)  return null;
    if (d === end) return series[d]?.ctl ?? null;
    return projection[d]?.ctl ?? null;
  });

  // Bar colors: dominant activity type per day
  const barColors = allDates.map(date => {
    if (date > end) return 'rgba(91,141,238,.25)'; // future — muted
    const acts = activities.filter(a => a.date === date);
    if (!acts.length) return 'rgba(46,51,72,.4)';
    const dominant = acts.reduce((a, b) => (a.effort || 0) >= (b.effort || 0) ? a : b);
    return TYPE_COLOR[dominant.mappedType] || DEFAULT_COLOR;
  });

  // Thin x-axis tick labels; mark race day
  const skipN = allDates.length > 60 ? 7 : allDates.length > 30 ? 3 : 1;
  const tickLabels = allDates.map((d, i) => {
    if (capDate && d === capDate) return '🏁';
    return i % skipN === 0
      ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : '';
  });

  const ctx = document.getElementById('load-chart').getContext('2d');
  if (loadChart) { loadChart.destroy(); loadChart = null; }

  const datasets = [
    {
      label: 'Daily Effort',
      data: efforts,
      backgroundColor: barColors,
      borderRadius: 3,
      order: 3,
      yAxisID: 'y',
    },
    {
      label: 'ATL – Fatigue',
      data: atls,
      type: 'line',
      borderColor: '#f87171',
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.4,
      fill: false,
      order: 1,
      yAxisID: 'y',
    },
    {
      label: 'CTL – Fitness',
      data: ctls,
      type: 'line',
      borderColor: '#5b8dee',
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.4,
      fill: false,
      order: 1,
      yAxisID: 'y',
    },
    {
      label: 'TSB – Form',
      data: tsbs,
      type: 'line',
      borderColor: '#34d399',
      borderWidth: 1.5,
      borderDash: [4, 3],
      pointRadius: 0,
      tension: 0.4,
      fill: { target: 'origin', above: 'rgba(52,211,153,.08)', below: 'rgba(248,113,113,.08)' },
      order: 2,
      yAxisID: 'y2',
    },
  ];

  if (futureDates.length) {
    datasets.push({
      label: 'CTL – Projected',
      data: projCTLs,
      type: 'line',
      borderColor: '#5b8dee',
      borderWidth: 2,
      borderDash: [6, 4],
      pointRadius: 0,
      tension: 0.3,
      fill: false,
      order: 1,
      yAxisID: 'y',
    });
  }

  loadChart = new Chart(ctx, {
    type: 'bar',
    data: { labels: tickLabels, datasets },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#8891a8', font: { size: 11 }, boxWidth: 12 } },
        tooltip: {
          backgroundColor: '#1a1d27',
          borderColor: '#2e3348',
          borderWidth: 1,
          titleColor: '#e8eaf0',
          bodyColor: '#8891a8',
          callbacks: {
            title: (items) => allDates[items[0].dataIndex],
            afterBody: (items) => {
              const date = allDates[items[0].dataIndex];
              if (date > end) {
                const p = projection[date];
                return p ? [`  Projected CTL ${p.ctl} · ATL ${p.atl} · TSB ${p.tsb > 0 ? '+' : ''}${p.tsb}`] : [];
              }
              const acts = activities.filter(a => a.date === date);
              return acts.map(a => `  ${actIcon(a.mappedType)} ${a.name} (${a.effort} pts)`);
            },
          },
        },
      },
      scales: {
        x:  { ticks: { color: '#8891a8', maxRotation: 0 }, grid: { color: '#1e2235' } },
        y:  { ticks: { color: '#8891a8' }, grid: { color: '#2e3348' }, title: { display: true, text: 'Load', color: '#8891a8' } },
        y2: { position: 'right', ticks: { color: '#34d399' }, grid: { drawOnChartArea: false }, title: { display: true, text: 'Form (TSB)', color: '#34d399' } },
      },
    },
  });
}

// ── Insights panel ────────────────────────────────────────────────────────────

function renderInsights() {
  const grid       = document.getElementById('insights-grid');
  const activities = loadActivities();
  const entries    = loadEntries();
  grid.innerHTML   = '';

  if (!activities.length) return;

  // Card 1: Current training status
  const load = TrainingLoad.latest(activities);
  const tsbLabel = load.tsb > 10 ? 'Fresh' : load.tsb > -10 ? 'Neutral' : 'Fatigued';
  const tsbCls   = load.tsb > 10 ? 'pos'   : load.tsb > -10 ? ''        : 'neg';
  grid.insertAdjacentHTML('beforeend', `
    <div class="insight-card">
      <h4>Current Status</h4>
      <div class="insight-row"><span class="insight-type">Fitness (CTL)</span><span class="insight-val">${load.ctl}</span></div>
      <div class="insight-row"><span class="insight-type">Fatigue (ATL)</span><span class="insight-val">${load.atl}</span></div>
      <div class="insight-row"><span class="insight-type">Form (TSB)</span><span class="insight-val ${tsbCls}">${load.tsb > 0 ? '+' : ''}${load.tsb} — ${tsbLabel}</span></div>
    </div>`);

  // Card 2: HRV correlations per activity type
  const corr = RecoveryAnalytics.correlations(activities, entries);
  const types = Object.keys(corr);
  if (types.length) {
    const rows = types.map(t => {
      const d1 = corr[t][1];
      const d2 = corr[t][2];
      const pct = d1 ?? d2;
      if (pct == null) return '';
      const cls = pct < 0 ? 'neg' : 'pos';
      const lag = d1 != null ? 'next day' : '2 days';
      return `<div class="insight-row"><span class="insight-type">${actIcon(t)} ${t}</span><span class="insight-val ${cls}">${pct > 0 ? '+' : ''}${pct}% HRV (${lag})</span></div>`;
    }).filter(Boolean);
    if (rows.length) {
      grid.insertAdjacentHTML('beforeend', `<div class="insight-card"><h4>HRV After Training</h4>${rows.join('')}</div>`);
    }
  }

  // Card 3: Days of suppression per type
  const suppTypes = Object.keys(corr).filter(t => corr[t][1] < -5 || corr[t][2] < -5);
  if (suppTypes.length) {
    const rows = suppTypes.map(t => {
      const days = [1,2,3].filter(d => corr[t][d] != null && corr[t][d] < -5);
      return `<div class="insight-row"><span class="insight-type">${actIcon(t)} ${t}</span><span class="insight-val neg">~${days.length} day${days.length > 1 ? 's' : ''} recovery</span></div>`;
    });
    grid.insertAdjacentHTML('beforeend', `<div class="insight-card"><h4>Recovery Time</h4>${rows.join('')}</div>`);
  }

  // Card 4: Recent hard sessions
  const hard = activities
    .filter(a => (a.effort || 0) >= RecoveryAnalytics.EFFORT_THRESHOLD)
    .slice(0, 4);
  if (hard.length) {
    const rows = hard.map(a => {
      const dateStr = new Date(a.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      return `<div class="insight-row"><span class="insight-type">${actIcon(a.mappedType)} ${dateStr}</span><span class="insight-val">${a.effort} pts</span></div>`;
    });
    grid.insertAdjacentHTML('beforeend', `<div class="insight-card"><h4>Hard Sessions</h4>${rows.join('')}</div>`);
  }
}

// ── Training context (log tab) ────────────────────────────────────────────────

function updateTrainingContext() {
  const el = document.getElementById('training-context');
  const activities = loadActivities();
  if (!activities.length) { el.classList.add('hidden'); return; }

  const load = TrainingLoad.latest(activities);
  const tsbLabel = load.tsb > 10 ? 'Fresh — good day to train hard' :
                   load.tsb > -5 ? 'Neutral — moderate effort OK' :
                   load.tsb > -20 ? 'Fatigued — consider easy day' : 'Very fatigued — prioritise recovery';
  const tsbCls   = load.tsb > 10 ? 'tc-fresh' : load.tsb > -5 ? 'tc-neutral' : 'tc-fatigued';

  el.className = 'training-context';
  el.innerHTML = `
    <div class="tc-stat"><div class="tc-value" style="color:var(--accent)">${load.ctl}</div><div class="tc-label">Fitness</div></div>
    <div class="tc-stat"><div class="tc-value" style="color:var(--red)">${load.atl}</div><div class="tc-label">Fatigue</div></div>
    <div class="tc-stat"><div class="tc-value ${tsbCls}">${load.tsb > 0 ? '+' : ''}${load.tsb}</div><div class="tc-label">Form</div></div>
    <div class="tc-note">${tsbLabel}</div>`;
}

// ── Race modal ────────────────────────────────────────────────────────────────

let _currentRaceId = null;

function showRaceModal(activity) {
  _currentRaceId = activity.id;
  const dateStr = new Date(activity.date + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });
  document.getElementById('race-modal-desc').textContent =
    `"${activity.name}" on ${dateStr} looks like a race (${fmtDist(activity.distanceM)}${activity.avgHR ? `, ♥ ${activity.avgHR} bpm avg` : ''}). Confirm details below.`;
  document.getElementById('race-place').value  = '';
  document.getElementById('race-splits').value = '';
  document.getElementById('race-notes').value  = '';
  document.getElementById('race-modal').classList.remove('hidden');
}

function closeRaceModal(confirmed, details = null) {
  document.getElementById('race-modal').classList.add('hidden');
  if (_currentRaceId != null) {
    const activities = loadActivities();
    const act = activities.find(a => a.id === _currentRaceId);
    if (act) {
      act.raceConfirmed = confirmed;
      act.isRace = confirmed;
      if (details) act.raceDetails = details;
      saveActivities(activities);
    }
    const q = JSON.parse(localStorage.getItem('race_queue') || '[]')
      .filter(id => id !== _currentRaceId);
    localStorage.setItem('race_queue', JSON.stringify(q));
    _currentRaceId = null;
    // Show next in queue
    setTimeout(() => StravaSync.processRaceQueue(), 300);
  }
}

document.getElementById('race-confirm-btn').addEventListener('click', () => {
  closeRaceModal(true, {
    place:  document.getElementById('race-place').value.trim(),
    splits: document.getElementById('race-splits').value.trim(),
    notes:  document.getElementById('race-notes').value.trim(),
  });
});
document.getElementById('race-skip-btn').addEventListener('click', () => closeRaceModal(false));
document.getElementById('race-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeRaceModal(false);
});

// ── Sync status ───────────────────────────────────────────────────────────────

function updateSyncStatus() {
  const el = document.getElementById('sync-status-text');
  if (!el) return;
  const lastSync = parseInt(localStorage.getItem('strava_last_sync') || '0', 10);
  if (!lastSync) { el.textContent = 'Never synced'; return; }
  const mins = Math.round((Date.now() - lastSync) / 60000);
  el.textContent = mins < 2 ? 'Synced just now' :
                   mins < 60 ? `Synced ${mins}m ago` :
                   `Synced ${Math.round(mins/60)}h ago`;
  const count = loadActivities().length;
  if (count) el.textContent += ` · ${count} activities`;
}

function updateSyncProgress(text, done = false) {
  const el = document.getElementById('sync-progress');
  if (!el) return;
  el.textContent = text;
  el.className = `import-msg ${done ? 'success' : 'info'}`;
  if (done) setTimeout(() => { el.className = 'import-msg hidden'; }, 5000);
}

document.getElementById('manual-sync-btn')?.addEventListener('click', async function() {
  const btn = this;
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  try {
    const n = await StravaSync.syncRecent(t => updateSyncProgress(t));
    updateSyncProgress(`Done — ${n} new activit${n === 1 ? 'y' : 'ies'} added.`, true);
    updateSyncStatus();
    StravaSync.processRaceQueue();
    updateTrainingContext();
  } catch (err) {
    updateSyncProgress(`Sync failed: ${err.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sync Now';
  }
});

// ── Insights tab ─────────────────────────────────────────────────────────────

let _recoveryCurveChart = null;
let _raceCorrelationChart = null;

function renderInsightsTab() {
  const entries    = loadEntries();
  const activities = loadActivities();

  // ── AI-style insight cards ──
  const cardsList = document.getElementById('insight-cards-list');
  if (cardsList) {
    const insights = InsightEngine.generate(entries, activities);
    const visible = insights.filter(ins => !InsightCards.isDismissed(ins.text.slice(0, 40)));
    if (visible.length) {
      cardsList.innerHTML = visible.map(ins => {
        const key = ins.text.slice(0, 40);
        return `<div class="ai-insight-card" data-key="${key.replace(/"/g,'&quot;')}">
          <span class="ins-icon">${ins.icon}</span>
          <span class="ins-text">${ins.text}</span>
          <button class="ins-dismiss-btn" data-key="${key.replace(/"/g,'&quot;')}" title="Dismiss">✕</button>
        </div>`;
      }).join('');
      cardsList.querySelectorAll('.ins-dismiss-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          InsightCards.dismiss(btn.dataset.key);
          btn.closest('.ai-insight-card').remove();
        });
      });
    } else {
      cardsList.innerHTML = '<div class="empty-state">Keep logging — insights will appear once you have enough data.</div>';
    }
  }

  // ── Weekly digest list ──
  const digestList = document.getElementById('digest-list');
  if (digestList) {
    const digests = WeeklyDigest.load();
    if (digests.length) {
      digestList.innerHTML = digests.map(d => {
        const weekLabel = `Week of ${d.weekStarting} – ${d.weekEnding}`;
        return `<div class="digest-card">
          <div class="digest-week">${weekLabel}</div>
          <div class="digest-summary">${d.summary}</div>
          <div class="digest-stats">
            ${d.avgHRV != null ? `<span class="dstat">Avg HRV <strong>${d.avgHRV} ms</strong></span>` : ''}
            ${d.avgSleep != null ? `<span class="dstat">Avg Sleep <strong>${d.avgSleep}h</strong></span>` : ''}
            <span class="dstat">Load <strong>${d.totalATL}</strong></span>
            ${d.suppressionEvents ? `<span class="dstat">Suppression days <strong>${d.suppressionEvents}</strong></span>` : ''}
          </div>
        </div>`;
      }).join('');
    } else {
      digestList.innerHTML = '<div class="empty-state">Weekly digest generates each Sunday.</div>';
    }
  }

  // ── Suppression alert log ──
  const alertLogList = document.getElementById('alert-log-list');
  if (alertLogList) {
    const alerts = SuppressionAlerts.load();
    if (alerts.length) {
      alertLogList.innerHTML = alerts.map(a => {
        const ackHtml = a.acknowledged ? '<span class="al-ack">acknowledged</span>' : '';
        return `<div class="alert-log-item">
          <span class="al-date">${a.date}</span>
          ${a.consecutiveDays} consecutive suppressed days — ${a.suggestion}
          ${ackHtml}
        </div>`;
      }).join('');
    } else {
      alertLogList.innerHTML = '<div class="empty-state">No suppression alerts yet.</div>';
    }
  }

  // ── Recovery curve chart ──
  const rcCtx = document.getElementById('recovery-curve-chart');
  if (rcCtx) {
    if (_recoveryCurveChart) { _recoveryCurveChart.destroy(); _recoveryCurveChart = null; }
    const curveData = RecoveryCurve.compute(entries, activities);

    // Count instances per type for building-data message
    const allByType = {};
    for (const act of activities.filter(a=>(a.effort||0)>=RecoveryAnalytics.EFFORT_THRESHOLD)) {
      if (AdaptiveBaseline.compute(entries, act.date)) {
        (allByType[act.mappedType]??=[]).push(1);
      }
    }
    const buildingTypes = Object.entries(allByType)
      .filter(([t,arr])=>arr.length<3&&arr.length>0&&!curveData.find(c=>c.type===t))
      .map(([t,arr])=>`${actIcon(t)} ${t}: ${arr.length}/3 sessions`);

    if (curveData.length) {
      _recoveryCurveChart = new Chart(rcCtx.getContext('2d'), {
        type: 'bar',
        data: {
          labels: curveData.map(c => c.type),
          datasets: [{
            label: 'Avg days to baseline recovery',
            data: curveData.map(c => c.avgDays),
            backgroundColor: curveData.map(c => TYPE_COLOR[c.type] || DEFAULT_COLOR),
            borderRadius: 4,
          }],
        },
        options: {
          indexAxis: 'y',
          responsive: true,
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#1a1d27', borderColor: '#2e3348', borderWidth: 1,
              titleColor: '#e8eaf0', bodyColor: '#8891a8',
              callbacks: { label: ctx => `${ctx.raw} days avg (${curveData[ctx.dataIndex].count} sessions)` },
            },
          },
          scales: {
            x: { ticks: { color: '#8891a8' }, grid: { color: '#2e3348' }, title: { display: true, text: 'Days', color: '#8891a8' } },
            y: { ticks: { color: '#8891a8' }, grid: { color: '#1e2235' } },
          },
        },
      });
      if (buildingTypes.length) {
        const note = document.createElement('p');
        note.className = 'building-data-note';
        note.textContent = `Building data: ${buildingTypes.join(' · ')}`;
        rcCtx.parentElement.appendChild(note);
      }
    } else {
      rcCtx.parentElement.innerHTML = '<p class="chart-empty">Not enough data for recovery curve yet.</p>';
      if (buildingTypes.length) {
        const note = document.createElement('p');
        note.className = 'building-data-note';
        note.textContent = `Building data: ${buildingTypes.join(' · ')}`;
        rcCtx.parentElement.appendChild(note);
      }
    }
  }

  // ── Race correlation chart + pre-race strips ──
  const races = activities.filter(a => a.isRace && a.raceConfirmed);
  const racePoints = races.map(r => {
    const d7 = new Date(r.date + 'T12:00:00'); d7.setDate(d7.getDate() - 7);
    const weekEntries = entries.filter(e => e.date >= d7.toISOString().slice(0, 10) && e.date < r.date && e.hrv);
    const avgHrv = weekEntries.length ? weekEntries.reduce((s, e) => s + e.hrv, 0) / weekEntries.length : null;
    const raceEntry = entries.find(e => e.date === r.date);
    const readiness = raceEntry?.readinessScore ?? null;
    return { name: r.name, date: r.date, avgHrv: avgHrv ? +avgHrv.toFixed(1) : null, readiness };
  }).filter(p => p.avgHrv != null);

  const raceCtx = document.getElementById('race-correlation-chart');
  if (raceCtx) {
    if (_raceCorrelationChart) { _raceCorrelationChart.destroy(); _raceCorrelationChart = null; }
    if (racePoints.length < 5) {
      raceCtx.parentElement.innerHTML = `<p class="chart-empty">Log ${5 - racePoints.length} more confirmed race${5 - racePoints.length !== 1 ? 's' : ''} to unlock the race readiness correlation chart.</p>`;
    } else {
      const trendDatasets = [];
      if (racePoints.length >= 2) {
        const n = racePoints.length;
        const sumX = racePoints.reduce((s,p)=>s+(p.readiness??50),0);
        const sumY = racePoints.reduce((s,p)=>s+p.avgHrv,0);
        const sumXY = racePoints.reduce((s,p)=>s+(p.readiness??50)*p.avgHrv,0);
        const sumX2 = racePoints.reduce((s,p)=>s+Math.pow(p.readiness??50,2),0);
        const slope = (n*sumXY - sumX*sumY) / (n*sumX2 - sumX*sumX);
        const intercept = (sumY - slope*sumX) / n;
        const xMin = Math.min(...racePoints.map(p=>p.readiness??50)) - 5;
        const xMax = Math.max(...racePoints.map(p=>p.readiness??50)) + 5;
        trendDatasets.push({
          label: 'Trend',
          type: 'line',
          data: [{x: xMin, y: slope*xMin+intercept}, {x: xMax, y: slope*xMax+intercept}],
          borderColor: 'rgba(91,141,238,.6)',
          borderWidth: 1.5,
          borderDash: [4,3],
          pointRadius: 0,
          fill: false,
        });
      }
      _raceCorrelationChart = new Chart(raceCtx.getContext('2d'), {
        type: 'scatter',
        data: {
          datasets: [
            {
              label: 'Race readiness',
              data: racePoints.map(p => ({ x: p.readiness ?? 50, y: p.avgHrv })),
              backgroundColor: 'rgba(251,191,36,.7)',
              pointRadius: 7,
              pointHoverRadius: 9,
            },
            ...trendDatasets,
          ],
        },
        options: {
          responsive: true,
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#1a1d27', borderColor: '#2e3348', borderWidth: 1,
              titleColor: '#e8eaf0', bodyColor: '#8891a8',
              callbacks: {
                label: ctx => {
                  if (ctx.datasetIndex > 0) return null;
                  const p = racePoints[ctx.dataIndex];
                  return `${p.name} (${p.date}): RS ${ctx.raw.x}, HRV avg ${ctx.raw.y} ms`;
                },
              },
            },
          },
          scales: {
            x: { title: { display: true, text: 'Readiness Score', color: '#8891a8' }, ticks: { color: '#8891a8' }, grid: { color: '#2e3348' } },
            y: { title: { display: true, text: '7-day avg HRV (ms)', color: '#8891a8' }, ticks: { color: '#8891a8' }, grid: { color: '#2e3348' } },
          },
        },
      });
    }
  }

  // Pre-race strips
  const strips = document.getElementById('pre-race-strips');
  if (strips) {
    strips.innerHTML = racePoints.map(p =>
      `<div class="pre-race-strip">
        <span class="prs-name">${p.name} <span class="prs-date">${p.date}</span></span>
        <span class="prs-hrv">${p.avgHrv} ms HRV</span>
        ${p.readiness != null ? `<span class="prs-rs">RS ${p.readiness}</span>` : ''}
      </div>`
    ).join('');
  }

  renderEnvInsights();
  renderNarratives();
}

// ── Suppression banner (History tab) ─────────────────────────────────────────

function checkSuppressionBanner() {
  const banner = document.getElementById('suppression-banner');
  if (!banner) return;
  const alert = SuppressionAlerts.load().find(a => !a.acknowledged);
  if (!alert) { banner.classList.add('hidden'); return; }
  banner.classList.remove('hidden');
  banner.innerHTML = `
    <span class="banner-text">
      ⚠️ <strong>Possible overreach:</strong> ${alert.consecutiveDays} consecutive days below your HRV baseline.
      ${alert.suggestion}
    </span>
    <button class="banner-dismiss" title="Dismiss" data-alert-id="${alert.id}">✕</button>`;
  banner.querySelector('.banner-dismiss').addEventListener('click', () => {
    SuppressionAlerts.acknowledge(alert.id);
    banner.classList.add('hidden');
  });
}

// ── Notification permission button ───────────────────────────────────────────

document.getElementById('notif-permission-btn')?.addEventListener('click', async () => {
  const granted = await Notifs.request();
  updateStravaUI();
  if (granted) {
    const btn = document.getElementById('notif-permission-btn');
    if (btn) { btn.textContent = 'Notifications enabled'; btn.disabled = true; }
  }
});

document.getElementById('save-notif-time-btn')?.addEventListener('click', async () => {
  const t = document.getElementById('notif-time').value;
  if (!t) return;
  localStorage.setItem('notif_time', t);
  const granted = await Notifs.request();
  const statusEl = document.getElementById('notif-time-status');
  if (statusEl) statusEl.textContent = granted ? `Reminder set for ${t} daily.` : 'Enable notifications above first.';
  updateNotifPermissionBtn();
});

document.getElementById('save-notif-eod-btn')?.addEventListener('click', async () => {
  const t = document.getElementById('notif-eod-time').value;
  if (!t) return;
  localStorage.setItem('notif_eod_time', t);
  const granted = await Notifs.request();
  const statusEl = document.getElementById('notif-eod-status');
  if (statusEl) statusEl.textContent = granted ? `End-of-day reminder set for ${t}.` : 'Enable notifications above first.';
  updateNotifPermissionBtn();
});

function updateNotifPermissionBtn() {
  const btn = document.getElementById('notif-permission-btn');
  if (!btn) return;
  if (!('Notification' in window) || Notification.permission === 'denied') {
    btn.classList.add('hidden');
  } else if (Notification.permission === 'granted') {
    btn.textContent = '✓ Notifications enabled';
    btn.disabled = true;
  } else {
    btn.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = 'Enable Notifications';
  }
}

// ── Weather & Environmental ────────────────────────────────────────────────────

function updateWeatherUI() {
  const coords    = WeatherService.getCoords();
  const dot       = document.getElementById('wx-status-dot');
  const setup     = document.getElementById('wx-setup');
  const connected = document.getElementById('wx-connected-view');
  if (!setup || !connected) return;

  if (!coords) {
    dot?.setAttribute('title', 'No location set');
    dot?.classList.remove('connected');
    dot?.classList.add('disconnected');
    setup.classList.remove('hidden');
    connected.classList.add('hidden');
    return;
  }

  dot?.setAttribute('title', 'Location set');
  dot?.classList.remove('disconnected');
  dot?.classList.add('connected');
  setup.classList.add('hidden');
  connected.classList.remove('hidden');

  const display = document.getElementById('wx-coords-display');
  if (display) {
    const latDir = coords.lat >= 0 ? 'N' : 'S';
    const lonDir = coords.lon >= 0 ? 'E' : 'W';
    display.textContent =
      `📍 ${Math.abs(coords.lat).toFixed(2)}° ${latDir}, ${Math.abs(coords.lon).toFixed(2)}° ${lonDir}`;
  }

  const elevDisplay = document.getElementById('wx-elevation-display');
  if (elevDisplay) {
    const cached = localStorage.getItem(WeatherService.ELEV_KEY);
    if (cached !== null) {
      const m = Math.round(+cached);
      elevDisplay.textContent = `Elevation: ${m} m${m > 1500 ? ' · altitude may affect HRV' : ''}`;
    } else {
      WeatherService.fetchElevation(coords.lat, coords.lon)
        .then(elev => {
          if (elev != null) {
            const m = Math.round(elev);
            elevDisplay.textContent = `Elevation: ${m} m${m > 1500 ? ' · altitude may affect HRV' : ''}`;
          }
        }).catch(() => {});
    }
  }
}

function renderEnvInsights() {
  const el = document.getElementById('env-insights');
  if (!el) return;

  const allEntries = loadEntries();
  const wxEntries  = allEntries.filter(e => e.weather && e.hrv > 0);

  if (wxEntries.length < 7) {
    const have   = wxEntries.length;
    const needed = 7 - have;
    el.innerHTML = `<div class="env-empty">
      <p>Weather data is attached to each entry once location is set in the Connect tab.</p>
      ${have > 0
        ? `<p class="footnote">${have} day${have !== 1 ? 's' : ''} collected — ${needed} more to unlock correlations.</p>`
        : `<p class="footnote">Enable location in Connect → Weather to start collecting data.</p>`}
    </div>`;
    return;
  }

  const baseline = wxEntries.reduce((s, e) => s + e.hrv, 0) / wxEntries.length;

  const tempBins = [
    { label: '< 5°C',    emoji: '🥶', min: -Infinity, max: 5   },
    { label: '5 – 15°C', emoji: '🌤', min: 5,         max: 15  },
    { label: '15 – 25°C',emoji: '☀️', min: 15,        max: 25  },
    { label: '25 – 32°C',emoji: '🌡️', min: 25,        max: 32  },
    { label: '> 32°C',   emoji: '🔥', min: 32,        max: Infinity },
  ];

  const humBins = [
    { label: '< 40%',    emoji: '🏜️', min: 0,  max: 40  },
    { label: '40 – 60%', emoji: '👌', min: 40, max: 60  },
    { label: '60 – 80%', emoji: '💧', min: 60, max: 80  },
    { label: '> 80%',    emoji: '🌊', min: 80, max: 101 },
  ];

  const binRows = (bins, getValue) => bins.map(bin => {
    const m = wxEntries.filter(e => { const v = getValue(e); return v != null && v >= bin.min && v < bin.max; });
    if (m.length < 2) return null;
    const avg  = m.reduce((s, e) => s + e.hrv, 0) / m.length;
    const diff = avg - baseline;
    return { ...bin, avg: +avg.toFixed(1), diff: +diff.toFixed(1), n: m.length };
  }).filter(Boolean);

  const tempRows = binRows(tempBins, e => e.weather.tempMaxC);
  const humRows  = binRows(humBins,  e => e.weather.humidity);

  const rainDays = wxEntries.filter(e => (e.weather.precipMM ?? 0) > 1);
  const dryDays  = wxEntries.filter(e => (e.weather.precipMM ?? 0) <= 1);

  // Key insight: which temperature range hurts/helps most
  let banner = '';
  if (tempRows.length >= 3) {
    const sorted = [...tempRows].sort((a, b) => a.diff - b.diff);
    const worst  = sorted[0];
    if (Math.abs(worst.diff) >= 2) {
      const dir   = worst.diff < 0 ? 'lower' : 'higher';
      const color = worst.diff < 0 ? 'var(--red)' : 'var(--green)';
      banner = `<div class="env-banner">
        Your HRV averages <strong style="color:${color}">${Math.abs(worst.diff)} ms ${dir}</strong>
        on ${worst.emoji} ${worst.label} days compared to your mean.
      </div>`;
    }
  }

  const bar = (diff, n) => {
    const pct   = Math.min(100, Math.abs(diff) * 3);
    const color = diff >= 0 ? 'var(--green)' : 'var(--red)';
    const sign  = diff >= 0 ? '+' : '';
    return `<div class="env-bar-wrap">
      <div class="env-bar" style="width:${pct}%;background:${color}"></div>
      <span class="env-diff" style="color:${color}">${sign}${diff} ms</span>
      <span class="env-n">n=${n}</span>
    </div>`;
  };

  const table = (rows, title) => `
    <div class="env-table-label">${title}</div>
    <div class="env-table">
      ${rows.map(r => `
        <div class="env-row">
          <span class="env-label">${r.emoji} ${r.label}</span>
          <span class="env-avg">${r.avg} ms</span>
          ${bar(r.diff, r.n)}
        </div>`).join('')}
    </div>`;

  const precipHtml = (rainDays.length >= 2 && dryDays.length >= 2) ? `
    ${table([
      { emoji: '🌧', label: 'Rain days', avg: +(rainDays.reduce((s,e)=>s+e.hrv,0)/rainDays.length).toFixed(1), diff: +((rainDays.reduce((s,e)=>s+e.hrv,0)/rainDays.length) - baseline).toFixed(1), n: rainDays.length },
      { emoji: '☀️', label: 'Dry days',  avg: +(dryDays.reduce((s,e)=>s+e.hrv,0)/dryDays.length).toFixed(1),  diff: +((dryDays.reduce((s,e)=>s+e.hrv,0)/dryDays.length) - baseline).toFixed(1),  n: dryDays.length  },
    ], 'Precipitation')}` : '';

  el.innerHTML = `
    ${banner}
    <div class="env-subtitle">vs your mean ${baseline.toFixed(1)} ms · ${wxEntries.length} days logged</div>
    ${tempRows.length >= 2 ? table(tempRows, 'Temperature') : ''}
    ${humRows.length  >= 2 ? table(humRows,  'Humidity')    : ''}
    ${precipHtml}
  `;
}

// ── AI Narrative UI ───────────────────────────────────────────────────────────

function updateAIUI() {
  const hasKey    = !!NarrativeEngine.getApiKey();
  const dot       = document.getElementById('ai-status-dot');
  const setup     = document.getElementById('ai-setup');
  const connected = document.getElementById('ai-connected-view');
  if (!setup || !connected) return;

  if (hasKey) {
    dot?.classList.replace('disconnected', 'connected');
    dot?.setAttribute('title', 'API key saved');
    setup.classList.add('hidden');
    connected.classList.remove('hidden');
  } else {
    dot?.classList.replace('connected', 'disconnected');
    dot?.setAttribute('title', 'No API key');
    setup.classList.remove('hidden');
    connected.classList.add('hidden');
  }
}

async function runNarrativeGeneration(mk, triggerEl, statusEl) {
  const apiKey = NarrativeEngine.getApiKey();
  if (!apiKey) { alert('Add your Anthropic API key in Connect → AI Narratives first.'); return; }
  const orig = triggerEl.textContent;
  triggerEl.disabled = true;
  triggerEl.textContent = '…generating';
  if (statusEl) { statusEl.textContent = 'Calling Claude…'; statusEl.className = 'import-msg'; }
  try {
    await NarrativeEngine.generate(mk, apiKey, loadEntries(), loadActivities());
    renderNarratives();
  } catch (e) {
    if (statusEl) { statusEl.textContent = e.message; statusEl.className = 'import-msg error'; }
    triggerEl.disabled = false;
    triggerEl.textContent = orig;
  }
}

function renderNarratives() {
  const el = document.getElementById('narrative-list');
  if (!el) return;

  const apiKey     = NarrativeEngine.getApiKey();
  const narratives = NarrativeEngine.load();

  if (!apiKey) {
    el.innerHTML = `<div class="narrative-empty">
      <p>Add your Anthropic API key in <strong>Connect → AI Narratives</strong> to unlock monthly plain-language summaries — written by Claude from your actual data.</p>
      <p class="footnote" style="margin-top:6px">Each narrative costs ~$0.0001 (Haiku model). Generates automatically when a new month closes.</p>
    </div>`;
    return;
  }

  const now    = new Date();
  const curMk  = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const curLabel = NarrativeEngine.monthLabel(curMk);
  const hasCurrent = !!NarrativeEngine.getForMonth(curMk);

  const genBar = !hasCurrent ? `
    <div class="narrative-gen-bar">
      <button type="button" id="gen-current-btn" class="secondary small">Generate ${curLabel} now</button>
      <div id="gen-current-msg" class="import-msg hidden"></div>
    </div>` : '';

  if (!narratives.length) {
    el.innerHTML = genBar + `<div class="narrative-empty" style="margin-top:${hasCurrent ? 0 : 12}px">No narratives yet — generate your first one above.</div>`;
  } else {
    el.innerHTML = genBar + narratives.map(n => {
      const delta = n.stats.prevAvg != null
        ? `${(n.stats.avgHRV - n.stats.prevAvg) >= 0 ? '+' : ''}${(n.stats.avgHRV - n.stats.prevAvg).toFixed(1)} ms`
        : '';
      return `<div class="narrative-card">
        <div class="narrative-header">
          <span class="narrative-month">${n.label}</span>
          <span class="narrative-meta">${n.stats.daysLogged} days · ${n.stats.avgHRV} ms${delta ? ' · ' + delta : ''}</span>
          <button class="narrative-regen" data-month="${n.month}" title="Regenerate">↺</button>
        </div>
        <div class="narrative-text">${n.text}</div>
        <div class="narrative-footer">Generated ${new Date(n.generatedAt).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })}</div>
      </div>`;
    }).join('');
  }

  const genBtn = document.getElementById('gen-current-btn');
  if (genBtn) {
    genBtn.addEventListener('click', () =>
      runNarrativeGeneration(curMk, genBtn, document.getElementById('gen-current-msg'))
    );
  }

  el.querySelectorAll('.narrative-regen').forEach(btn => {
    btn.addEventListener('click', () => {
      const msgEl = btn.closest('.narrative-card').querySelector('.narrative-footer');
      runNarrativeGeneration(btn.dataset.month, btn, null);
    });
  });
}

// ── Gist Sync UI ─────────────────────────────────────────────────────────────

function fmtSyncTime(ts) {
  if (!ts) return 'Never synced';
  const d = new Date(parseInt(ts, 10));
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1)  return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24)   return `${diffH}h ago`;
  return d.toLocaleDateString();
}

function updateGistUI() {
  const configured  = GistSync.isConfigured();
  const tokenBad    = !!localStorage.getItem('gist_token_invalid');
  const setupEl     = document.getElementById('gist-setup-form');
  const connectedEl = document.getElementById('gist-connected-view');
  const dot         = document.getElementById('gist-status-dot');
  if (!setupEl || !connectedEl) return;

  if (configured && !tokenBad) {
    setupEl.classList.add('hidden');
    connectedEl.classList.remove('hidden');
    if (dot) { dot.className = 'status-dot connected'; dot.title = 'Connected'; }
    const lastEl = document.getElementById('gist-last-sync');
    if (lastEl) lastEl.textContent = fmtSyncTime(localStorage.getItem(GistSync.LAST_SYNC_KEY));
    setGistMsg('');
  } else {
    setupEl.classList.remove('hidden');
    connectedEl.classList.add('hidden');
    if (dot) { dot.className = 'status-dot disconnected'; dot.title = tokenBad ? 'Token expired' : 'Not connected'; }
    const tokenEl = document.getElementById('gist-token');
    if (tokenEl) tokenEl.value = '';
    if (tokenBad) {
      setGistMsg('Your GitHub token has expired. Generate a new one and reconnect — your local data is safe.', 'error');
    }
  }
}

function setGistMsg(text, type = '') {
  const el = document.getElementById('gist-msg');
  if (!el) return;
  el.textContent = text;
  el.className   = `import-msg${text ? '' : ' hidden'}${type ? ' ' + type : ''}`;
}

document.getElementById('gist-connect-btn')?.addEventListener('click', async () => {
  const tokenEl = document.getElementById('gist-token');
  const token   = tokenEl?.value.trim();
  if (!token) { setGistMsg('Paste your GitHub personal access token first.', 'error'); return; }

  setGistMsg('Validating token…');
  const btn = document.getElementById('gist-connect-btn');
  btn.disabled = true;

  try {
    // Verify token works
    await GistSync._req('GET', '/user', token);

    // Find existing HRV gist or create one
    setGistMsg('Looking for existing data…');
    let gistId = await GistSync.findGist(token);
    if (!gistId) {
      setGistMsg('Creating new private gist…');
      gistId = await GistSync.createGist(token);
    }

    localStorage.setItem(GistSync.TOKEN_KEY,   token);
    localStorage.setItem(GistSync.GIST_ID_KEY, gistId);
    localStorage.removeItem('gist_token_invalid');

    setGistMsg('Syncing data…');
    await GistSync.sync();
    setGistMsg('');
    updateGistUI();
  } catch (e) {
    setGistMsg(`Error: ${e.message}. Check your token has the "gist" scope.`, 'error');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('gist-sync-now-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('gist-sync-now-btn');
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  setGistMsg('');
  try {
    await GistSync.sync();
    setGistMsg('Synced successfully.', 'success');
    setTimeout(() => setGistMsg(''), 3000);
  } catch (e) {
    setGistMsg(`Sync failed: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sync Now';
    updateGistUI();
  }
});

document.getElementById('gist-disconnect-btn')?.addEventListener('click', () => {
  localStorage.removeItem(GistSync.TOKEN_KEY);
  localStorage.removeItem(GistSync.GIST_ID_KEY);
  localStorage.removeItem(GistSync.LAST_SYNC_KEY);
  setGistMsg('');
  updateGistUI();
});

// ── Manual Races ──────────────────────────────────────────────────────────────

function renderManualRaceList() {
  const el = document.getElementById('manual-race-list');
  if (!el) return;
  const manual = loadActivities().filter(a => a.isRace && a.raceConfirmed && a.manual);
  if (!manual.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="section-label" style="margin-top:0">Added races</div>` +
    manual.sort((a,b) => b.date.localeCompare(a.date)).map(a => `
      <div class="manual-race-row">
        <div>
          <div class="manual-race-name">${a.name}</div>
          <div class="manual-race-date">${a.date}${a.distLabel ? ' · ' + a.distLabel : ''}</div>
        </div>
        <button class="manual-race-del secondary small" data-id="${a.id}" aria-label="Remove">✕</button>
      </div>`).join('');

  el.querySelectorAll('.manual-race-del').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = +btn.dataset.id;
      saveActivities(loadActivities().filter(a => a.id !== id));
      renderManualRaceList();
    });
  });
}

(function initManualRaces() {
  const dateEl  = document.getElementById('manual-race-date');
  const nameEl  = document.getElementById('manual-race-name');
  const distEl  = document.getElementById('manual-race-dist');
  const addBtn  = document.getElementById('manual-race-add-btn');
  const msg     = document.getElementById('manual-race-msg');
  if (!addBtn) return;

  // Default date to today
  if (dateEl) dateEl.value = todayStr();

  function setMsg(text, isError) {
    if (!msg) return;
    msg.textContent = text;
    msg.style.color = isError ? 'var(--red)' : 'var(--green)';
    msg.classList.remove('hidden');
    if (!isError) setTimeout(() => msg.classList.add('hidden'), 3000);
  }

  addBtn.addEventListener('click', () => {
    const date = dateEl?.value.trim();
    const name = nameEl?.value.trim();
    if (!date) { setMsg('Pick a date.', true); return; }
    if (!name) { setMsg('Enter an event name.', true); return; }

    const activity = {
      id:           Date.now(),
      date,
      name,
      distLabel:    distEl?.value.trim() || null,
      mappedType:   'Race',
      stravaType:   'Race',
      isRace:       true,
      raceConfirmed: true,
      manual:       true,
      effort:       80,
      distanceM:    0,
      durationS:    0,
      elevationM:   0,
      avgHR:        null,
      maxHR:        null,
      avgPaceSecKm: null,
      raceDetails:  null,
    };

    const all = [...loadActivities(), activity].sort((a,b) => b.date.localeCompare(a.date));
    saveActivities(all);
    GistSync.pushSilent();
    renderManualRaceList();
    if (nameEl) nameEl.value = '';
    if (distEl) distEl.value = '';
    if (dateEl) dateEl.value = todayStr();
    setMsg(`✓ ${name} added.`, false);
  });

  renderManualRaceList();
})();

// ── Init ──────────────────────────────────────────────────────────────────────

function refreshAllViews() {
  renderHistory();
  renderTrends();
  checkSuppressionBanner();
}

// ── Weather Connect tab buttons ────────────────────────────────────────────────

document.getElementById('wx-location-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('wx-location-btn');
  const err = document.getElementById('wx-setup-error');
  btn.disabled = true;
  btn.textContent = 'Requesting location…';
  try {
    await WeatherService.requestLocation();
    updateWeatherUI();
    updateWeatherStrip(dateInput.value);
    if (err) { err.textContent = ''; err.classList.add('hidden'); }
  } catch (e) {
    if (err) { err.textContent = e.message; err.classList.remove('hidden'); }
  } finally {
    btn.disabled = false;
    btn.textContent = '📍 Use My Location';
  }
});

document.getElementById('wx-clear-btn')?.addEventListener('click', () => {
  WeatherService.clear();
  updateWeatherUI();
  updateWeatherStrip(dateInput.value);
});

document.getElementById('wx-backfill-btn')?.addEventListener('click', async () => {
  const btn      = document.getElementById('wx-backfill-btn');
  const progress = document.getElementById('wx-backfill-progress');
  if (!btn) return;
  btn.disabled = true;
  if (progress) { progress.textContent = 'Fetching weather data…'; progress.classList.remove('hidden'); }

  const entries = loadEntries();
  const count   = await WeatherService.backfill(entries, (done, total) => {
    if (progress) progress.textContent = `Fetching… ${done} / ${total}`;
  });

  if (count > 0) saveEntries(entries);
  btn.disabled = false;
  if (progress) {
    progress.textContent = count > 0
      ? `Done — added weather to ${count} entr${count !== 1 ? 'ies' : 'y'}.`
      : 'All entries already have weather data.';
    setTimeout(() => progress.classList.add('hidden'), 5000);
  }
});

// ── AI Narrative Connect tab buttons ──────────────────────────────────────────

document.getElementById('ai-connect-btn')?.addEventListener('click', () => {
  const keyEl = document.getElementById('anthropic-key');
  const key   = keyEl?.value.trim();
  if (!key || !key.startsWith('sk-')) {
    alert('Paste a valid Anthropic API key (starts with "sk-ant-" or "sk-").');
    return;
  }
  NarrativeEngine.saveApiKey(key);
  if (keyEl) keyEl.value = '';
  updateAIUI();
  // Auto-generate previous month if data exists
  NarrativeEngine.autoGenerate(loadEntries(), loadActivities());
});

document.getElementById('ai-disconnect-btn')?.addEventListener('click', () => {
  NarrativeEngine.clearApiKey();
  updateAIUI();
});

updateStravaUI();
updateSyncStatus();
updateTrainingContext();
updateGistUI();
updateWeatherUI();
updateAIUI();
checkSuppressionBanner();
renderFitnessCard();
renderTodaySession();

const savedNotifTime = localStorage.getItem('notif_time');
if (savedNotifTime) { const el = document.getElementById('notif-time'); if (el) el.value = savedNotifTime; }
const savedEodTime = localStorage.getItem('notif_eod_time');
if (savedEodTime) { const el = document.getElementById('notif-eod-time'); if (el) el.value = savedEodTime; }
updateNotifPermissionBtn();

Notifs.checkAll(loadEntries(), loadActivities());
StravaSync.autoSync().then(() => {
  updateSyncStatus();
  updateTrainingContext();
  StravaSync.processRaceQueue();
});
GistSync.autoSync();
NarrativeEngine.autoGenerate(loadEntries(), loadActivities());

// ── iOS PWA keyboard fix ─────────────────────────────────────────────────────
// In standalone (home-screen) mode iOS doesn't show the keyboard on tap unless
// focus() is called explicitly from a touchend event handler.
(function iosKeyboardFix() {
  const NEEDS_KEYBOARD = new Set(['text','number','password','email','search','tel','url','']);
  document.addEventListener('touchend', function(e) {
    const el = e.target;
    if (el.tagName === 'TEXTAREA' ||
        (el.tagName === 'INPUT' && NEEDS_KEYBOARD.has(el.type || ''))) {
      setTimeout(function() { el.focus(); }, 0);
    }
  }, { passive: true });
})();

// ── Pull to refresh ──────────────────────────────────────────────────────────

(function initPullToRefresh() {
  const THRESHOLD = 65;
  const indicator = document.getElementById('ptr-indicator');
  const label     = document.getElementById('ptr-label');
  let startY = 0, pulling = false, dist = 0;

  document.addEventListener('touchstart', e => {
    if (window.scrollY === 0 && e.touches.length === 1) {
      startY  = e.touches[0].clientY;
      pulling = true;
    }
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!pulling) return;
    dist = e.touches[0].clientY - startY;
    if (dist <= 0) { pulling = false; return; }

    indicator.classList.add('ptr-visible');
    indicator.classList.toggle('ptr-ready', dist >= THRESHOLD);
    label.textContent = dist >= THRESHOLD ? 'Release to refresh' : 'Pull to refresh';
  }, { passive: true });

  document.addEventListener('touchend', () => {
    if (!pulling) return;
    pulling = false;
    if (dist >= THRESHOLD) {
      indicator.classList.remove('ptr-ready');
      indicator.classList.add('ptr-spinning');
      label.textContent = 'Refreshing…';
      setTimeout(() => window.location.reload(), 400);
    } else {
      indicator.classList.remove('ptr-visible', 'ptr-ready');
    }
    dist = 0;
  });
})();
