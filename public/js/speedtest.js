const state = {
  running: false,
  stopped: false,
  abortController: null,
  activeXhrs: new Set(),
  serverId: 'current',
  serverName: 'Serwer bieżący',
  streams: 4,
  downloadMbps: 0,
  uploadMbps: 0,
  ping: 0,
  pingMin: null,
  pingMax: null,
  pingP95: null,
  packetLoss: 0,
  jitter: 0,
  loadedLatency: 0,
  loadedDownloadLatency: null,
  loadedUploadLatency: null,
  downloadBytes: 0,
  uploadBytes: 0,
  downloadSamples: [],
  uploadSamples: [],
  lastAnalysisMarkdown: '',
  chart: null
};

const el = (id) => document.getElementById(id);
const statusText = el('statusText');

function setMetric(id, value) {
  const node = el(id);
  if (!node) return;
  if (value == null || !Number.isFinite(value)) node.textContent = '--';
  else node.textContent = value.toFixed(value >= 100 ? 0 : 2);
}

function setProgress(pct) {
  const bar = el('progressBar');
  if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
}

function serverBase() {
  const select = el('serverSelect');
  const option = select.options[select.selectedIndex];
  return option?.dataset?.url || '';
}

function selectedServerName() {
  const select = el('serverSelect');
  const option = select.options[select.selectedIndex];
  return option ? option.textContent : 'Serwer bieżący';
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
    statusText.textContent = 'Nie udało się pobrać listy serwerów.';
  }
}

function endpoint(path) {
  const base = serverBase().replace(/\/+$/, '');
  return base ? base + path : path;
}

function now() { return performance.now(); }

function checkAborted() {
  if (state.stopped || state.abortController?.signal?.aborted) {
    const err = new Error('STOPPED');
    err.name = 'AbortError';
    throw err;
  }
}

async function measurePing(count = 20) {
  const signal = state.abortController?.signal;
  // Warm-up probes to establish TCP/TLS keep-alive without skewing idle ping.
  for (let w = 0; w < 2 && !state.stopped; w++) {
    try {
      await fetch(endpoint('/api/ping') + '?w=' + w + '&r=' + Math.random(), { cache: 'no-store', signal });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
    }
  }

  const rtts = [];
  let failures = 0;
  for (let i = 0; i < count && !state.stopped; i++) {
    const start = now();
    try {
      const res = await fetch(endpoint('/api/ping') + '?r=' + Math.random(), { cache: 'no-store', signal });
      if (!res.ok) throw new Error('Ping HTTP ' + res.status);
      rtts.push(now() - start);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      failures++;
    }
    setProgress(5 + ((i + 1) / count) * 10);
  }

  checkAborted();
  const attempted = rtts.length + failures;
  const packetLoss = attempted > 0 ? Math.round((failures / attempted) * 1000) / 10 : 0;
  if (!rtts.length) {
    return { ping: NaN, min: NaN, max: NaN, p95: NaN, jitter: NaN, packetLoss, samples: [] };
  }

  const sorted = [...rtts].sort((a, b) => a - b);
  const ping = sorted[Math.floor(sorted.length / 2)];
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  const deltas = [];
  for (let i = 1; i < rtts.length; i++) deltas.push(Math.abs(rtts[i] - rtts[i - 1]));
  const jitter = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
  return { ping, min, max, p95, jitter, packetLoss, samples: rtts };
}

