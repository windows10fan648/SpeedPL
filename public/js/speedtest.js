const state = {
  running: false,
  stopped: false,
  serverId: 'current',
  downloadMbps: 0,
  uploadMbps: 0,
  ping: 0,
  jitter: 0,
  loadedLatency: 0,
  downloadBytes: 0,
  uploadBytes: 0,
  samples: [],
  chart: null
};

const el = (id) => document.getElementById(id);
const statusText = el('statusText');

function setMetric(id, value) {
  const node = el(id);
  if (value == null || !Number.isFinite(value)) node.textContent = '--';
  else node.textContent = value.toFixed(value >= 100 ? 0 : 2);
}

function serverBase() {
  const select = el('serverSelect');
  const option = select.options[select.selectedIndex];
  // base URL resolved by server list endpoint; cache in data attribute
  return option?.dataset?.url || '';
}

async function loadServers() {
  try {
    const res = await fetch('/api/servers');
    const data = await res.json();
    const select = el('serverSelect');
    select.innerHTML = '';
    for (const s of data.servers) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.configured ? s.name : s.name + ' (wymaga konfiguracji)';
      opt.disabled = !s.configured;
      opt.dataset.url = s.url || '';
      select.appendChild(opt);
    }
    const current = data.servers.find((s) => s.id === 'current');
    if (current) select.value = 'current';
  } catch (e) {
    statusText.textContent = 'Nie udalo sie pobrac listy serwerow.';
  }
}

function apiUrl(path) {
  const base = serverBase().replace(/\/+$/, '');
  return base ? base + path : path;
}

function endpoint(path) {
  return apiUrl(path);
}

function now() { return performance.now(); }

async function measurePing(count = 20) {
  const rtts = [];
  for (let i = 0; i < count && !state.stopped; i++) {
    const start = now();
    try {
      await fetch(endpoint('/api/ping') + '?r=' + Math.random(), { cache: 'no-store' });
      rtts.push(now() - start);
    } catch (e) {
      // skip failed probe
    }
  }
  if (!rtts.length) return { ping: NaN, jitter: NaN, samples: [] };
  const sorted = [...rtts].sort((a,b) => a-b);
  const ping = sorted[Math.floor(sorted.length / 2)];
  const deltas = [];
  for (let i = 1; i < rtts.length; i++) deltas.push(Math.abs(rtts[i] - rtts[i-1]));
  const jitter = deltas.length ? deltas.reduce((a,b)=>a+b,0)/deltas.length : 0;
  return { ping, jitter, samples: rtts };
}

async function measureDownload(size) {
  const loadedRtts = [];
  let loadedActive = true;
  const loadedLoop = (async () => {
    while (loadedActive && !state.stopped) {
      const start = now();
      try {
        await fetch(endpoint('/api/ping') + '?r=' + Math.random(), { cache: 'no-store' });
        loadedRtts.push(now() - start);
      } catch (e) {}
      await new Promise((r) => setTimeout(r, 500));
    }
  })();

  const start = now();
  let received = 0;
  let lastSampleTime = start;
  let lastSampleBytes = 0;
  state.samples = [];

  const response = await fetch(endpoint('/api/download') + '?bytes=' + size + '&r=' + Math.random(), { cache: 'no-store' });
  if (!response.ok || !response.body) throw new Error('Download failed');

  const reader = response.body.getReader();
  while (!state.stopped) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    const t = now();
    if (t - lastSampleTime >= 250) {
      const dt = (t - lastSampleTime) / 1000;
      const db = received - lastSampleBytes;
      const mbps = dt > 0 ? (db * 8) / (dt * 1e6) : 0;
      state.samples.push({ t: (t - start) / 1000, mbps });
      lastSampleTime = t;
      lastSampleBytes = received;
      updateChart();
    }
  }
  const elapsed = (now() - start) / 1000;
  loadedActive = false;
  await loadedLoop.catch(() => {});
  const mbps = elapsed > 0 ? (received * 8) / (elapsed * 1e6) : 0;
  const loadedLatency = loadedRtts.length ? loadedRtts.reduce((a,b)=>a+b,0)/loadedRtts.length : NaN;
  return { mbps, bytes: received, loadedLatency };
}

function randomBytes(size) {
  const out = new Uint8Array(size);
  const chunk = 65536;
  for (let i = 0; i < size; i += chunk) {
    crypto.getRandomValues(out.subarray(i, Math.min(i + chunk, size)));
  }
  return out;
}

