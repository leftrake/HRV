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

function todayStr()     { return new Date().toISOString().slice(0, 10); }
function yesterdayStr() { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); }

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
    url.searchParams.set('scope', 'activity:read_all');
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
      // Switch to connect tab to show success
      setTimeout(() => {
        document.querySelector('[data-tab="connect"]')?.click();
        updateStravaUI();
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
    if (btn.dataset.tab === 'history') renderHistory();
    if (btn.dataset.tab === 'trends')  renderTrends();
    if (btn.dataset.tab === 'connect') updateStravaUI();
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
    dateInput.value = d.toISOString().slice(0, 10);
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

['energy', 'stress', 'sleep', 'mood'].forEach(id => {
  const slider  = document.getElementById(id);
  const display = document.getElementById(`${id}-val`);
  slider.addEventListener('input', () => { display.textContent = slider.value; });
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

  const entry = {
    id:         Date.now(),
    date,
    hrv,
    energy:     +document.getElementById('energy').value,
    stress:     +document.getElementById('stress').value,
    sleep:      +document.getElementById('sleep').value,
    mood:       +document.getElementById('mood').value,
    activities,
    notes:        document.getElementById('notes').value.trim(),
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

  const entries = loadEntries();
  const idx = entries.findIndex(en => en.date === date);
  if (idx >= 0) { entries[idx] = entry; showMsg('Entry updated!', 'success'); }
  else          { entries.push(entry);  showMsg('Entry saved!', 'success'); }
  entries.sort((a, b) => b.date.localeCompare(a.date));
  saveEntries(entries);
  resetForm();
  delete form.dataset.editingId;
});

document.getElementById('clear-btn').addEventListener('click', resetForm);

function resetForm() {
  form.reset();
  dateInput.value = todayStr();
  updateDateDisplay();
  updateDateQuickBtns();
  ['energy', 'stress', 'sleep', 'mood'].forEach(id => {
    document.getElementById(id).value = 5;
    document.getElementById(`${id}-val`).textContent = '5';
  });
  indicator.style.background = 'var(--border)';
  ['resting-hr','readiness','sleep-duration','resp-rate','spo2','body-battery'].forEach(id => {
    document.getElementById(id).value = '';
  });
  clearStravaCards();
  document.getElementById('save-btn').textContent = 'Save Entry';
  delete form.dataset.editingId;
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

  ['energy', 'stress', 'sleep', 'mood'].forEach(id => {
    document.getElementById(id).value = entry[id] ?? 5;
    document.getElementById(`${id}-val`).textContent = entry[id] ?? 5;
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
    'sleep-duration': 'sleepDuration', 'resp-rate': 'respRate',
    'spo2': 'spo2', 'body-battery': 'bodyBattery' };
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
      <div class="card-actions">
        <button class="edit-btn" data-id="${en.id}" title="Edit">Edit</button>
        <button class="delete-btn" data-id="${en.id}" title="Delete">✕</button>
      </div>
      <div class="entry-header">
        <span class="entry-date">${date}</span>
        <span><span class="entry-hrv">${en.hrv}</span><span class="hrv-badge ${cls.cls}">${cls.label}</span></span>
      </div>
      <div class="entry-metrics">
        <div class="metric">Energy <span>${en.energy}/10</span></div>
        <div class="metric">Stress <span>${en.stress}/10</span></div>
        <div class="metric">Sleep <span>${en.sleep}/10</span></div>
        <div class="metric">Mood <span>${en.mood}/10</span></div>
      </div>
      ${deviceMetricsHTML(en)}
      ${activityHTML}
      ${notes}
    </div>`;
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
    const cs = cutoff.toISOString().slice(0, 10);
    entries = entries.filter(en => en.date >= cs);
  }
  renderStats(entries);
  renderChart(entries);
}

function renderStats(entries) {
  const grid = document.getElementById('stats-grid');
  if (!entries.length) { grid.innerHTML = '<div class="empty-state">No data for this range.</div>'; return; }
  const avg  = arr => (arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(1);
  const hrvs = entries.map(e => e.hrv);
  const trend = entries.length >= 2
    ? (entries.at(-1).hrv - entries[0].hrv > 0 ? '↑' : '↓') : '—';

  grid.innerHTML = `
    <div class="stat-card"><div class="stat-value" style="color:var(--accent)">${avg(hrvs)}</div><div class="stat-label">Avg HRV (ms)</div></div>
    <div class="stat-card"><div class="stat-value" style="color:var(--green)">${Math.max(...hrvs)}</div><div class="stat-label">Peak HRV</div></div>
    <div class="stat-card"><div class="stat-value" style="color:var(--red)">${Math.min(...hrvs)}</div><div class="stat-label">Low HRV</div></div>
    <div class="stat-card"><div class="stat-value">${trend}</div><div class="stat-label">Trend</div></div>
    <div class="stat-card"><div class="stat-value">${entries.length}</div><div class="stat-label">Entries</div></div>
    <div class="stat-card"><div class="stat-value" style="color:var(--accent)">${avg(entries.map(e => e.energy))}</div><div class="stat-label">Avg Energy</div></div>`;
}

function renderChart(entries) {
  const ctx = document.getElementById('hrv-chart').getContext('2d');
  if (chart) { chart.destroy(); chart = null; }
  if (!entries.length) return;

  const labels  = entries.map(en => new Date(en.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
  const hrvData = entries.map(e => e.hrv);

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

// ── Init ──────────────────────────────────────────────────────────────────────

updateStravaUI();
