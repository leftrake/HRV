'use strict';

const STORAGE_KEY = 'hrv_entries';

// ── Storage ──────────────────────────────────────────────────────────────────

function loadEntries() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveEntries(entries) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

// ── HRV classification ────────────────────────────────────────────────────────

function hrvClass(hrv) {
  if (hrv >= 70) return { label: 'Great',  cls: 'badge-great',  color: '#34d399' };
  if (hrv >= 50) return { label: 'Good',   cls: 'badge-good',   color: '#5b8dee' };
  if (hrv >= 35) return { label: 'OK',     cls: 'badge-ok',     color: '#fbbf24' };
  return           { label: 'Low',    cls: 'badge-low',    color: '#f87171' };
}

// ── Tab navigation ────────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'history') renderHistory();
    if (btn.dataset.tab === 'trends')  renderTrends();
  });
});

// ── Log form ──────────────────────────────────────────────────────────────────

const form        = document.getElementById('entry-form');
const dateInput   = document.getElementById('entry-date');
const hrvInput    = document.getElementById('hrv');
const msgEl       = document.getElementById('form-message');
const indicator   = document.getElementById('hrv-indicator');

// Default date to today
dateInput.value = new Date().toISOString().slice(0, 10);

// Sliders
['energy', 'stress', 'sleep', 'mood'].forEach(id => {
  const slider = document.getElementById(id);
  const display = document.getElementById(`${id}-val`);
  slider.addEventListener('input', () => { display.textContent = slider.value; });
});

// HRV live indicator
hrvInput.addEventListener('input', updateHrvIndicator);
function updateHrvIndicator() {
  const val = parseInt(hrvInput.value, 10);
  if (!val || val < 1) { indicator.style.background = 'var(--border)'; return; }
  indicator.style.background = hrvClass(val).color;
}

// Save
form.addEventListener('submit', e => {
  e.preventDefault();

  const date = dateInput.value;
  const hrv  = parseInt(hrvInput.value, 10);

  if (!date || !hrv) {
    showMsg('Please fill in date and HRV.', 'error');
    return;
  }

  const activities = [
    ...[...document.querySelectorAll('#activity-tags input:checked')].map(el => el.value),
    ...document.getElementById('custom-activity').value
      .split(',').map(s => s.trim()).filter(Boolean),
  ];

  const entry = {
    id:         Date.now(),
    date,
    hrv,
    energy:     parseInt(document.getElementById('energy').value, 10),
    stress:     parseInt(document.getElementById('stress').value, 10),
    sleep:      parseInt(document.getElementById('sleep').value, 10),
    mood:       parseInt(document.getElementById('mood').value, 10),
    activities,
    notes:      document.getElementById('notes').value.trim(),
  };

  const entries = loadEntries();
  // Replace if same date, otherwise append
  const idx = entries.findIndex(en => en.date === date);
  if (idx >= 0) {
    entries[idx] = entry;
    showMsg('Entry updated!', 'success');
  } else {
    entries.push(entry);
    showMsg('Entry saved!', 'success');
  }
  entries.sort((a, b) => b.date.localeCompare(a.date));
  saveEntries(entries);
  resetForm();
});

document.getElementById('clear-btn').addEventListener('click', resetForm);

function resetForm() {
  form.reset();
  dateInput.value = new Date().toISOString().slice(0, 10);
  ['energy', 'stress', 'sleep', 'mood'].forEach(id => {
    document.getElementById(id).value = 5;
    document.getElementById(`${id}-val`).textContent = '5';
  });
  indicator.style.background = 'var(--border)';
}

function showMsg(text, type) {
  msgEl.textContent = text;
  msgEl.className = `message ${type}`;
  clearTimeout(msgEl._timer);
  msgEl._timer = setTimeout(() => { msgEl.className = 'message hidden'; }, 3000);
}

// ── History ───────────────────────────────────────────────────────────────────

const historyList   = document.getElementById('history-list');
const historySearch = document.getElementById('history-search');

historySearch.addEventListener('input', renderHistory);

document.getElementById('export-btn').addEventListener('click', () => {
  const data = JSON.stringify(loadEntries(), null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href: url, download: 'hrv-entries.json',
  });
  a.click();
  URL.revokeObjectURL(url);
});

function renderHistory() {
  const query   = historySearch.value.toLowerCase();
  const entries = loadEntries().filter(en => {
    if (!query) return true;
    return (
      en.notes?.toLowerCase().includes(query) ||
      en.activities?.some(a => a.toLowerCase().includes(query)) ||
      en.date.includes(query)
    );
  });

  if (!entries.length) {
    historyList.innerHTML = '<div class="empty-state">No entries yet. Start logging!</div>';
    return;
  }

  historyList.innerHTML = entries.map(en => entryCardHTML(en)).join('');

  historyList.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!confirm('Delete this entry?')) return;
      const all = loadEntries().filter(en => en.id !== parseInt(btn.dataset.id, 10));
      saveEntries(all);
      renderHistory();
    });
  });
}

