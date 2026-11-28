/* global Chart, SpeedPLDiagnostics */
const D = window.SpeedPLDiagnostics;
const LOCAL_HISTORY_KEY = 'speedpl_history_v1';

let allItems = [];
let dbActive = false;
let historyChart = null;

function fmt(v) {
  return D.formatMetric(v);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function readLocalHistory() {
  try {
    const raw = localStorage.getItem(LOCAL_HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function normalizeRow(row, defaultSource) {
  const dl = row.download_mbps != null ? Number(row.download_mbps) : NaN;
  const ul = row.upload_mbps != null ? Number(row.upload_mbps) : NaN;
  const ping = row.ping_ms != null ? Number(row.ping_ms) : NaN;
  const jitter = row.jitter_ms != null ? Number(row.jitter_ms) : NaN;
  const loaded = row.loaded_latency_ms != null ? Number(row.loaded_latency_ms) : NaN;
  const bloat = D.computeBufferbloatGrade(ping, loaded);

  return {
    id: row.id || row.created_at,
    createdAt: row.created_at,
    serverLabel: row.serverName || row.server_id || 'current',
    download: Number.isFinite(dl) ? dl : null,
    upload: Number.isFinite(ul) ? ul : null,
    ping: Number.isFinite(ping) ? ping : null,
    jitter: Number.isFinite(jitter) ? jitter : null,
    loadedLatency: Number.isFinite(loaded) ? loaded : null,
    grade: row.bufferbloatGrade || bloat.grade,
    gradeStatus: bloat.status,
    source: row.source || defaultSource
  };
}

function mergeHistory(dbItems, localItems) {
  const combined = [
    ...dbItems.map((r) => normalizeRow(r, 'Baza danych')),
    ...localItems.map((r) => normalizeRow(r, 'Lokalnie'))
  ];

  // Deduplicate entries captured within 3 seconds with matching speeds
  const deduped = [];
  for (const item of combined) {
    const ts = new Date(item.createdAt).getTime();
    const dup = deduped.some((existing) => {
      const ets = new Date(existing.createdAt).getTime();
      return Math.abs(ets - ts) < 4000 &&
        existing.serverLabel === item.serverLabel &&
        fmt(existing.download) === fmt(item.download);
    });
    if (!dup) deduped.push(item);
  }

  deduped.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return deduped;
}

function updateSummaryKPIs(items) {
  const countEl = document.getElementById('kpiCount');
  const avgDlEl = document.getElementById('kpiAvgDownload');
  const maxDlEl = document.getElementById('kpiMaxDownload');
  const avgUlEl = document.getElementById('kpiAvgUpload');
  const maxUlEl = document.getElementById('kpiMaxUpload');
  const minPingEl = document.getElementById('kpiMinPing');
  const avgPingEl = document.getElementById('kpiAvgPing');

  countEl.textContent = String(items.length);

  const dls = items.map((x) => x.download).filter((x) => Number.isFinite(x) && x > 0);
  const uls = items.map((x) => x.upload).filter((x) => Number.isFinite(x) && x > 0);
  const pings = items.map((x) => x.ping).filter((x) => Number.isFinite(x) && x >= 0);

  if (dls.length) {
    avgDlEl.textContent = fmt(dls.reduce((a, b) => a + b, 0) / dls.length);
    maxDlEl.textContent = `Maks: ${fmt(Math.max(...dls))} Mb/s`;
  } else {
    avgDlEl.textContent = '--';
    maxDlEl.textContent = 'Maks: --';
  }

  if (uls.length) {
    avgUlEl.textContent = fmt(uls.reduce((a, b) => a + b, 0) / uls.length);
    maxUlEl.textContent = `Maks: ${fmt(Math.max(...uls))} Mb/s`;
  } else {
    avgUlEl.textContent = '--';
    maxUlEl.textContent = 'Maks: --';
  }

  if (pings.length) {
    minPingEl.textContent = fmt(Math.min(...pings));
    avgPingEl.textContent = `Średnio: ${fmt(pings.reduce((a, b) => a + b, 0) / pings.length)} ms`;
  } else {
    minPingEl.textContent = '--';
    avgPingEl.textContent = 'Średnio: --';
  }
}

function renderTrendChart(items) {
  const panel = document.getElementById('trendPanel');
  const canvas = document.getElementById('historyChart');
  if (!panel || !canvas || typeof Chart === 'undefined') return;

  const chartItems = items.slice(0, 20).reverse();
  if (chartItems.length < 2) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  const labels = chartItems.map((r) => {
    const d = new Date(r.createdAt);
    return d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
  });
  const dlData = chartItems.map((r) => r.download ?? 0);
  const ulData = chartItems.map((r) => r.upload ?? 0);

  if (!historyChart) {
    historyChart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Pobieranie (Mb/s)',
            data: dlData,
            borderColor: '#3b82f6',
            backgroundColor: 'rgba(59, 130, 246, 0.1)',
            borderWidth: 2,
            tension: 0.25,
            fill: true
          },
          {
            label: 'Wysyłanie (Mb/s)',
            data: ulData,
            borderColor: '#10b981',
            backgroundColor: 'rgba(16, 185, 129, 0.08)',
            borderWidth: 2,
            tension: 0.25,
            fill: true
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        scales: {
          x: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(36, 48, 71, 0.5)' } },
          y: { beginAtZero: true, title: { display: true, text: 'Mb/s', color: '#94a3b8' }, ticks: { color: '#94a3b8' }, grid: { color: 'rgba(36, 48, 71, 0.5)' } }
        },
        plugins: { legend: { labels: { color: '#f1f5f9', boxWidth: 12 } } }
      }
    });
  } else {
    historyChart.data.labels = labels;
    historyChart.data.datasets[0].data = dlData;
    historyChart.data.datasets[1].data = ulData;
    historyChart.update();
  }
}

function renderTable(items) {
  const box = document.getElementById('historyBox');
  const exportCsvBtn = document.getElementById('exportCsvBtn');
  const exportJsonBtn = document.getElementById('exportJsonBtn');
  const clearBtn = document.getElementById('clearHistoryBtn');

  exportCsvBtn.disabled = items.length === 0;
  exportJsonBtn.disabled = items.length === 0;
  clearBtn.disabled = allItems.length === 0;

  if (!allItems.length) {
    box.innerHTML = `
      <div class="history-empty">
        <p>Nie zapisano jeszcze żadnych pomiarów. Uruchom test prędkości, aby zobaczyć tutaj statystyki i trendy.</p>
        <a href="/" class="btn primary btn-sm">Uruchom pierwszy test</a>
      </div>
    `;
    return;
  }

  if (!items.length) {
    box.innerHTML = '<div class="history-empty"><p>Brak pomiarów pasujących do filtra.</p></div>';
    return;
  }

  const rows = items.map((r) => {
    const gradeClass = r.gradeStatus === 'good' || r.gradeStatus === 'warn' || r.gradeStatus === 'bad'
      ? r.gradeStatus
      : '';
    return `<tr>
      <td class="mono">${escapeHtml(new Date(r.createdAt).toLocaleString('pl-PL'))}</td>
      <td>${escapeHtml(r.serverLabel)}</td>
      <td class="num mono">${fmt(r.download)}</td>
      <td class="num mono">${fmt(r.upload)}</td>
      <td class="num mono">${fmt(r.ping)}</td>
      <td class="num mono">${fmt(r.jitter)}</td>
      <td class="num mono">${fmt(r.loadedLatency)}</td>
      <td class="num mono ${gradeClass}">${escapeHtml(r.grade)}</td>
      <td>${escapeHtml(r.source)}</td>
    </tr>`;
  }).join('');

  box.innerHTML = `
    <table class="history-table">
      <thead>
        <tr>
          <th>Data</th>
          <th>Serwer</th>
          <th class="num">Pobieranie (Mb/s)</th>
          <th class="num">Wysyłanie (Mb/s)</th>
          <th class="num">Ping (ms)</th>
          <th class="num">Jitter (ms)</th>
          <th class="num">Obciążony (ms)</th>
          <th class="num">Klasa</th>
          <th>Źródło</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function getFilteredItems() {
  const query = (document.getElementById('historySearch')?.value || '').trim().toLowerCase();
  if (!query) return allItems;
  return allItems.filter((item) =>
    item.serverLabel.toLowerCase().includes(query) ||
    String(item.grade).toLowerCase().includes(query) ||
    item.source.toLowerCase().includes(query)
  );
}

function triggerDownload(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportCsv() {
  const items = getFilteredItems();
  if (!items.length) return;
  const header = ['created_at', 'server', 'download_mbps', 'upload_mbps', 'ping_ms', 'jitter_ms', 'loaded_latency_ms', 'bufferbloat_grade', 'source'];
  const lines = [
    header.join(','),
    ...items.map((r) => [
      JSON.stringify(r.createdAt),
      JSON.stringify(r.serverLabel),
      r.download ?? '',
      r.upload ?? '',
      r.ping ?? '',
      r.jitter ?? '',
      r.loadedLatency ?? '',
      JSON.stringify(r.grade),
      JSON.stringify(r.source)
    ].join(','))
  ];
  triggerDownload(`speedpl-historia-${new Date().toISOString().slice(0, 10)}.csv`, lines.join('\n'), 'text/csv;charset=utf-8');
}

function exportJson() {
  const items = getFilteredItems();
  if (!items.length) return;
  triggerDownload(`speedpl-historia-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(items, null, 2), 'application/json');
}