async function measureUpload(size) {
  const loadedRtts = [];
  let loadedActive = true;
  const loadedLoop = (async () => {
    while (loadedActive && !state.stopped) {
      const start = now();
      try {
        await fetch(endpoint('/api/ping') + '?r=' + Math.random(), { cache: 'no-store' });
        loadedRtts.push(now() - start);
      } catch (e) {}
      await new Promise((r) => setTimeout(r, 500));
    }
  })();

  const payload = randomBytes(size);
  const blob = new Blob([payload]);
  const start = now();
  const response = await fetch(endpoint('/api/upload') + '?r=' + Math.random(), {
    method: 'POST',
    body: blob,
    headers: { 'Content-Type': 'application/octet-stream' }
  });
  const elapsed = (now() - start) / 1000;
  loadedActive = false;
  await loadedLoop.catch(() => {});
  if (!response.ok) throw new Error('Upload failed');
  const data = await response.json();
  const bytes = data.received || size;
  const mbps = elapsed > 0 ? (bytes * 8) / (elapsed * 1e6) : 0;
  const loadedLatency = loadedRtts.length ? loadedRtts.reduce((a,b)=>a+b,0)/loadedRtts.length : NaN;
  return { mbps, bytes, loadedLatency };
}

function initChart() {
  const ctx = el('speedChart').getContext('2d');
  state.chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label: 'Pobieranie (Mb/s)', data: [], borderColor: '#4f8cff', tension: 0.25, fill: false },
        { label: 'Wysylanie (Mb/s)', data: [], borderColor: '#22c55e', tension: 0.25, fill: false }
      ]
    },
    options: {
      responsive: true,
      animation: false,
      scales: {
        x: { title: { display: true, text: 'Czas (s)', color: '#9aa4c7' }, ticks: { color: '#9aa4c7' } },
        y: { beginAtZero: true, title: { display: true, text: 'Mb/s', color: '#9aa4c7' }, ticks: { color: '#9aa4c7' } }
      },
      plugins: { legend: { labels: { color: '#e8ecf8' } } }
    }
  });
}

function updateChart() {
  if (!state.chart) return;
  const labels = state.samples.map((s) => s.t.toFixed(1));
  const data = state.samples.map((s) => s.mbps);
  state.chart.data.labels = labels;
  state.chart.data.datasets[0].data = data;
  state.chart.update();
}

function resetChart() {
  if (!state.chart) return;
  state.chart.data.labels = [];
  state.chart.data.datasets[0].data = [];
  state.chart.data.datasets[1].data = [];
  state.chart.update();
}

async function runTest() {
  if (state.running) return;
  state.running = true;
  state.stopped = false;
  state.serverId = el('serverSelect').value;
  resetChart();
  el('startBtn').disabled = true;
  el('stopBtn').disabled = false;
  el('analyzeBtn').disabled = true;

  try {
    statusText.textContent = 'Mierzenie pingu i jittera...';
    const pingResult = await measurePing(20);
    state.ping = pingResult.ping;
    state.jitter = pingResult.jitter;
    setMetric('pingValue', state.ping);
    setMetric('jitterValue', state.jitter);

    statusText.textContent = 'Test pobierania...';
    const dlSize = Number(el('sizeSelect').value);
    const dl = await measureDownload(dlSize);
    state.downloadMbps = dl.mbps;
    state.downloadBytes = dl.bytes;
    state.loadedLatency = dl.loadedLatency;
    setMetric('downloadValue', state.downloadMbps);
    setMetric('loadedValue', state.loadedLatency);

    statusText.textContent = 'Test wysylania...';
    const ulSize = Number(el('uploadSizeSelect').value);
    const ul = await measureUpload(ulSize);
    state.uploadMbps = ul.mbps;
    state.uploadBytes = ul.bytes;
    const loaded = Number.isFinite(ul.loadedLatency) ? ul.loadedLatency : state.loadedLatency;
    state.loadedLatency = Number.isFinite(loaded) ? (Number.isFinite(state.loadedLatency) ? (state.loadedLatency + loaded) / 2 : loaded) : state.loadedLatency;
    setMetric('uploadValue', state.uploadMbps);
    setMetric('loadedValue', state.loadedLatency);

    // upload chart sample (single point)
    state.chart.data.datasets[1].data = [state.uploadMbps];
    state.chart.data.labels = state.chart.data.labels.length ? state.chart.data.labels : ['upload'];
    state.chart.update();

    statusText.textContent = 'Test zakonczony.';
    el('analyzeBtn').disabled = false;

    if (el('saveHistory').checked) {
      await saveHistory();
    }
  } catch (e) {
    statusText.textContent = 'Blad testu: ' + (e.message || e);
  } finally {
    state.running = false;
    el('startBtn').disabled = false;
    el('stopBtn').disabled = true;
  }
}