function startLoadedLatencyLoop(signal) {
  const rtts = [];
  let active = true;
  const promise = (async () => {
    while (active && !state.stopped && !signal?.aborted) {
      const start = now();
      try {
        await fetch(endpoint('/api/ping') + '?load=1&r=' + Math.random(), { cache: 'no-store', signal });
        rtts.push(now() - start);
      } catch (e) {
        if (e.name === 'AbortError') break;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  })();

  return {
    async stop() {
      active = false;
      await promise.catch(() => {});
      if (!rtts.length) return NaN;
      return rtts.reduce((a, b) => a + b, 0) / rtts.length;
    }
  };
}

async function measureDownload(totalSize, streams = 4) {
  const signal = state.abortController?.signal;
  const probeLoop = startLoadedLatencyLoop(signal);

  const perStream = Math.ceil(totalSize / streams);
  const streamBytes = new Array(streams).fill(0);
  state.downloadSamples = [];

  const start = now();
  let lastSampleTime = start;
  let lastSampleBytes = 0;

  const sampler = setInterval(() => {
    if (state.stopped) return;
    const t = now();
    const totalReceived = streamBytes.reduce((a, b) => a + b, 0);
    const dt = (t - lastSampleTime) / 1000;
    const db = totalReceived - lastSampleBytes;
    if (dt > 0) {
      const mbps = (db * 8) / (dt * 1e6);
      state.downloadSamples.push({ t: (t - start) / 1000, mbps });
      setMetric('downloadValue', mbps);
      setProgress(15 + Math.min(1, totalReceived / totalSize) * 40);
      lastSampleTime = t;
      lastSampleBytes = totalReceived;
      updateChart();
    }
  }, 200);

  try {
    await Promise.all(
      Array.from({ length: streams }, async (_, idx) => {
        const response = await fetch(
          endpoint('/api/download') + '?bytes=' + perStream + '&s=' + idx + '&r=' + Math.random(),
          { cache: 'no-store', signal }
        );
        if (!response.ok || !response.body) throw new Error('Download failed');
        const reader = response.body.getReader();
        while (!state.stopped) {
          const { done, value } = await reader.read();
          if (done) break;
          streamBytes[idx] += value.byteLength;
        }
      })
    );
  } finally {
    clearInterval(sampler);
  }

  checkAborted();
  const elapsed = (now() - start) / 1000;
  const totalReceived = streamBytes.reduce((a, b) => a + b, 0);
  const loadedLatency = await probeLoop.stop();
  const mbps = elapsed > 0 ? (totalReceived * 8) / (elapsed * 1e6) : 0;
  if (!state.downloadSamples.length) {
    state.downloadSamples.push({ t: elapsed, mbps });
    updateChart();
  }
  return { mbps, bytes: totalReceived, loadedLatency };
}

function randomBytes(size) {
  const out = new Uint8Array(size);
  const chunk = 65536;
  for (let i = 0; i < size; i += chunk) {
    crypto.getRandomValues(out.subarray(i, Math.min(i + chunk, size)));
  }
  return out;
}

function uploadSingleStream(blob, idx, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    state.activeXhrs.add(xhr);

    xhr.open('POST', endpoint('/api/upload') + '?s=' + idx + '&r=' + Math.random(), true);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded);
    };

    xhr.onload = () => {
      state.activeXhrs.delete(xhr);
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText || '{}');
          resolve(data.received || blob.size);
        } catch (e) {
          resolve(blob.size);
        }
      } else {
        reject(new Error('Upload failed (HTTP ' + xhr.status + ')'));
      }
    };

    xhr.onerror = () => {
      state.activeXhrs.delete(xhr);
      reject(new Error('Upload network error'));
    };

    xhr.onabort = () => {
      state.activeXhrs.delete(xhr);
      const err = new Error('STOPPED');
      err.name = 'AbortError';
      reject(err);
    };

    xhr.send(blob);
  });
}

async function measureUpload(totalSize, streams = 4) {
  const signal = state.abortController?.signal;
  const probeLoop = startLoadedLatencyLoop(signal);

  const perStream = Math.ceil(totalSize / streams);
  const blobs = Array.from({ length: streams }, () => new Blob([randomBytes(perStream)]));
  const streamBytes = new Array(streams).fill(0);
  state.uploadSamples = [];

  const start = now();
  let lastSampleTime = start;
  let lastSampleBytes = 0;

  const sampler = setInterval(() => {
    if (state.stopped) return;
    const t = now();
    const totalSent = streamBytes.reduce((a, b) => a + b, 0);
    const dt = (t - lastSampleTime) / 1000;
    const db = totalSent - lastSampleBytes;
    if (dt > 0) {
      const mbps = (db * 8) / (dt * 1e6);
      state.uploadSamples.push({ t: (t - start) / 1000, mbps });
      setMetric('uploadValue', mbps);
      setProgress(55 + Math.min(1, totalSent / totalSize) * 40);
      lastSampleTime = t;
      lastSampleBytes = totalSent;
      updateChart();
    }
  }, 200);

  let confirmedBytes = 0;
  try {
    const results = await Promise.all(
      blobs.map((blob, idx) =>
        uploadSingleStream(blob, idx, (loaded) => {
          streamBytes[idx] = loaded;
        })
      )
    );
    confirmedBytes = results.reduce((a, b) => a + b, 0);
  } finally {
    clearInterval(sampler);
  }

  checkAborted();
  const elapsed = (now() - start) / 1000;
  const loadedLatency = await probeLoop.stop();
  const mbps = elapsed > 0 ? (confirmedBytes * 8) / (elapsed * 1e6) : 0;
  if (!state.uploadSamples.length) {
    state.uploadSamples.push({ t: elapsed, mbps });
    updateChart();
  }
  return { mbps, bytes: confirmedBytes, loadedLatency };
}