async function loadHistory() {
  const box = document.getElementById('historyBox');
  const meta = document.getElementById('historySourceMeta');
  if (!box) return;

  let dbItems = [];
  dbActive = false;

  try {
    const res = await fetch('/api/history');
    if (res.ok) {
      const data = await res.json();
      dbActive = !!data.enabled;
      if (Array.isArray(data.items)) dbItems = data.items;
    }
  } catch (e) {}

  const localItems = readLocalHistory();
  allItems = mergeHistory(dbItems, localItems);

  if (meta) {
    meta.innerHTML = dbActive
      ? '<span>Źródło: Baza danych oraz pamięć lokalna przeglądarki</span><span aria-hidden="true">·</span><span>Maks. 100 sesji lokalnych</span>'
      : '<span>Źródło: Pamięć lokalna przeglądarki (bez wymaganej bazy danych)</span><span aria-hidden="true">·</span><span>Opcjonalnie ustaw DATABASE_URL</span>';
  }

  const filtered = getFilteredItems();
  updateSummaryKPIs(filtered);
  renderTrendChart(filtered);
  renderTable(filtered);
}

async function clearAllHistory() {
  try {
    localStorage.removeItem(LOCAL_HISTORY_KEY);
  } catch (e) {}
  if (dbActive) {
    try {
      await fetch('/api/history', { method: 'DELETE' });
    } catch (e) {}
  }
  document.getElementById('clearConfirmBar').hidden = true;
  await loadHistory();
}

document.addEventListener('DOMContentLoaded', () => {
  loadHistory();

  document.getElementById('refreshHistoryBtn')?.addEventListener('click', loadHistory);
  document.getElementById('exportCsvBtn')?.addEventListener('click', exportCsv);
  document.getElementById('exportJsonBtn')?.addEventListener('click', exportJson);

  document.getElementById('historySearch')?.addEventListener('input', () => {
    const filtered = getFilteredItems();
    updateSummaryKPIs(filtered);
    renderTrendChart(filtered);
    renderTable(filtered);
  });

  document.getElementById('clearHistoryBtn')?.addEventListener('click', () => {
    document.getElementById('clearConfirmBar').hidden = false;
  });

  document.getElementById('cancelClearBtn')?.addEventListener('click', () => {
    document.getElementById('clearConfirmBar').hidden = true;
  });

  document.getElementById('confirmClearBtn')?.addEventListener('click', clearAllHistory);
});
