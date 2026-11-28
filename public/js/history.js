/* global Chart, SpeedPLDiagnostics, SpeedPLI18n */
const D = window.SpeedPLDiagnostics;
const I18n = window.SpeedPLI18n;
const LOCAL_HISTORY_KEY = 'speedpl_history_v1';
const LANG_STORAGE_KEY = 'speedpl_lang';

function resolveInitialLang() {
  try {
    const params = new URLSearchParams(window.location.search);
    const qLang = params.get('lang');
    if (qLang && I18n.SUPPORTED_LANGS.includes(String(qLang).toLowerCase().slice(0, 2))) {
      const normalized = I18n.normalizeLang(qLang);
      localStorage.setItem(LANG_STORAGE_KEY, normalized);
      return normalized;
    }
    const saved = localStorage.getItem(LANG_STORAGE_KEY);
    if (saved) return I18n.normalizeLang(saved);
  } catch (e) {}
  return 'pl';
}

let currentLang = resolveInitialLang();
let allItems = [];
let dbActive = false;
let historyLoaded = false;
let historyChart = null;

function t(key, vars) {
  return I18n.t(currentLang, key, vars);
}

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

function normalizeRow(row, sourceType) {
  const dl = row.download_mbps != null ? Number(row.download_mbps) : NaN;
  const ul = row.upload_mbps != null ? Number(row.upload_mbps) : NaN;
  const ping = row.ping_ms != null ? Number(row.ping_ms) : NaN;
  const jitter = row.jitter_ms != null ? Number(row.jitter_ms) : NaN;
  const loaded = row.loaded_latency_ms != null ? Number(row.loaded_latency_ms) : NaN;
  const bloat = D.computeBufferbloatGrade(ping, loaded, currentLang);
  const resolvedSourceType = row.sourceType || (row.source === 'Baza danych' ? 'db' : sourceType);

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
    sourceType: resolvedSourceType
  };
}

function sourceLabel(item) {
  return item.sourceType === 'db' ? t('historySourceBadgeDb') : t('historySourceBadgeLocal');
}

function mergeHistory(dbItems, localItems) {
  const combined = [
    ...dbItems.map((r) => normalizeRow(r, 'db')),
    ...localItems.map((r) => normalizeRow(r, 'local'))
  ];

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
    maxDlEl.textContent = t('historyMax', { val: `${fmt(Math.max(...dls))} ${t('unitMbps')}` });
  } else {
    avgDlEl.textContent = '--';
    maxDlEl.textContent = t('historyMax', { val: '--' });
  }

  if (uls.length) {
    avgUlEl.textContent = fmt(uls.reduce((a, b) => a + b, 0) / uls.length);
    maxUlEl.textContent = t('historyMax', { val: `${fmt(Math.max(...uls))} ${t('unitMbps')}` });
  } else {
    avgUlEl.textContent = '--';
    maxUlEl.textContent = t('historyMax', { val: '--' });
  }

  if (pings.length) {
    minPingEl.textContent = fmt(Math.min(...pings));
    avgPingEl.textContent = t('historyAvgPing', { val: `${fmt(pings.reduce((a, b) => a + b, 0) / pings.length)} ${t('unitMs')}` });
  } else {
    minPingEl.textContent = '--';
    avgPingEl.textContent = t('historyAvgPing', { val: '--' });
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

  const locale = t('locale');
  const labels = chartItems.map((r) => {
    const d = new Date(r.createdAt);
    return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
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
            label: t('chartDlLabel'),
            data: dlData,
            borderColor: '#3b82f6',
            backgroundColor: 'rgba(59, 130, 246, 0.1)',
            borderWidth: 2,
            tension: 0.25,
            fill: true
          },
          {
            label: t('chartUlLabel'),
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
          y: { beginAtZero: true, title: { display: true, text: t('unitMbps'), color: '#94a3b8' }, ticks: { color: '#94a3b8' }, grid: { color: 'rgba(36, 48, 71, 0.5)' } }
        },
        plugins: { legend: { labels: { color: '#f1f5f9', boxWidth: 12 } } }
      }
    });
  } else {
    historyChart.data.labels = labels;
    historyChart.data.datasets[0].label = t('chartDlLabel');
    historyChart.data.datasets[0].data = dlData;
    historyChart.data.datasets[1].label = t('chartUlLabel');
    historyChart.data.datasets[1].data = ulData;
    historyChart.options.scales.y.title.text = t('unitMbps');
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

  if (!historyLoaded) {
    box.textContent = t('historyLoading');
    return;
  }

  if (!allItems.length) {
    box.innerHTML = `
      <div class="history-empty">
        <p>${escapeHtml(t('historyEmpty'))}</p>
        <a href="/" class="btn primary btn-sm">${escapeHtml(t('historyFirstTestBtn'))}</a>
      </div>
    `;
    return;
  }

  if (!items.length) {
    box.innerHTML = `<div class="history-empty"><p>${escapeHtml(t('historyFilteredEmpty'))}</p></div>`;
    return;
  }

  const locale = t('locale');
  const rows = items.map((r) => {
    const gradeClass = r.gradeStatus === 'good' || r.gradeStatus === 'warn' || r.gradeStatus === 'bad'
      ? r.gradeStatus
      : '';
    return `<tr>
      <td class="mono">${escapeHtml(new Date(r.createdAt).toLocaleString(locale))}</td>
      <td>${escapeHtml(r.serverLabel)}</td>
      <td class="num mono">${fmt(r.download)}</td>
      <td class="num mono">${fmt(r.upload)}</td>
      <td class="num mono">${fmt(r.ping)}</td>
      <td class="num mono">${fmt(r.jitter)}</td>
      <td class="num mono">${fmt(r.loadedLatency)}</td>
      <td class="num mono ${gradeClass}">${escapeHtml(r.grade)}</td>
      <td>${escapeHtml(sourceLabel(r))}</td>
    </tr>`;
  }).join('');

  box.innerHTML = `
    <table class="history-table">
      <thead>
        <tr>
          <th>${escapeHtml(t('historyColDate'))}</th>
          <th>${escapeHtml(t('historyColServer'))}</th>
          <th class="num">${escapeHtml(t('historyColDl'))}</th>
          <th class="num">${escapeHtml(t('historyColUl'))}</th>
          <th class="num">${escapeHtml(t('historyColPing'))}</th>
          <th class="num">${escapeHtml(t('historyColJitter'))}</th>
          <th class="num">${escapeHtml(t('historyColLoaded'))}</th>
          <th class="num">${escapeHtml(t('historyColGrade'))}</th>
          <th>${escapeHtml(t('historyColSource'))}</th>
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
    sourceLabel(item).toLowerCase().includes(query)
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
      JSON.stringify(sourceLabel(r))
    ].join(','))
  ];
  triggerDownload(`speedpl-history-${new Date().toISOString().slice(0, 10)}.csv`, lines.join('\n'), 'text/csv;charset=utf-8');
}

function exportJson() {
  const items = getFilteredItems();
  if (!items.length) return;
  const payload = items.map((r) => ({ ...r, source: sourceLabel(r) }));
  triggerDownload(`speedpl-history-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2), 'application/json');
}