function entryCardHTML(en) {
  const cls   = hrvClass(en.hrv);
  const pills = en.activities?.map(a => `<span class="activity-pill">${a}</span>`).join('') || '';
  const notes = en.notes ? `<div class="entry-notes">"${en.notes}"</div>` : '';
  const date  = new Date(en.date + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  });

  return `
    <div class="entry-card">
      <button class="delete-btn" data-id="${en.id}" title="Delete">✕</button>
      <div class="entry-header">
        <span class="entry-date">${date}</span>
        <span>
          <span class="entry-hrv">${en.hrv}</span>
          <span class="hrv-badge ${cls.cls}">${cls.label}</span>
        </span>
      </div>
      <div class="entry-metrics">
        <div class="metric">Energy <span>${en.energy}/10</span></div>
        <div class="metric">Stress <span>${en.stress}/10</span></div>
        <div class="metric">Sleep <span>${en.sleep}/10</span></div>
        <div class="metric">Mood <span>${en.mood}/10</span></div>
      </div>
      ${pills ? `<div class="entry-activities">${pills}</div>` : ''}
      ${notes}
    </div>`;
}

// ── Trends ────────────────────────────────────────────────────────────────────

const rangeSelect = document.getElementById('range-select');
rangeSelect.addEventListener('change', renderTrends);

let chart = null;

function renderTrends() {
  const days    = parseInt(rangeSelect.value, 10);
  let entries   = loadEntries().slice().sort((a, b) => a.date.localeCompare(b.date));

  if (days > 0) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    entries = entries.filter(en => en.date >= cutoffStr);
  }

  renderStats(entries);
  renderChart(entries);
}

function renderStats(entries) {
  const grid = document.getElementById('stats-grid');
  if (!entries.length) {
    grid.innerHTML = '<div class="empty-state">No data for this range.</div>';
    return;
  }

  const hrvs = entries.map(e => e.hrv);
  const avg  = (arr) => (arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(1);
  const max  = Math.max(...hrvs);
  const min  = Math.min(...hrvs);
  const avgHrv = avg(hrvs);

  const trend = entries.length >= 2
    ? (entries[entries.length - 1].hrv - entries[0].hrv > 0 ? '↑' : '↓')
    : '—';

  grid.innerHTML = `
    <div class="stat-card">
      <div class="stat-value" style="color:var(--accent)">${avgHrv}</div>
      <div class="stat-label">Avg HRV (ms)</div>
    </div>
    <div class="stat-card">
      <div class="stat-value" style="color:var(--green)">${max}</div>
      <div class="stat-label">Peak HRV</div>
    </div>
    <div class="stat-card">
      <div class="stat-value" style="color:var(--red)">${min}</div>
      <div class="stat-label">Low HRV</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${trend}</div>
      <div class="stat-label">Trend</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${entries.length}</div>
      <div class="stat-label">Entries</div>
    </div>
    <div class="stat-card">
      <div class="stat-value" style="color:var(--accent)">${avg(entries.map(e => e.energy))}</div>
      <div class="stat-label">Avg Energy</div>
    </div>
  `;
}

function renderChart(entries) {
  const ctx = document.getElementById('hrv-chart').getContext('2d');

  if (chart) { chart.destroy(); chart = null; }

  if (!entries.length) return;

  const labels = entries.map(en =>
    new Date(en.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  );
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
          pointRadius: 3,
          borderDash: [4, 4],
          tension: 0.35,
          fill: false,
          yAxisID: 'y2',
        },
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
              const idx   = items[0].dataIndex;
              const en    = entries[idx];
              const acts  = en.activities?.join(', ') || '—';
              return [
                `Energy: ${en.energy}/10`,
                `Stress: ${en.stress}/10`,
                `Sleep: ${en.sleep}/10`,
                `Activities: ${acts}`,
              ];
            },
          },
        },
      },
      scales: {
        x: { ticks: { color: '#8891a8' }, grid: { color: '#2e3348' } },
        y: {
          ticks: { color: '#8891a8' },
          grid: { color: '#2e3348' },
          title: { display: true, text: 'HRV (ms)', color: '#8891a8' },
        },
        y2: {
          position: 'right',
          min: 1, max: 10,
          ticks: { color: '#8891a8' },
          grid: { drawOnChartArea: false },
          title: { display: true, text: 'Mood (1–10)', color: '#8891a8' },
        },
      },
    },
  });
}
