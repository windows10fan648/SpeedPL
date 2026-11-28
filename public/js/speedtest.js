/* global Chart, SpeedPLDiagnostics */
const D = window.SpeedPLDiagnostics;
const LOCAL_HISTORY_KEY = 'speedpl_history_v1';
const GAUGE_ARC_LEN = 469.14;
const GAUGE_STOPS = [0, 25, 100, 250, 500, 1000, 2000];

const state = {
  running: false,
  stopped: false,
  preset: 'full', // 'full' | 'quick' | 'latency'
  chartMode: 'throughput', // 'throughput' | 'ping'
  abortController: null,
  phaseControllers: new Set(),
  activeXhrs: new Set(),
  elapsedTimer: null,
  runStartedAt: 0,
  serverId: 'current',
  serverName: 'Serwer bieżący',
  streams: 4,
  downloadMbps: 0,
  uploadMbps: 0,
  ping: 0,
  pingMin: null,
  pingMax: null,
  pingP95: null,
  pingSamples: [],
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

function fmt(v) {
  return D.formatMetric(v);
}

function setMetric(id, value) {
  const node = el(id);
  if (!node) return;
  node.textContent = fmt(value);
}

function setProgress(pct, mode = 'download') {
  const bar = el('progressBar');
  if (!bar) return;
  bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
  bar.classList.toggle('upload', mode === 'upload');
}

function mbpsToGaugeRatio(mbps) {
  if (!Number.isFinite(mbps) || mbps <= 0) return 0;
  if (mbps >= GAUGE_STOPS[GAUGE_STOPS.length - 1]) return 1;
  const segments = GAUGE_STOPS.length - 1;
  for (let i = 0; i < segments; i++) {
    const lo = GAUGE_STOPS[i];
    const hi = GAUGE_STOPS[i + 1];
    if (mbps <= hi) {
      const localT = (mbps - lo) / (hi - lo);
      return (i + localT) / segments;
    }
  }
  return 1;
}

function setGauge(value, unit = 'Mb/s', phaseLabel = 'Oczekiwanie', mode = 'download') {
  const arc = el('gaugeArc');
  const valNode = el('gaugeValue');
  const unitNode = el('gaugeUnit');
  const phaseNode = el('gaugePhaseLabel');

  if (phaseNode) phaseNode.textContent = phaseLabel;
  if (unitNode) unitNode.textContent = unit;
  if (valNode) {
    valNode.textContent = Number.isFinite(value) && value > 0 ? fmt(value) : '0.00';
  }
  if (arc) {
    arc.setAttribute('stroke', mode === 'upload' ? 'url(#gaugeUploadGrad)' : 'url(#gaugeDownloadGrad)');
    const ratio = unit === 'ms'
      ? Math.min(1, Math.max(0, (value || 0) / 150))
      : mbpsToGaugeRatio(value || 0);
    const offset = GAUGE_ARC_LEN * (1 - ratio);
    arc.style.strokeDashoffset = offset.toFixed(2);
  }
}

function setPhase(activePhase) {
  const order = ['idle', 'ping', 'download', 'upload', 'done'];
  const activeIdx = order.indexOf(activePhase);
  const steps = document.querySelectorAll('#phaseStepper .phase-step');
  steps.forEach((step) => {
    const p = step.dataset.phase;
    const idx = order.indexOf(p);
    step.classList.toggle('active', p === activePhase);
    step.classList.toggle('done', activeIdx > idx && p !== 'idle' && activePhase !== 'idle');
  });
}

function serverBase() {
  const select = el('serverSelect');
  const option = select.options[select.selectedIndex];
  return option?.dataset?.url || '';
}

function selectedServerName() {
  const select = el('serverSelect');
  const option = select.options[select.selectedIndex];
  const raw = option ? option.textContent : 'Serwer bieżący';
  return raw.replace(/\s*\(\d+(?:\.\d+)?\s*ms\)$/, '');
}

function endpoint(path) {
  const base = serverBase().replace(/\/+$/, '');
  return base ? base + path : path;
}

function now() {
  return performance.now();
}

function checkAborted() {
  if (state.stopped || state.abortController?.signal?.aborted) {
    const err = new Error('STOPPED');
    err.name = 'AbortError';
    throw err;
  }
}

function parseSizeSpec(value) {
  const str = String(value || '');
  if (str.startsWith('auto:')) {
    const ms = Number(str.slice(5));
    return { mode: 'auto', durationMs: Number.isFinite(ms) && ms > 0 ? ms : 8000 };
  }
  const bytes = Number(str);
  return { mode: 'fixed', bytes: Number.isFinite(bytes) && bytes > 0 ? bytes : 16 * 1024 * 1024 };
}

async function copyToClipboard(text) {
  if (!text) return false;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {}
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    return false;
  }
}