function initChart() {
  const ctx = el('speedChart').getContext('2d');
  state.chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label: 'Pobieranie (Mb/s)', data: [], borderColor: '#4f8cff', tension: 0.25, fill: false, pointRadius: 2 },
        { label: 'Wysyłanie (Mb/s)', data: [], borderColor: '#22c55e', tension: 0.25, fill: false, pointRadius: 2 }
      ]
    },
    options: {
      responsive: true,
      animation: false,
      scales: {
        x: { title: { display: true, text: 'Czas fazy (s)', color: '#9aa4c7' }, ticks: { color: '#9aa4c7' } },
        y: { beginAtZero: true, title: { display: true, text: 'Mb/s', color: '#9aa4c7' }, ticks: { color: '#9aa4c7' } }
      },
      plugins: { legend: { labels: { color: '#e8ecf8' } } }
    }
  });
}

function updateChart() {
  if (!state.chart) return;
  const maxLen = Math.max(state.downloadSamples.length, state.uploadSamples.length);
  const labels = [];
  for (let i = 0; i < maxLen; i++) {
    const t = state.downloadSamples[i]?.t ?? state.uploadSamples[i]?.t ?? (i + 1) * 0.2;
    labels.push(t.toFixed(1));
  }
  state.chart.data.labels = labels;
  state.chart.data.datasets[0].data = state.downloadSamples.map((s) => s.mbps);
  state.chart.data.datasets[1].data = state.uploadSamples.map((s) => s.mbps);
  state.chart.update();
}

function resetChart() {
  if (!state.chart) return;
  state.downloadSamples = [];
  state.uploadSamples = [];
  state.chart.data.labels = [];
  state.chart.data.datasets[0].data = [];
  state.chart.data.datasets[1].data = [];
  state.chart.update();
}

function stopTest() {
  state.stopped = true;
  if (state.abortController) state.abortController.abort();
  for (const xhr of state.activeXhrs) {
    try { xhr.abort(); } catch (e) {}
  }
  state.activeXhrs.clear();
}