function renderSourceMeta() {
  const meta = document.getElementById('historySourceMeta');
  if (!meta) return;
  if (!historyLoaded) {
    meta.innerHTML = `<span>${escapeHtml(t('historyLoading'))}</span>`;
    return;
  }
  meta.innerHTML = dbActive
    ? `<span>${escapeHtml(t('historySourceDb'))}</span><span aria-hidden="true">·</span><span>${escapeHtml(t('historySourceDbCap'))}</span>`
    : `<span>${escapeHtml(t('historySourceLocal'))}</span><span aria-hidden="true">·</span><span>${escapeHtml(t('historySourceLocalHint'))}</span>`;
}

function renderAllViews() {
  renderSourceMeta();
  const filtered = getFilteredItems();
  updateSummaryKPIs(filtered);
  renderTrendChart(filtered);
  renderTable(filtered);
}

async function loadHistory() {
  const box = document.getElementById('historyBox');
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
  historyLoaded = true;
  renderAllViews();
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

function applyLanguage(lang) {
  currentLang = I18n.normalizeLang(lang);
  try {
    localStorage.setItem(LANG_STORAGE_KEY, currentLang);
  } catch (e) {}

  document.documentElement.lang = currentLang;
  document.title = t('pageTitleHistory');

  const langSel = document.getElementById('langSelect');
  if (langSel) langSel.value = currentLang;

  document.querySelectorAll('[data-i18n]').forEach((node) => {
    if (node.id === 'historyBox' && historyLoaded) return;
    node.textContent = t(node.dataset.i18n);
  });

  document.querySelectorAll('[data-i18n-placeholder]').forEach((node) => {
    node.setAttribute('placeholder', t(node.dataset.i18nPlaceholder));
  });

  renderAllViews();
}

document.addEventListener('DOMContentLoaded', () => {
  applyLanguage(currentLang);
  loadHistory();

  document.getElementById('langSelect')?.addEventListener('change', (e) => applyLanguage(e.target.value));
  document.getElementById('refreshHistoryBtn')?.addEventListener('click', loadHistory);
  document.getElementById('exportCsvBtn')?.addEventListener('click', exportCsv);
  document.getElementById('exportJsonBtn')?.addEventListener('click', exportJson);

  document.getElementById('historySearch')?.addEventListener('input', () => {
    renderAllViews();
  });

  document.getElementById('clearHistoryBtn')?.addEventListener('click', () => {
    document.getElementById('clearConfirmBar').hidden = false;
  });

  document.getElementById('cancelClearBtn')?.addEventListener('click', () => {
    document.getElementById('clearConfirmBar').hidden = true;
  });

  document.getElementById('confirmClearBtn')?.addEventListener('click', clearAllHistory);
});