async function loadServers() {
  try {
    const res = await fetch('/api/servers');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const select = el('serverSelect');
    const prevValue = select.value;
    select.innerHTML = '';
    for (const s of data.servers) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.configured ? s.name : s.name + ' (wymaga konfiguracji)';
      opt.dataset.baseName = s.name;
      opt.disabled = !s.configured;
      opt.dataset.url = s.url || '';
      select.appendChild(opt);
    }
    if (prevValue && Array.from(select.options).some((o) => o.value === prevValue && !o.disabled)) {
      select.value = prevValue;
    } else {
      const current = data.servers.find((s) => s.id === 'current');
      if (current) select.value = 'current';
    }
  } catch (e) {
    statusText.textContent = 'Nie udało się pobrać listy serwerów.';
  }
}

async function probeServers() {
  const btn = el('probeServersBtn');
  const hint = el('serverProbeResult');
  const select = el('serverSelect');
  if (!btn || !select) return;
  btn.disabled = true;
  if (hint) hint.textContent = 'Sprawdzanie opóźnień serwerów...';

  try {
    const options = Array.from(select.options).filter((o) => !o.disabled);
    const summaries = [];
    for (const opt of options) {
      const base = (opt.dataset.url || '').replace(/\/+$/, '');
      const url = (base ? base + '/api/ping' : '/api/ping') + '?probe=1&r=' + Math.random();
      const samples = [];
      for (let i = 0; i < 3; i++) {
        const t0 = now();
        try {
          const res = await fetch(url + '&i=' + i, { cache: 'no-store' });
          if (res.ok) samples.push(now() - t0);
        } catch (e) {}
      }
      const baseName = opt.dataset.baseName || opt.textContent.replace(/\s*\(\d+(?:\.\d+)?\s*ms\)$/, '');
      opt.dataset.baseName = baseName;
      if (samples.length) {
        samples.sort((a, b) => a - b);
        const median = samples[Math.floor(samples.length / 2)];
        opt.textContent = `${baseName} (${fmt(median)} ms)`;
        summaries.push(`${baseName}: ${fmt(median)} ms`);
      } else {
        opt.textContent = `${baseName} (brak odpowiedzi)`;
        summaries.push(`${baseName}: brak odpowiedzi`);
      }
    }
    if (hint) hint.textContent = summaries.join(' · ');
  } finally {
    btn.disabled = false;
  }
}

async function measurePing(count = 20) {
  const signal = state.abortController?.signal;
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
      const rtt = now() - start;
      rtts.push(rtt);
      setGauge(rtt, 'ms', 'Pomiar pingu', 'download');
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      failures++;
    }
    setProgress(5 + ((i + 1) / count) * 10);
  }

  checkAborted();
  return D.computePingStats(rtts, failures);
}

