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
    // 3-day trend
    const sorted = [...entries].sort((a,b)=>a.date.localeCompare(b.date));
    const idx = sorted.findIndex(e=>e.date===entry.date);
    const recent = sorted.slice(Math.max(0,idx-3),idx).map(e=>e.hrv).filter(Boolean);
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
    const score = Math.round(Math.max(0, Math.min(100,
      hrvScore * W.hrv + trendScore * W.trend + sleepScore * W.sleep + subjectiveScore * W.subjective
    )));
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

// ── Tab navigation ────────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'history')  { renderHistory(); checkSuppressionBanner(); }
    if (btn.dataset.tab === 'trends')   renderTrends();
    if (btn.dataset.tab === 'connect')  updateStravaUI();
    if (btn.dataset.tab === 'insights') renderInsightsTab();
  });
});

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

document.querySelectorAll('.date-quick-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const d = new Date();
    d.setDate(d.getDate() + +btn.dataset.offset);
    dateInput.value = localDateStr(d);
    updateDateDisplay();
    updateDateQuickBtns();
    clearStravaCards();
  });
});

dateInput.addEventListener('change', () => {
  updateDateDisplay();
  updateDateQuickBtns();
  clearStravaCards();
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
  showReadinessResult(_readiness);
  Notifs.checkAll(loadEntries(), loadActivities());
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
  renderChart(entries);
  renderLoadChart(days);
  renderInsights();
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

  const labels = Object.keys(series);
  const efforts = labels.map(d => series[d].effort);
  const atls    = labels.map(d => series[d].atl);
  const ctls    = labels.map(d => series[d].ctl);
  const tsbs    = labels.map(d => series[d].tsb);

  // Bar colors: dominant activity type per day
  const barColors = labels.map(date => {
    const acts = activities.filter(a => a.date === date);
    if (!acts.length) return 'rgba(46,51,72,.4)';
    const dominant = acts.reduce((a, b) => (a.effort || 0) >= (b.effort || 0) ? a : b);
    return TYPE_COLOR[dominant.mappedType] || DEFAULT_COLOR;
  });

  // Thin x-axis labels for larger ranges
  const skipN = labels.length > 60 ? 7 : labels.length > 30 ? 3 : 1;
  const tickLabels = labels.map((d, i) =>
    i % skipN === 0
      ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : ''
  );

  const ctx = document.getElementById('load-chart').getContext('2d');
  if (loadChart) { loadChart.destroy(); loadChart = null; }

  loadChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: tickLabels,
      datasets: [
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
      ],
    },
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
            title: (items) => labels[items[0].dataIndex],
            afterBody: (items) => {
              const date = labels[items[0].dataIndex];
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

// ── Init ──────────────────────────────────────────────────────────────────────

updateStravaUI();
updateSyncStatus();
updateTrainingContext();
checkSuppressionBanner();

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