async function saveHistory() {
  try {
    await fetch('/api/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serverId: state.serverId,
        download: state.downloadMbps,
        upload: state.uploadMbps,
        ping: state.ping,
        jitter: state.jitter,
        loadedLatency: state.loadedLatency,
        downloadBytes: state.downloadBytes,
        uploadBytes: state.uploadBytes
      })
    });
  } catch (e) {}
}

async function loadHistory() {
  const box = el('historyBox');
  try {
    const res = await fetch('/api/history');
    const data = await res.json();
    if (!data.enabled) {
      box.textContent = 'Historia wylaczona (brak DATABASE_URL).';
      return;
    }
    if (!data.items.length) {
      box.textContent = 'Brak zapisanych testow.';
      return;
    }
    const rows = data.items.map((r) => {
      return `<tr>
        <td>${new Date(r.created_at).toLocaleString('pl-PL')}</td>
        <td>${r.server_id}</td>
        <td>${fmt(r.download_mbps)}</td>
        <td>${fmt(r.upload_mbps)}</td>
        <td>${fmt(r.ping_ms)}</td>
        <td>${fmt(r.jitter_ms)}</td>
        <td>${fmt(r.loaded_latency_ms)}</td>
      </tr>`;
    }).join('');
    box.innerHTML = `<table><thead><tr>
      <th>Data</th><th>Serwer</th><th>Down</th><th>Up</th><th>Ping</th><th>Jitter</th><th>Loaded</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
  } catch (e) {
    box.textContent = 'Blad ladowania historii.';
  }
}

function fmt(v) {
  if (v == null || !Number.isFinite(Number(v))) return '--';
  const n = Number(v);
  return n.toFixed(n >= 100 ? 0 : 2);
}

async function analyze() {
  const btn = el('analyzeBtn');
  btn.disabled = true;
  el('analysisText').textContent = 'Analizowanie...';
  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        download: state.downloadMbps,
        upload: state.uploadMbps,
        ping: state.ping,
        jitter: state.jitter,
        loadedLatency: state.loadedLatency
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Blad');
    el('analysisText').innerHTML = renderMarkdown(data.analysis || '');
  } catch (e) {
    el('analysisText').innerHTML = renderMarkdown('Blad: ' + (e.message || e));
  } finally {
    btn.disabled = false;
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inlineMarkdown(value) {
  let text = escapeHtml(value);
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return text;
}

function renderMarkdown(markdown) {
  const lines = String(markdown || '').split(/\\r?\\n/);
  const html = [];
  let inList = false;
  let inCode = false;
  const codeLines = [];

  function closeList() {
    if (inList) {
      html.push('</ul>');
      inList = false;
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.startsWith('```')) {
      if (inCode) {
        html.push('<pre><code>' + escapeHtml(codeLines.join('\\n')) + '</code></pre>');
        codeLines.length = 0;
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(rawLine);
      continue;
    }
    if (!line.trim()) {
      closeList();
      continue;
    }
    const heading = line.match(/^(#{1,3})\\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      html.push('<h' + (level + 2) + '>' + inlineMarkdown(heading[2]) + '</h' + (level + 2) + '>');
      continue;
    }
    const listMatch = line.match(/^[-*+]\\s+(.*)$/);
    if (listMatch) {
      if (!inList) {
        html.push('<ul>');
        inList = true;
      }
      html.push('<li>' + inlineMarkdown(listMatch[1]) + '</li>');
      continue;
    }
    closeList();
    html.push('<p>' + inlineMarkdown(line) + '</p>');
  }

  if (inCode) {
    html.push('<pre><code>' + escapeHtml(codeLines.join('\\n')) + '</code></pre>');
  }
  closeList();
  return html.join('');
}

document.addEventListener('DOMContentLoaded', () => {
  initChart();
  loadServers();
  loadHistory();
  el('startBtn').addEventListener('click', runTest);
  el('stopBtn').addEventListener('click', () => { state.stopped = true; });
  el('analyzeBtn').addEventListener('click', analyze);
  el('refreshHistoryBtn').addEventListener('click', loadHistory);
});