function startLoadedLatencyLoop(signal) {
  const rtts = [];
  let active = true;
  const promise = (async () => {
    while (active && !state.stopped && !signal?.aborted) {
      const start = now();
      try {
        const res = await fetch(endpoint('/api/ping') + '?load=1&r=' + Math.random(), { cache: 'no-store', signal });
        if (res.ok) rtts.push(now() - start);
      } catch (e) {
        if (e.name === 'AbortError') break;
      }
      await new Promise((r) => setTimeout(r, 350));
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

function linkPhaseAbort(phaseCtrl) {
  state.phaseControllers.add(phaseCtrl);
  const globalSig = state.abortController?.signal;
  const onGlobalAbort = () => phaseCtrl.abort();
  if (globalSig) {
    if (globalSig.aborted) phaseCtrl.abort();
    else globalSig.addEventListener('abort', onGlobalAbort, { once: true });
  }
  return () => {
    state.phaseControllers.delete(phaseCtrl);
    if (globalSig) globalSig.removeEventListener('abort', onGlobalAbort);
  };
}

async function measureDownload(sizeSpec, streams = 4) {
  const phaseCtrl = new AbortController();
  const cleanupLink = linkPhaseAbort(phaseCtrl);
  const probeLoop = startLoadedLatencyLoop(phaseCtrl.signal);

  const isAuto = sizeSpec.mode === 'auto';
  const targetDurationMs = isAuto ? sizeSpec.durationMs : null;
  const perStreamFixed = isAuto ? 128 * 1024 * 1024 : Math.ceil(sizeSpec.bytes / streams);

  const streamBytes = new Array(streams).fill(0);
  state.downloadSamples = [];

  const start = now();
  let lastSampleTime = start;
  let lastSampleBytes = 0;
  let smoothedMbps = 0;
  let phaseTimedOut = false;

  let timeoutId = null;
  if (isAuto) {
    timeoutId = setTimeout(() => {
      phaseTimedOut = true;
      phaseCtrl.abort();
    }, targetDurationMs);
  }

  const sampler = setInterval(() => {
    if (state.stopped || phaseTimedOut) return;
    const t = now();
    const totalReceived = streamBytes.reduce((a, b) => a + b, 0);
    const dt = (t - lastSampleTime) / 1000;
    const db = totalReceived - lastSampleBytes;
    if (dt > 0) {
      const instantMbps = D.computeMbps(db, dt);
      smoothedMbps = smoothedMbps > 0
        ? smoothedMbps * 0.45 + instantMbps * 0.55
        : instantMbps;
      const elapsedSec = (t - start) / 1000;
      const avgMbps = D.computeMbps(totalReceived, elapsedSec);
      const displayMbps = instantMbps > 0 ? smoothedMbps : avgMbps;

      state.downloadSamples.push({ t: elapsedSec, mbps: instantMbps > 0 ? instantMbps : avgMbps });
      setMetric('downloadValue', displayMbps);
      setGauge(displayMbps, 'Mb/s', 'Pobieranie', 'download');

      const pct = isAuto
        ? Math.min(1, (t - start) / targetDurationMs)
        : Math.min(1, totalReceived / sizeSpec.bytes);
      setProgress(15 + pct * 40, 'download');

      lastSampleTime = t;
      lastSampleBytes = totalReceived;
      if (state.chartMode === 'throughput') updateChart();
    }
  }, 200);

  try {
    await Promise.all(
      Array.from({ length: streams }, async (_, idx) => {
        while (!state.stopped && !phaseTimedOut && !phaseCtrl.signal.aborted) {
          const response = await fetch(
            endpoint('/api/download') + '?bytes=' + perStreamFixed + '&s=' + idx + '&r=' + Math.random(),
            { cache: 'no-store', signal: phaseCtrl.signal }
          );
          if (!response.ok || !response.body) {
            throw new Error('Błąd pobierania (HTTP ' + response.status + ')');
          }
          const reader = response.body.getReader();
          while (!state.stopped && !phaseTimedOut) {
            const { done, value } = await reader.read();
            if (done) break;
            streamBytes[idx] += value.byteLength;
          }
          if (!isAuto) break;
        }
      })
    );
  } catch (err) {
    if (!(phaseTimedOut && err.name === 'AbortError')) {
      throw err;
    }
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    clearInterval(sampler);
    await probeLoop.stop();
    cleanupLink();
  }

  checkAborted();
  const elapsed = (now() - start) / 1000;
  const totalReceived = streamBytes.reduce((a, b) => a + b, 0);
  const loadedLatency = await probeLoop.stop();
  const mbps = D.computeMbps(totalReceived, elapsed);

  if (!state.downloadSamples.length) {
    state.downloadSamples.push({ t: elapsed, mbps });
    if (state.chartMode === 'throughput') updateChart();
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

function uploadSingleStream(blob, idx, onProgress, phaseSignal) {
  return new Promise((resolve, reject) => {
    if (state.stopped || phaseSignal?.aborted) {
      const err = new Error('STOPPED');
      err.name = 'AbortError';
      return reject(err);
    }

    const xhr = new XMLHttpRequest();
    state.activeXhrs.add(xhr);

    const onAbortSignal = () => {
      try { xhr.abort(); } catch (e) {}
    };
    if (phaseSignal) phaseSignal.addEventListener('abort', onAbortSignal, { once: true });

    const cleanup = () => {
      state.activeXhrs.delete(xhr);
      if (phaseSignal) phaseSignal.removeEventListener('abort', onAbortSignal);
    };

    xhr.open('POST', endpoint('/api/upload') + '?s=' + idx + '&r=' + Math.random(), true);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded);
    };

    xhr.onload = () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText || '{}');
          resolve(data.received || blob.size);
        } catch (e) {
          resolve(blob.size);
        }
      } else {
        reject(new Error('Błąd wysyłania (HTTP ' + xhr.status + ')'));
      }
    };

    xhr.onerror = () => {
      cleanup();
      reject(new Error('Błąd sieci podczas wysyłania'));
    };

    xhr.onabort = () => {
      cleanup();
      const err = new Error('STOPPED');
      err.name = 'AbortError';
      reject(err);
    };

    xhr.send(blob);
  });
}