async function runTest() {
  if (state.running) return;
  state.running = true;
  state.stopped = false;
  state.abortController = new AbortController();
  state.serverId = el('serverSelect').value;
  state.serverName = selectedServerName();
  state.streams = Number(el('streamsSelect')?.value || 4);

  resetChart();
  setProgress(0);
  setMetric('downloadValue', null);
  setMetric('uploadValue', null);
  setMetric('pingValue', null);
  setMetric('jitterValue', null);
  setMetric('loadedValue', null);
  el('pingDetail').textContent = 'ms';
  el('loadedDetail').textContent = 'ms';
  el('startBtn').disabled = true;
  el('stopBtn').disabled = false;
  el('analyzeBtn').disabled = true;

  try {
    statusText.textContent = 'Mierzenie pingu i jittera...';
    const pingResult = await measurePing(20);
    state.ping = pingResult.ping;
    state.pingMin = pingResult.min;
    state.pingMax = pingResult.max;
    state.pingP95 = pingResult.p95;
    state.packetLoss = pingResult.packetLoss;
    state.jitter = pingResult.jitter;
    setMetric('pingValue', state.ping);
    setMetric('jitterValue', state.jitter);
    if (Number.isFinite(state.pingMin) && Number.isFinite(state.pingMax)) {
      el('pingDetail').textContent = `ms (min ${fmt(state.pingMin)} / max ${fmt(state.pingMax)} / strata ${state.packetLoss}%)`;
    }

    checkAborted();
    statusText.textContent = `Test pobierania (${state.streams} strumienie)...`;
    const dlSize = Number(el('sizeSelect').value);
    const dl = await measureDownload(dlSize, state.streams);
    state.downloadMbps = dl.mbps;
    state.downloadBytes = dl.bytes;
    state.loadedDownloadLatency = Number.isFinite(dl.loadedLatency) ? dl.loadedLatency : null;
    state.loadedLatency = dl.loadedLatency;
    setMetric('downloadValue', state.downloadMbps);
    setMetric('loadedValue', state.loadedLatency);

    checkAborted();
    statusText.textContent = `Test wysyłania (${state.streams} strumienie)...`;
    const ulSize = Number(el('uploadSizeSelect').value);
    const ul = await measureUpload(ulSize, state.streams);
    state.uploadMbps = ul.mbps;
    state.uploadBytes = ul.bytes;
    state.loadedUploadLatency = Number.isFinite(ul.loadedLatency) ? ul.loadedLatency : null;
    const loaded = Number.isFinite(ul.loadedLatency) ? ul.loadedLatency : state.loadedLatency;
    state.loadedLatency = Number.isFinite(loaded)
      ? (Number.isFinite(state.loadedDownloadLatency) ? (state.loadedDownloadLatency + loaded) / 2 : loaded)
      : state.loadedLatency;
    setMetric('uploadValue', state.uploadMbps);
    setMetric('loadedValue', state.loadedLatency);

    if (Number.isFinite(state.loadedLatency) && Number.isFinite(state.ping)) {
      const bloat = Math.max(0, state.loadedLatency - state.ping);
      const parts = [`+${fmt(bloat)} ms`];
      if (state.loadedDownloadLatency !== null) parts.push(`DL ${fmt(state.loadedDownloadLatency)}`);
      if (state.loadedUploadLatency !== null) parts.push(`UL ${fmt(state.loadedUploadLatency)}`);
      el('loadedDetail').textContent = `ms (${parts.join(' | ')})`;
    }

    setProgress(100);
    statusText.textContent = 'Test zakończony.';
    el('analyzeBtn').disabled = false;

    if (el('saveHistory').checked) {
      await saveHistory();
    }
    if (el('autoAnalyze')?.checked) {
      await analyze();
    }
  } catch (e) {
    if (e.name === 'AbortError' || e.message === 'STOPPED' || state.stopped) {
      statusText.textContent = 'Test zatrzymany.';
    } else {
      statusText.textContent = 'Błąd testu: ' + (e.message || e);
    }
  } finally {
    state.running = false;
    state.abortController = null;
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
    await loadHistory();
  } catch (e) {}
}