async function measureUpload(sizeSpec, streams = 4) {
  const phaseCtrl = new AbortController();
  const cleanupLink = linkPhaseAbort(phaseCtrl);
  const probeLoop = startLoadedLatencyLoop(phaseCtrl.signal);

  const isAuto = sizeSpec.mode === 'auto';
  const targetDurationMs = isAuto ? sizeSpec.durationMs : null;

  // Reusable 4 MB random buffer; Blobs reference slices with zero extra memory copy.
  const baseBuffer = randomBytes(4 * 1024 * 1024);
  function makeUploadBlob(targetBytes) {
    const parts = [];
    let left = Math.max(256 * 1024, Math.min(32 * 1024 * 1024, targetBytes));
    while (left > 0) {
      const take = Math.min(left, baseBuffer.byteLength);
      parts.push(take === baseBuffer.byteLength ? baseBuffer : baseBuffer.subarray(0, take));
      left -= take;
    }
    return new Blob(parts);
  }

  const estStreamBytesPerSec = ((state.downloadMbps || 25) * 125000) / Math.max(1, streams);
  let adaptiveChunkBytes = Math.max(512 * 1024, Math.min(32 * 1024 * 1024, Math.round(estStreamBytesPerSec * 1.2)));
  const fixedPerStream = isAuto ? 0 : Math.ceil(sizeSpec.bytes / streams);

  const streamCompleted = new Array(streams).fill(0);
  const streamInflight = new Array(streams).fill(0);
  state.uploadSamples = [];

  const start = now();
  let lastSampleTime = start;
  let lastSampleBytes = 0;
  let smoothedMbps = 0;
  let phaseTimedOut = false;

  let timeoutId = null;
  if (isAuto) {
    timeoutId = setTimeout(() => {
      phaseTimedOut = true;
      phaseCtrl.abort();
    }, targetDurationMs);
  }

  const totalTransferredSoFar = () =>
    streamCompleted.reduce((a, b) => a + b, 0) + streamInflight.reduce((a, b) => a + b, 0);

  const sampler = setInterval(() => {
    if (state.stopped || phaseTimedOut) return;
    const t = now();
    const totalSent = totalTransferredSoFar();
    const dt = (t - lastSampleTime) / 1000;
    const db = Math.max(0, totalSent - lastSampleBytes);
    if (dt > 0) {
      const instantMbps = D.computeMbps(db, dt);
      smoothedMbps = smoothedMbps > 0
        ? smoothedMbps * 0.45 + instantMbps * 0.55
        : instantMbps;
      const elapsedSec = (t - start) / 1000;
      const avgMbps = D.computeMbps(totalSent, elapsedSec);
      const displayMbps = instantMbps > 0 ? smoothedMbps : avgMbps;

      state.uploadSamples.push({ t: elapsedSec, mbps: instantMbps > 0 ? instantMbps : avgMbps });
      setMetric('uploadValue', displayMbps);
      setGauge(displayMbps, 'Mb/s', 'Wysyłanie', 'upload');

      const pct = isAuto
        ? Math.min(1, (t - start) / targetDurationMs)
        : Math.min(1, totalSent / sizeSpec.bytes);
      setProgress(55 + pct * 40, 'upload');

      lastSampleTime = t;
      lastSampleBytes = totalSent;
      if (state.chartMode === 'throughput') updateChart();
    }
  }, 200);

  let confirmedBytes = 0;
  try {
    await Promise.all(
      Array.from({ length: streams }, async (_, idx) => {
        if (!isAuto) {
          let remaining = fixedPerStream;
          while (remaining > 0 && !state.stopped && !phaseCtrl.signal.aborted) {
            const sliceSize = Math.min(remaining, 32 * 1024 * 1024);
            const blob = makeUploadBlob(sliceSize);
            const received = await uploadSingleStream(
              blob,
              idx,
              (loaded) => { streamInflight[idx] = loaded; },
              phaseCtrl.signal
            );
            streamInflight[idx] = 0;
            streamCompleted[idx] += received;
            remaining -= sliceSize;
          }
        } else {
          let streamChunk = adaptiveChunkBytes;
          while (!state.stopped && !phaseTimedOut && !phaseCtrl.signal.aborted) {
            const reqStart = now();
            const blob = makeUploadBlob(streamChunk);
            const received = await uploadSingleStream(
              blob,
              idx,
              (loaded) => { streamInflight[idx] = loaded; },
              phaseCtrl.signal
            );
            streamInflight[idx] = 0;
            streamCompleted[idx] += received;
            const reqMs = now() - reqStart;
            if (reqMs < 350 && streamChunk < 32 * 1024 * 1024) {
              streamChunk = Math.min(32 * 1024 * 1024, streamChunk * 2);
            }
          }
        }
      })
    );
  } catch (err) {
    if (!(phaseTimedOut && err.name === 'AbortError')) {
      throw err;
    }
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    clearInterval(sampler);
    await probeLoop.stop();
    cleanupLink();
  }

  checkAborted();
  const elapsed = (now() - start) / 1000;
  confirmedBytes = totalTransferredSoFar();
  const loadedLatency = await probeLoop.stop();
  const mbps = D.computeMbps(confirmedBytes, elapsed);

  if (!state.uploadSamples.length) {
    state.uploadSamples.push({ t: elapsed, mbps });
    if (state.chartMode === 'throughput') updateChart();
  }
  return { mbps, bytes: confirmedBytes, loadedLatency };
}