async function loadHistory() {
  const box = el('historyBox');
  try {
    const res = await fetch('/api/history');
    const data = await res.json();
    if (!data.enabled) {
      box.textContent = 'Historia wyłączona (brak DATABASE_URL).';
      return;
    }
    if (!data.items.length) {
      box.textContent = 'Brak zapisanych testów.';
      return;
    }
    const rows = data.items.map((r) => {
      return `<tr>
        <td>${new Date(r.created_at).toLocaleString('pl-PL')}</td>
        <td>${escapeHtml(r.server_id)}</td>
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
    box.textContent = 'Błąd ładowania historii.';
  }
}

function fmt(v) {
  if (v == null || !Number.isFinite(Number(v))) return '--';
  const n = Number(v);
  return n.toFixed(n >= 100 ? 0 : 2);
}

async function analyze() {
  const btn = el('analyzeBtn');
  const copyBtn = el('copyAnalysisBtn');
  const meta = el('analysisMeta');
  btn.disabled = true;
  copyBtn.disabled = true;
  meta.textContent = '';
  el('analysisText').textContent = 'Analizowanie wyników przez Groq AI...';

  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        download: Number(state.downloadMbps.toFixed(2)),
        upload: Number(state.uploadMbps.toFixed(2)),
        ping: Number(state.ping.toFixed(2)),
        jitter: Number(state.jitter.toFixed(2)),
        loadedLatency: Number(state.loadedLatency.toFixed(2)),
        pingMin: Number.isFinite(state.pingMin) ? Number(state.pingMin.toFixed(2)) : null,
        pingMax: Number.isFinite(state.pingMax) ? Number(state.pingMax.toFixed(2)) : null,
        pingP95: Number.isFinite(state.pingP95) ? Number(state.pingP95.toFixed(2)) : null,
        packetLoss: state.packetLoss,
        loadedDownloadLatency: state.loadedDownloadLatency !== null ? Number(state.loadedDownloadLatency.toFixed(2)) : null,
        loadedUploadLatency: state.loadedUploadLatency !== null ? Number(state.loadedUploadLatency.toFixed(2)) : null,
        downloadBytes: state.downloadBytes,
        uploadBytes: state.uploadBytes,
        streams: state.streams,
        serverName: state.serverName,
        useCase: el('useCaseSelect')?.value || 'general'
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Błąd analizy');
    state.lastAnalysisMarkdown = data.analysis || '';
    const fallbackNote = data.fallbackUsed ? ' (model zapasowy)' : '';
    const timeNote = Number.isFinite(data.durationMs) ? ` • ${data.durationMs} ms` : '';
    meta.textContent = `Model: ${data.model || 'Groq'}${fallbackNote}${timeNote}`;
    el('analysisText').innerHTML = renderMarkdown(state.lastAnalysisMarkdown);
    copyBtn.disabled = !state.lastAnalysisMarkdown;
  } catch (e) {
    state.lastAnalysisMarkdown = '';
    el('analysisText').innerHTML = renderMarkdown('Błąd: ' + (e.message || e));
  } finally {
    btn.disabled = false;
  }
}

async function copyAnalysis() {
  if (!state.lastAnalysisMarkdown || !navigator.clipboard) return;
  try {
    await navigator.clipboard.writeText(state.lastAnalysisMarkdown);
    const btn = el('copyAnalysisBtn');
    const prev = btn.textContent;
    btn.textContent = 'Skopiowano!';
    setTimeout(() => { btn.textContent = prev; }, 1500);
  } catch (e) {}
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
  const lines = String(markdown || '').split(/\r?\n/);
  const html = [];
  let listType = null; // 'ul' | 'ol'
  let inCode = false;
  const codeLines = [];

  function closeList() {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.startsWith('```')) {
      if (inCode) {
        html.push('<pre><code>' + escapeHtml(codeLines.join('\n')) + '</code></pre>');
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
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      html.push('<h' + (level + 2) + '>' + inlineMarkdown(heading[2]) + '</h' + (level + 2) + '>');
      continue;
    }
    const ulMatch = line.match(/^[-*+]\s+(.*)$/);
    if (ulMatch) {
      if (listType !== 'ul') {
        closeList();
        html.push('<ul>');
        listType = 'ul';
      }
      html.push('<li>' + inlineMarkdown(ulMatch[1]) + '</li>');
      continue;
    }
    const olMatch = line.match(/^\d+\.\s+(.*)$/);
    if (olMatch) {
      if (listType !== 'ol') {
        closeList();
        html.push('<ol>');
        listType = 'ol';
      }
      html.push('<li>' + inlineMarkdown(olMatch[1]) + '</li>');
      continue;
    }
    closeList();
    html.push('<p>' + inlineMarkdown(line) + '</p>');
  }

  if (inCode) {
    html.push('<pre><code>' + escapeHtml(codeLines.join('\n')) + '</code></pre>');
  }
  closeList();
  return html.join('');
}

document.addEventListener('DOMContentLoaded', () => {
  initChart();
  loadServers();
  loadHistory();
  el('startBtn').addEventListener('click', runTest);
  el('stopBtn').addEventListener('click', stopTest);
  el('analyzeBtn').addEventListener('click', analyze);
  el('copyAnalysisBtn').addEventListener('click', copyAnalysis);
  el('refreshHistoryBtn').addEventListener('click', loadHistory);
});