function initChart() {
  const canvas = el('speedChart');
  if (!canvas || typeof Chart === 'undefined') return;
  const ctx = canvas.getContext('2d');
  state.chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Pobieranie (Mb/s)',
          data: [],
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59, 130, 246, 0.12)',
          borderWidth: 2,
          tension: 0.25,
          fill: true,
          pointRadius: 1.5
        },
        {
          label: 'Wysyłanie (Mb/s)',
          data: [],
          borderColor: '#10b981',
          backgroundColor: 'rgba(16, 185, 129, 0.1)',
          borderWidth: 2,
          tension: 0.25,
          fill: true,
          pointRadius: 1.5
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          title: { display: true, text: 'Czas fazy (s)', color: '#94a3b8' },
          ticks: { color: '#94a3b8' },
          grid: { color: 'rgba(36, 48, 71, 0.5)' }
        },
        y: {
          beginAtZero: true,
          title: { display: true, text: 'Mb/s', color: '#94a3b8' },
          ticks: { color: '#94a3b8' },
          grid: { color: 'rgba(36, 48, 71, 0.5)' }
        }
      },
      plugins: {
        legend: { labels: { color: '#f1f5f9', boxWidth: 12 } }
      }
    }
  });
}

function updateChart() {
  if (!state.chart) return;

  if (state.chartMode === 'ping') {
    const samples = state.pingSamples || [];
    state.chart.config.type = 'bar';
    state.chart.data.labels = samples.map((_, i) => `#${i + 1}`);
    state.chart.data.datasets = [
      {
        label: 'RTT próby (ms)',
        data: samples.map((v) => Number(v.toFixed(2))),
        backgroundColor: 'rgba(59, 130, 246, 0.65)',
        borderColor: '#3b82f6',
        borderWidth: 1,
        borderRadius: 4
      }
    ];
    state.chart.options.scales.x.title.text = 'Numer próby';
    state.chart.options.scales.y.title.text = 'ms';
    state.chart.update();
    return;
  }

  state.chart.config.type = 'line';
  const maxLen = Math.max(state.downloadSamples.length, state.uploadSamples.length);
  const labels = [];
  for (let i = 0; i < maxLen; i++) {
    const t = state.downloadSamples[i]?.t ?? state.uploadSamples[i]?.t ?? (i + 1) * 0.2;
    labels.push(t.toFixed(1));
  }
  state.chart.data.labels = labels;
  state.chart.data.datasets = [
    {
      label: 'Pobieranie (Mb/s)',
      data: state.downloadSamples.map((s) => Number(s.mbps.toFixed(2))),
      borderColor: '#3b82f6',
      backgroundColor: 'rgba(59, 130, 246, 0.12)',
      borderWidth: 2,
      tension: 0.25,
      fill: true,
      pointRadius: 1.5
    },
    {
      label: 'Wysyłanie (Mb/s)',
      data: state.uploadSamples.map((s) => Number(s.mbps.toFixed(2))),
      borderColor: '#10b981',
      backgroundColor: 'rgba(16, 185, 129, 0.1)',
      borderWidth: 2,
      tension: 0.25,
      fill: true,
      pointRadius: 1.5
    }
  ];
  state.chart.options.scales.x.title.text = 'Czas fazy (s)';
  state.chart.options.scales.y.title.text = 'Mb/s';
  state.chart.update();
}

function resetChart() {
  if (!state.chart) return;
  state.downloadSamples = [];
  state.uploadSamples = [];
  state.pingSamples = [];
  updateChart();
}

function renderLocalDiagnostics() {
  const gradeBadge = el('bufferbloatGradeBadge');
  const bloatSummary = el('bufferbloatSummary');
  const matrix = el('useCaseMatrix');

  const bloat = D.computeBufferbloatGrade(state.ping, state.loadedLatency);
  if (gradeBadge) {
    gradeBadge.textContent = `Klasa: ${bloat.grade}`;
    gradeBadge.className = `grade-readout mono ${bloat.status}`;
  }
  if (bloatSummary) {
    if (bloat.deltaMs !== null) {
      bloatSummary.textContent = `${bloat.label} (+${fmt(bloat.deltaMs)} ms pod obciążeniem) — ${bloat.detail}`;
    } else {
      bloatSummary.textContent = bloat.detail;
    }
  }

  if (matrix) {
    const items = D.evaluateUseCases({
      downloadMbps: state.downloadMbps,
      uploadMbps: state.uploadMbps,
      ping: state.ping,
      jitter: state.jitter,
      packetLoss: state.packetLoss,
      loadedLatency: state.loadedLatency
    });
    if (!items.length) {
      matrix.innerHTML = '<div class="use-case-empty">Brak wyników pomiaru do oceny.</div>';
      return;
    }
    matrix.innerHTML = items.map((item) => `
      <div class="use-case-row">
        <span class="use-case-title">${escapeHtml(item.title)}</span>
        <span class="use-case-status ${escapeHtml(item.status)}">${escapeHtml(item.statusLabel)}</span>
        <span class="use-case-reason">${escapeHtml(item.reason)}</span>
      </div>
    `).join('');
  }
}

function stopTest() {
  state.stopped = true;
  if (state.abortController) state.abortController.abort();
  for (const ctrl of state.phaseControllers) {
    try { ctrl.abort(); } catch (e) {}
  }
  state.phaseControllers.clear();
  for (const xhr of state.activeXhrs) {
    try { xhr.abort(); } catch (e) {}
  }
  state.activeXhrs.clear();
}

function startElapsedClock() {
  state.runStartedAt = now();
  el('elapsedText').textContent = '0.0 s';
  state.elapsedTimer = setInterval(() => {
    const sec = (now() - state.runStartedAt) / 1000;
    el('elapsedText').textContent = sec.toFixed(1) + ' s';
  }, 100);
}

function stopElapsedClock() {
  if (state.elapsedTimer) {
    clearInterval(state.elapsedTimer);
    state.elapsedTimer = null;
  }
}

function formatMB(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

async function runTest() {
  if (state.running) return;
  state.running = true;
  state.stopped = false;
  state.abortController = new AbortController();
  state.serverId = el('serverSelect').value;
  state.serverName = selectedServerName();
  state.streams = Number(el('streamsSelect')?.value || 4);
  state.downloadMbps = 0;
  state.uploadMbps = 0;
  state.ping = 0;
  state.pingMin = null;
  state.pingMax = null;
  state.pingP95 = null;
  state.packetLoss = 0;
  state.jitter = 0;
  state.loadedLatency = NaN;
  state.loadedDownloadLatency = null;
  state.loadedUploadLatency = null;
  state.downloadBytes = 0;
  state.uploadBytes = 0;

  resetChart();
  setProgress(0, 'download');
  setGauge(0, 'Mb/s', 'Inicjalizacja', 'download');
  setPhase('ping');

  setMetric('downloadValue', null);
  setMetric('uploadValue', null);
  setMetric('pingValue', null);
  setMetric('jitterValue', null);
  setMetric('loadedValue', null);
  el('downloadDetail').textContent = 'Oczekuje na pomiar';
  el('uploadDetail').textContent = 'Oczekuje na pomiar';
  el('pingDetail').textContent = 'min / P95 / max';
  el('jitterDetail').textContent = 'Zmienność RTT';
  el('loadedDetail').textContent = 'Bufferbloat / DL / UL';

  el('startBtn').disabled = true;
  el('stopBtn').disabled = false;
  el('analyzeBtn').disabled = true;
  el('copySummaryBtn').disabled = true;
  startElapsedClock();

  try {
    const pingCount = Number(el('pingCountSelect')?.value || 20);
    statusText.textContent = `Mierzenie pingu i jittera (${pingCount} prób)...`;
    const pingResult = await measurePing(pingCount);
    state.ping = pingResult.ping;
    state.pingMin = pingResult.min;
    state.pingMax = pingResult.max;
    state.pingP95 = pingResult.p95;
    state.packetLoss = pingResult.packetLoss;
    state.jitter = pingResult.jitter;
    state.pingSamples = pingResult.samples;

    setMetric('pingValue', state.ping);
    setMetric('jitterValue', state.jitter);
    if (Number.isFinite(state.pingMin) && Number.isFinite(state.pingMax)) {
      el('pingDetail').textContent = `min ${fmt(state.pingMin)} / P95 ${fmt(state.pingP95)} / max ${fmt(state.pingMax)}`;
      el('jitterDetail').textContent = `Strata prób: ${state.packetLoss}%`;
    }
    if (state.chartMode === 'ping') updateChart();

    if (state.preset !== 'latency') {
      checkAborted();
      setPhase('download');
      statusText.textContent = `Test pobierania (${state.streams} strumienie)...`;
      const dlSpec = parseSizeSpec(el('sizeSelect').value);
      const dl = await measureDownload(dlSpec, state.streams);
      state.downloadMbps = dl.mbps;
      state.downloadBytes = dl.bytes;
      state.loadedDownloadLatency = Number.isFinite(dl.loadedLatency) ? dl.loadedLatency : null;
      state.loadedLatency = dl.loadedLatency;
      setMetric('downloadValue', state.downloadMbps);
      el('downloadDetail').textContent = `Przesłano ${formatMB(state.downloadBytes)}`;
      setMetric('loadedValue', state.loadedLatency);

      checkAborted();
      setPhase('upload');
      statusText.textContent = `Test wysyłania (${state.streams} strumienie)...`;
      const ulSpec = parseSizeSpec(el('uploadSizeSelect').value);
      const ul = await measureUpload(ulSpec, state.streams);
      state.uploadMbps = ul.mbps;
      state.uploadBytes = ul.bytes;
      state.loadedUploadLatency = Number.isFinite(ul.loadedLatency) ? ul.loadedLatency : null;

      const loadedParts = [state.loadedDownloadLatency, state.loadedUploadLatency].filter(Number.isFinite);
      state.loadedLatency = loadedParts.length
        ? loadedParts.reduce((a, b) => a + b, 0) / loadedParts.length
        : NaN;

      setMetric('uploadValue', state.uploadMbps);
      el('uploadDetail').textContent = `Wysłano ${formatMB(state.uploadBytes)}`;
      setMetric('loadedValue', state.loadedLatency);

      if (Number.isFinite(state.loadedLatency) && Number.isFinite(state.ping)) {
        const bloat = Math.max(0, state.loadedLatency - state.ping);
        const parts = [`+${fmt(bloat)} ms`];
        if (state.loadedDownloadLatency !== null) parts.push(`DL ${fmt(state.loadedDownloadLatency)}`);
        if (state.loadedUploadLatency !== null) parts.push(`UL ${fmt(state.loadedUploadLatency)}`);
        el('loadedDetail').textContent = parts.join(' · ');
      }
      setGauge(state.downloadMbps, 'Mb/s', 'Pobieranie (wynik)', 'download');
    } else {
      el('downloadDetail').textContent = 'Pominięto (tryb ping)';
      el('uploadDetail').textContent = 'Pominięto (tryb ping)';
      setGauge(state.ping, 'ms', 'Ping (mediana)', 'download');
    }

    setProgress(100, 'download');
    setPhase('done');
    statusText.textContent = 'Test zakończony.';
    el('analyzeBtn').disabled = state.preset === 'latency';
    el('copySummaryBtn').disabled = false;

    renderLocalDiagnostics();

    if (el('saveHistory').checked) {
      await saveHistory();
    }
    if (el('autoAnalyze')?.checked && state.preset !== 'latency') {
      await analyze();
    }
  } catch (e) {
    if (e.name === 'AbortError' || e.message === 'STOPPED' || state.stopped) {
      statusText.textContent = 'Test zatrzymany.';
      setPhase('idle');
      setGauge(0, 'Mb/s', 'Zatrzymano', 'download');
    } else {
      statusText.textContent = 'Błąd testu: ' + (e.message || e);
      setPhase('idle');
    }
  } finally {
    stopElapsedClock();
    state.running = false;
    state.abortController = null;
    el('startBtn').disabled = false;
    el('stopBtn').disabled = true;
  }
}

function saveLocalHistory(entry) {
  try {
    const raw = localStorage.getItem(LOCAL_HISTORY_KEY);
    const list = raw ? JSON.parse(raw) : [];
    const next = [entry, ...(Array.isArray(list) ? list : [])].slice(0, 100);
    localStorage.setItem(LOCAL_HISTORY_KEY, JSON.stringify(next));
  } catch (e) {}
}

async function saveHistory() {
  const isLatencyOnly = state.preset === 'latency';
  const bloat = D.computeBufferbloatGrade(state.ping, state.loadedLatency);
  const payload = {
    id: 'local-' + Date.now(),
    created_at: new Date().toISOString(),
    server_id: state.serverId,
    serverId: state.serverId,
    serverName: state.serverName,
    download_mbps: isLatencyOnly ? null : state.downloadMbps,
    download: isLatencyOnly ? null : state.downloadMbps,
    upload_mbps: isLatencyOnly ? null : state.uploadMbps,
    upload: isLatencyOnly ? null : state.uploadMbps,
    ping_ms: state.ping,
    ping: state.ping,
    jitter_ms: state.jitter,
    jitter: state.jitter,
    loaded_latency_ms: Number.isFinite(state.loadedLatency) ? state.loadedLatency : null,
    loadedLatency: Number.isFinite(state.loadedLatency) ? state.loadedLatency : null,
    bufferbloatGrade: bloat.grade,
    downloadBytes: state.downloadBytes,
    uploadBytes: state.uploadBytes,
    source: 'Lokalnie'
  };

  saveLocalHistory(payload);

  if (document.body.dataset.dbConfigured !== 'true') return;

  try {
    await fetch('/api/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) {}
}

async function copySummary() {
  const bloat = D.computeBufferbloatGrade(state.ping, state.loadedLatency);
  const lines = [
    `SpeedPL — Wynik pomiaru (${new Date().toLocaleString('pl-PL')})`,
    `Serwer: ${state.serverName}`,
    `Pobieranie: ${fmt(state.downloadMbps)} Mb/s`,
    `Wysyłanie: ${fmt(state.uploadMbps)} Mb/s`,
    `Ping: ${fmt(state.ping)} ms (min ${fmt(state.pingMin)} / P95 ${fmt(state.pingP95)} / max ${fmt(state.pingMax)})`,
    `Jitter: ${fmt(state.jitter)} ms | Strata: ${state.packetLoss}%`,
    `Latencja pod obciążeniem: ${fmt(state.loadedLatency)} ms (Bufferbloat: ${bloat.grade})`
  ];
  const ok = await copyToClipboard(lines.join('\n'));
  if (ok) {
    const btn = el('copySummaryBtn');
    const prev = btn.textContent;
    btn.textContent = 'Skopiowano!';
    setTimeout(() => { btn.textContent = prev; }, 1500);
  }
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
        loadedLatency: Number.isFinite(state.loadedLatency) ? Number(state.loadedLatency.toFixed(2)) : Number(state.ping.toFixed(2)),
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
    const timeNote = Number.isFinite(data.durationMs) ? ` · ${data.durationMs} ms` : '';
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
  const ok = await copyToClipboard(state.lastAnalysisMarkdown);
  if (ok) {
    const btn = el('copyAnalysisBtn');
    const prev = btn.textContent;
    btn.textContent = 'Skopiowano!';
    setTimeout(() => { btn.textContent = prev; }, 1500);
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
  const lines = String(markdown || '').split(/\r?\n/);
  const html = [];
  let listType = null;
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

function applyPreset(preset) {
  state.preset = preset;
  document.querySelectorAll('#testPresetGroup .seg-btn').forEach((b) => {
    const active = b.dataset.preset === preset;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  const dlSel = el('sizeSelect');
  const ulSel = el('uploadSizeSelect');
  const pingSel = el('pingCountSelect');

  if (preset === 'full') {
    dlSel.disabled = false;
    ulSel.disabled = false;
    dlSel.value = 'auto:8000';
    ulSel.value = 'auto:8000';
    pingSel.value = '20';
  } else if (preset === 'quick') {
    dlSel.disabled = false;
    ulSel.disabled = false;
    dlSel.value = 'auto:4000';
    ulSel.value = 'auto:4000';
    pingSel.value = '12';
  } else if (preset === 'latency') {
    dlSel.disabled = true;
    ulSel.disabled = true;
    pingSel.value = '40';
  }
}

function setChartMode(mode) {
  state.chartMode = mode;
  document.querySelectorAll('#chartModeGroup .seg-btn').forEach((b) => {
    const active = b.dataset.chart === mode;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  updateChart();
}

document.addEventListener('DOMContentLoaded', () => {
  initChart();
  loadServers();
  setPhase('idle');
  setGauge(0, 'Mb/s', 'Oczekiwanie', 'download');

  el('startBtn').addEventListener('click', runTest);
  el('stopBtn').addEventListener('click', stopTest);
  el('analyzeBtn').addEventListener('click', analyze);
  el('copyAnalysisBtn').addEventListener('click', copyAnalysis);
  el('copySummaryBtn').addEventListener('click', copySummary);
  el('probeServersBtn').addEventListener('click', probeServers);

  document.querySelectorAll('#testPresetGroup .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!state.running) applyPreset(btn.dataset.preset);
    });
  });

  document.querySelectorAll('#chartModeGroup .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => setChartMode(btn.dataset.chart));
  });
});
