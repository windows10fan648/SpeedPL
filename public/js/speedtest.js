/* global Chart, SpeedPLDiagnostics, SpeedPLI18n */
const D = window.SpeedPLDiagnostics;
const I18n = window.SpeedPLI18n;
const LOCAL_HISTORY_KEY = 'speedpl_history_v1';
const LANG_STORAGE_KEY = 'speedpl_lang';
const GAUGE_ARC_LEN = 469.14;
const GAUGE_STOPS = [0, 25, 100, 250, 500, 1000, 2000];

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

const state = {
  lang: resolveInitialLang(),
  running: false,
  stopped: false,
  hasFinishedRun: false,
  hasPingStats: false,
  phase: 'idle',
  preset: 'full', // 'full' | 'quick' | 'latency'
  chartMode: 'throughput', // 'throughput' | 'ping'
  statusKey: 'statusReady',
  statusVars: null,
  statusRawError: '',
  gaugeStateKey: 'phaseIdle',
  gaugeValue: 0,
  gaugeUnitKey: 'unitMbps',
  gaugeColorMode: 'download',
  abortController: null,
  phaseControllers: new Set(),
  activeXhrs: new Set(),
  elapsedTimer: null,
  runStartedAt: 0,
  serverId: 'current',
  serverName: 'Węzeł główny',
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
  lastAnalysisMeta: null,
  lastProbeResults: null,
  chart: null
};

const el = (id) => document.getElementById(id);
const statusText = el('statusText');

function t(key, vars) {
  return I18n.t(state.lang, key, vars);
}

function fmt(v) {
  return D.formatMetric(v);
}

function setMetric(id, value) {
  const node = el(id);
  if (!node) return;
  node.textContent = fmt(value);
}

function setStatus(key, vars = null, rawError = '') {
  state.statusKey = key;
  state.statusVars = vars;
  state.statusRawError = rawError;
  if (statusText) {
    statusText.textContent = rawError ? rawError : t(key, vars);
  }
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

function setGauge(value, unitKey = 'unitMbps', phaseKey = 'phaseIdle', mode = 'download') {
  state.gaugeValue = value;
  state.gaugeUnitKey = unitKey;
  state.gaugeStateKey = phaseKey;
  state.gaugeColorMode = mode;

  const arc = el('gaugeArc');
  const valNode = el('gaugeValue');
  const unitNode = el('gaugeUnit');
  const phaseNode = el('gaugePhaseLabel');

  if (phaseNode) phaseNode.textContent = t(phaseKey);
  if (unitNode) unitNode.textContent = t(unitKey);
  if (valNode) {
    valNode.textContent = Number.isFinite(value) && value > 0 ? fmt(value) : '0.00';
  }
  if (arc) {
    arc.setAttribute('stroke', mode === 'upload' ? 'url(#gaugeUploadGrad)' : 'url(#gaugeDownloadGrad)');
    const ratio = unitKey === 'unitMs'
      ? Math.min(1, Math.max(0, (value || 0) / 150))
      : mbpsToGaugeRatio(value || 0);
    const offset = GAUGE_ARC_LEN * (1 - ratio);
    arc.style.strokeDashoffset = offset.toFixed(2);
  }
}

function setPhase(activePhase) {
  state.phase = activePhase;
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
  if (option?.dataset?.baseName) return option.dataset.baseName;
  const raw = option ? option.textContent : t('defaultNodeName');
  return raw.replace(/\s*\([^)]*\)$/, '');
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

let cachedServerInfo = null;

function renderServerOptionsText() {
  const select = el('serverSelect');
  if (!select) return;
  const summaries = [];

  for (const opt of Array.from(select.options)) {
    const baseName = opt.dataset.baseName || opt.textContent.replace(/\s*\([^)]*\)$/, '');
    opt.dataset.baseName = baseName;

    if (opt.disabled) {
      opt.textContent = `${baseName} ${t('needsConfig')}`;
    } else if (opt.dataset.probeMs) {
      opt.textContent = `${baseName} (${opt.dataset.probeMs} ms)`;
      summaries.push(`${baseName}: ${opt.dataset.probeMs} ms`);
    } else if (opt.dataset.probeFailed === 'true') {
      opt.textContent = `${baseName} (${t('noResponse')})`;
      summaries.push(`${baseName}: ${t('noResponse')}`);
    } else {
      opt.textContent = baseName;
    }
  }

  const hint = el('serverProbeResult');
  if (hint && state.lastProbeResults) {
    hint.textContent = summaries.join(' · ');
  }
}

function renderServerSpecs() {
  const specsEl = el('serverSpecsLine');
  const select = el('serverSelect');
  if (!specsEl || !select) return;
  const opt = select.options[select.selectedIndex];
  if (!opt) return;

  const parts = [];
  const host = opt.dataset.host || (opt.value === 'current' ? cachedServerInfo?.host : '');
  const location = opt.dataset.location || (opt.value === 'current' ? cachedServerInfo?.location : '');
  const provider = opt.dataset.provider || (opt.value === 'current' ? cachedServerInfo?.provider : '');
  const specs = opt.dataset.specs || (opt.value === 'current' && cachedServerInfo ? `${cachedServerInfo.protocol} · ${cachedServerInfo.cpuCount} vCPU · ${cachedServerInfo.randomPoolMb} MB CSPRNG` : '');

  if (host) parts.push(`${t('hostPrefix')}: ${host}`);
  else if (opt.dataset.url) {
    try { parts.push(`${t('hostPrefix')}: ${new URL(opt.dataset.url).host}`); } catch (e) {}
  }
  if (location) parts.push(`${t('locationPrefix')}: ${location}`);
  if (provider) parts.push(provider);
  if (specs) parts.push(specs);

  specsEl.innerHTML = parts
    .map((p, idx) => (idx > 0 ? `<span aria-hidden="true">·</span><span>${escapeHtml(p)}</span>` : `<span>${escapeHtml(p)}</span>`))
    .join('');
}

async function loadServers() {
  try {
    const res = await fetch('/api/servers');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (data.serverInfo) cachedServerInfo = data.serverInfo;
    const select = el('serverSelect');
    const prevValue = select.value;
    select.innerHTML = '';
    for (const s of data.servers) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.dataset.baseName = s.name;
      opt.textContent = s.configured ? s.name : `${s.name} ${t('needsConfig')}`;
      opt.disabled = !s.configured;
      opt.dataset.url = s.url || '';
      opt.dataset.host = s.host || '';
      opt.dataset.location = s.location || '';
      opt.dataset.provider = s.provider || '';
      opt.dataset.specs = s.specs || '';
      select.appendChild(opt);
    }
    if (prevValue && Array.from(select.options).some((o) => o.value === prevValue && !o.disabled)) {
      select.value = prevValue;
    } else {
      const current = data.servers.find((s) => s.id === 'current');
      if (current) select.value = 'current';
    }
    renderServerOptionsText();
    renderServerSpecs();
  } catch (e) {
    setStatus('statusServerErr');
  }
}

async function probeServers() {
  const btn = el('probeServersBtn');
  const hint = el('serverProbeResult');
  const select = el('serverSelect');
  if (!btn || !select) return;
  btn.disabled = true;
  if (hint) hint.textContent = t('statusProbing');

  try {
    const options = Array.from(select.options).filter((o) => !o.disabled);
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
      if (samples.length) {
        samples.sort((a, b) => a - b);
        const median = samples[Math.floor(samples.length / 2)];
        opt.dataset.probeMs = fmt(median);
        delete opt.dataset.probeFailed;
      } else {
        delete opt.dataset.probeMs;
        opt.dataset.probeFailed = 'true';
      }
    }
    state.lastProbeResults = true;
    renderServerOptionsText();
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
      setGauge(rtt, 'unitMs', 'gaugePing', 'download');
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
    const t0 = now();
    const totalReceived = streamBytes.reduce((a, b) => a + b, 0);
    const dt = (t0 - lastSampleTime) / 1000;
    const db = totalReceived - lastSampleBytes;
    if (dt > 0) {
      const instantMbps = D.computeMbps(db, dt);
      smoothedMbps = smoothedMbps > 0
        ? smoothedMbps * 0.45 + instantMbps * 0.55
        : instantMbps;
      const elapsedSec = (t0 - start) / 1000;
      const avgMbps = D.computeMbps(totalReceived, elapsedSec);
      const displayMbps = instantMbps > 0 ? smoothedMbps : avgMbps;

      state.downloadSamples.push({ t: elapsedSec, mbps: instantMbps > 0 ? instantMbps : avgMbps });
      setMetric('downloadValue', displayMbps);
      setGauge(displayMbps, 'unitMbps', 'phaseDownload', 'download');

      const pct = isAuto
        ? Math.min(1, (t0 - start) / targetDurationMs)
        : Math.min(1, totalReceived / sizeSpec.bytes);
      setProgress(15 + pct * 40, 'download');

      lastSampleTime = t0;
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
            throw new Error(t('statusDlHttpErr', { status: response.status }));
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
        reject(new Error(t('statusUlHttpErr', { status: xhr.status })));
      }
    };

    xhr.onerror = () => {
      cleanup();
      reject(new Error(t('statusUlNetErr')));
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
  const adaptiveChunkBytes = Math.max(512 * 1024, Math.min(32 * 1024 * 1024, Math.round(estStreamBytesPerSec * 1.2)));
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
    const t0 = now();
    const totalSent = totalTransferredSoFar();
    const dt = (t0 - lastSampleTime) / 1000;
    const db = Math.max(0, totalSent - lastSampleBytes);
    if (dt > 0) {
      const instantMbps = D.computeMbps(db, dt);
      smoothedMbps = smoothedMbps > 0
        ? smoothedMbps * 0.45 + instantMbps * 0.55
        : instantMbps;
      const elapsedSec = (t0 - start) / 1000;
      const avgMbps = D.computeMbps(totalSent, elapsedSec);
      const displayMbps = instantMbps > 0 ? smoothedMbps : avgMbps;

      state.uploadSamples.push({ t: elapsedSec, mbps: instantMbps > 0 ? instantMbps : avgMbps });
      setMetric('uploadValue', displayMbps);
      setGauge(displayMbps, 'unitMbps', 'phaseUpload', 'upload');

      const pct = isAuto
        ? Math.min(1, (t0 - start) / targetDurationMs)
        : Math.min(1, totalSent / sizeSpec.bytes);
      setProgress(55 + pct * 40, 'upload');

      lastSampleTime = t0;
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
          label: t('chartDlLabel'),
          data: [],
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59, 130, 246, 0.12)',
          borderWidth: 2,
          tension: 0.25,
          fill: true,
          pointRadius: 1.5
        },
        {
          label: t('chartUlLabel'),
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
          title: { display: true, text: t('chartPhaseTime'), color: '#94a3b8' },
          ticks: { color: '#94a3b8' },
          grid: { color: 'rgba(36, 48, 71, 0.5)' }
        },
        y: {
          beginAtZero: true,
          title: { display: true, text: t('unitMbps'), color: '#94a3b8' },
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
        label: t('chartRttLabel'),
        data: samples.map((v) => Number(v.toFixed(2))),
        backgroundColor: 'rgba(59, 130, 246, 0.65)',
        borderColor: '#3b82f6',
        borderWidth: 1,
        borderRadius: 4
      }
    ];
    state.chart.options.scales.x.title.text = t('chartSampleNum');
    state.chart.options.scales.y.title.text = t('unitMs');
    state.chart.update();
    return;
  }

  state.chart.config.type = 'line';
  const maxLen = Math.max(state.downloadSamples.length, state.uploadSamples.length);
  const labels = [];
  for (let i = 0; i < maxLen; i++) {
    const tVal = state.downloadSamples[i]?.t ?? state.uploadSamples[i]?.t ?? (i + 1) * 0.2;
    labels.push(tVal.toFixed(1));
  }
  state.chart.data.labels = labels;
  state.chart.data.datasets = [
    {
      label: t('chartDlLabel'),
      data: state.downloadSamples.map((s) => Number(s.mbps.toFixed(2))),
      borderColor: '#3b82f6',
      backgroundColor: 'rgba(59, 130, 246, 0.12)',
      borderWidth: 2,
      tension: 0.25,
      fill: true,
      pointRadius: 1.5
    },
    {
      label: t('chartUlLabel'),
      data: state.uploadSamples.map((s) => Number(s.mbps.toFixed(2))),
      borderColor: '#10b981',
      backgroundColor: 'rgba(16, 185, 129, 0.1)',
      borderWidth: 2,
      tension: 0.25,
      fill: true,
      pointRadius: 1.5
    }
  ];
  state.chart.options.scales.x.title.text = t('chartPhaseTime');
  state.chart.options.scales.y.title.text = t('unitMbps');
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

  if (!state.hasFinishedRun) {
    if (gradeBadge) {
      gradeBadge.textContent = t('gradeLabel', { grade: '--' });
      gradeBadge.className = 'grade-readout mono';
    }
    if (bloatSummary) {
      bloatSummary.textContent = t('bloatPrompt');
    }
    if (matrix) {
      matrix.innerHTML = `<div class="use-case-empty">${escapeHtml(t('useCaseEmpty'))}</div>`;
    }
    return;
  }

  const bloat = D.computeBufferbloatGrade(state.ping, state.loadedLatency, state.lang);
  if (gradeBadge) {
    gradeBadge.textContent = t('gradeLabel', { grade: bloat.grade });
    gradeBadge.className = `grade-readout mono ${bloat.status}`;
  }
  if (bloatSummary) {
    if (bloat.deltaMs !== null) {
      bloatSummary.textContent = `${bloat.label} (+${fmt(bloat.deltaMs)} ${t('unitMs')}) — ${bloat.detail}`;
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
    }, state.lang);
    if (!items.length) {
      matrix.innerHTML = `<div class="use-case-empty">${escapeHtml(t('useCaseEmpty'))}</div>`;
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

function renderMetricDetails() {
  if (!state.running && !state.hasPingStats && !state.hasFinishedRun) {
    el('downloadDetail').textContent = t('detailWaiting');
    el('uploadDetail').textContent = t('detailWaiting');
    el('pingDetail').textContent = t('detailPingIdle');
    el('jitterDetail').textContent = t('detailJitterIdle');
    el('loadedDetail').textContent = t('detailLoadedIdle');
    return;
  }

  if (state.hasPingStats && Number.isFinite(state.pingMin) && Number.isFinite(state.pingMax)) {
    el('pingDetail').textContent = `min ${fmt(state.pingMin)} · P95 ${fmt(state.pingP95)} · max ${fmt(state.pingMax)} ${t('unitMs')}`;
    el('jitterDetail').textContent = t('detailSampleLoss', { loss: state.packetLoss });
  } else if (state.running) {
    el('pingDetail').textContent = t('detailPingIdle');
    el('jitterDetail').textContent = t('detailJitterIdle');
  }

  if (state.hasFinishedRun && state.preset === 'latency') {
    el('downloadDetail').textContent = t('detailSkippedPing');
    el('uploadDetail').textContent = t('detailSkippedPing');
    el('loadedDetail').textContent = t('detailLoadedIdle');
    return;
  }

  el('downloadDetail').textContent = state.downloadBytes > 0
    ? t('detailTransferred', { mb: formatMB(state.downloadBytes) })
    : (state.running ? t('detailMeasuring') : t('detailWaiting'));

  el('uploadDetail').textContent = state.uploadBytes > 0
    ? t('detailUploaded', { mb: formatMB(state.uploadBytes) })
    : (state.running ? t('detailMeasuring') : t('detailWaiting'));

  if (Number.isFinite(state.loadedLatency) && Number.isFinite(state.ping)) {
    if (state.loadedUploadLatency !== null) {
      const bloatInfo = D.computeBufferbloatGrade(state.ping, state.loadedLatency, state.lang);
      const parts = [t('detailLoadedIncrease', { delta: fmt(bloatInfo.deltaMs), grade: bloatInfo.grade })];
      if (state.loadedDownloadLatency !== null) parts.push(t('detailLoadedDlShort', { dl: fmt(state.loadedDownloadLatency) }));
      parts.push(t('detailLoadedUlShort', { ul: fmt(state.loadedUploadLatency) }));
      el('loadedDetail').textContent = parts.join(' · ');
    } else if (state.loadedDownloadLatency !== null) {
      el('loadedDetail').textContent = t('detailLoadedDlOnly', { dl: fmt(state.loadedDownloadLatency) });
    }
  } else {
    el('loadedDetail').textContent = t('detailLoadedIdle');
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
  state.hasFinishedRun = false;
  state.hasPingStats = false;
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
  setGauge(0, 'unitMbps', 'gaugeInit', 'download');
  setPhase('ping');

  setMetric('downloadValue', null);
  setMetric('uploadValue', null);
  setMetric('pingValue', null);
  setMetric('jitterValue', null);
  setMetric('loadedValue', null);
  renderMetricDetails();
  renderLocalDiagnostics();

  el('startBtn').disabled = true;
  el('stopBtn').disabled = false;
  el('analyzeBtn').disabled = true;
  el('copySummaryBtn').disabled = true;
  startElapsedClock();

  try {
    const pingCount = Number(el('pingCountSelect')?.value || 20);
    setStatus('statusMeasuringPing', { count: pingCount });
    const pingResult = await measurePing(pingCount);
    state.ping = pingResult.ping;
    state.pingMin = pingResult.min;
    state.pingMax = pingResult.max;
    state.pingP95 = pingResult.p95;
    state.packetLoss = pingResult.packetLoss;
    state.jitter = pingResult.jitter;
    state.pingSamples = pingResult.samples;
    state.hasPingStats = true;

    setMetric('pingValue', state.ping);
    setMetric('jitterValue', state.jitter);
    renderMetricDetails();
    if (state.chartMode === 'ping') updateChart();

    if (state.preset !== 'latency') {
      checkAborted();
      setPhase('download');
      setStatus('statusMeasuringDl', { streams: state.streams });
      const dlSpec = parseSizeSpec(el('sizeSelect').value);
      const dl = await measureDownload(dlSpec, state.streams);
      state.downloadMbps = dl.mbps;
      state.downloadBytes = dl.bytes;
      state.loadedDownloadLatency = Number.isFinite(dl.loadedLatency) ? dl.loadedLatency : null;
      state.loadedLatency = dl.loadedLatency;
      setMetric('downloadValue', state.downloadMbps);
      setMetric('loadedValue', state.loadedLatency);
      renderMetricDetails();

      checkAborted();
      setPhase('upload');
      setStatus('statusMeasuringUl', { streams: state.streams });
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
      setMetric('loadedValue', state.loadedLatency);
      setGauge(state.downloadMbps, 'unitMbps', 'gaugeDownloadResult', 'download');
    } else {
      setGauge(state.ping, 'unitMs', 'gaugePingResult', 'download');
    }

    state.hasFinishedRun = true;
    renderMetricDetails();
    setProgress(100, 'download');
    setPhase('done');
    setStatus('statusFinished');
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
      setStatus('statusStopped');
      setPhase('idle');
      setGauge(0, 'unitMbps', 'gaugeStopped', 'download');
    } else {
      setStatus('statusTestErr', { err: e.message || e });
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
  const bloat = D.computeBufferbloatGrade(state.ping, state.loadedLatency, state.lang);
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
    sourceType: 'local',
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
  const bloat = D.computeBufferbloatGrade(state.ping, state.loadedLatency, state.lang);
  const lines = [
    t('summaryHeading', { date: new Date().toLocaleString(t('locale')) }),
    t('summaryServer', { server: state.serverName }),
    t('summaryDownload', { val: fmt(state.downloadMbps) }),
    t('summaryUpload', { val: fmt(state.uploadMbps) }),
    t('summaryPing', { val: fmt(state.ping), min: fmt(state.pingMin), p95: fmt(state.pingP95), max: fmt(state.pingMax) }),
    t('summaryJitter', { jitter: fmt(state.jitter), loss: state.packetLoss }),
    t('summaryLoaded', { val: fmt(state.loadedLatency), grade: bloat.grade })
  ];
  const ok = await copyToClipboard(lines.join('\n'));
  if (ok) {
    const btn = el('copySummaryBtn');
    btn.textContent = t('btnCopied');
    setTimeout(() => { btn.textContent = t('btnCopyResult'); }, 1500);
  }
}

function renderAnalysisMeta() {
  const meta = el('analysisMeta');
  if (!meta) return;
  if (!state.lastAnalysisMeta) {
    meta.textContent = '';
    return;
  }
  const { model, fallbackUsed, durationMs } = state.lastAnalysisMeta;
  const fallbackNote = fallbackUsed ? ' ' + t('aiMetaFallback') : '';
  const timeNote = Number.isFinite(durationMs) ? ` · ${durationMs} ms` : '';
  meta.textContent = `${t('aiMetaModel')}: ${model || 'Groq'}${fallbackNote}${timeNote}`;
}

async function analyze() {
  const btn = el('analyzeBtn');
  const copyBtn = el('copyAnalysisBtn');
  const meta = el('analysisMeta');
  btn.disabled = true;
  copyBtn.disabled = true;
  state.lastAnalysisMeta = null;
  meta.textContent = '';
  el('analysisText').textContent = t('aiRunning');

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
        useCase: el('useCaseSelect')?.value || 'general',
        lang: state.lang
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || t('statusAnalyzeErr'));
    state.lastAnalysisMarkdown = data.analysis || '';
    state.lastAnalysisMeta = {
      model: data.model,
      fallbackUsed: !!data.fallbackUsed,
      durationMs: data.durationMs
    };
    renderAnalysisMeta();
    el('analysisText').innerHTML = renderMarkdown(state.lastAnalysisMarkdown);
    copyBtn.disabled = !state.lastAnalysisMarkdown;
  } catch (e) {
    state.lastAnalysisMarkdown = '';
    el('analysisText').innerHTML = renderMarkdown(`${t('statusAnalyzeErr')}: ${e.message || e}`);
  } finally {
    btn.disabled = false;
  }
}

async function copyAnalysis() {
  const ok = await copyToClipboard(state.lastAnalysisMarkdown);
  if (ok) {
    const btn = el('copyAnalysisBtn');
    btn.textContent = t('btnCopied');
    setTimeout(() => { btn.textContent = t('aiCopyBtn'); }, 1500);
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

function applyLanguage(lang) {
  state.lang = I18n.normalizeLang(lang);
  try {
    localStorage.setItem(LANG_STORAGE_KEY, state.lang);
  } catch (e) {}

  document.documentElement.lang = state.lang;
  document.title = t('pageTitleIndex');

  const langSel = el('langSelect');
  if (langSel) langSel.value = state.lang;

  document.querySelectorAll('[data-i18n]').forEach((node) => {
    const key = node.dataset.i18n;
    if (node.id === 'analysisText' && state.lastAnalysisMarkdown) return;
    node.textContent = t(key);
  });

  document.querySelectorAll('[data-i18n-probes]').forEach((opt) => {
    opt.textContent = t('probesUnit', { n: opt.dataset.i18nProbes });
  });

  document.querySelectorAll('[data-i18n-fixed-mb]').forEach((opt) => {
    opt.textContent = t('modeFixed', { mb: opt.dataset.i18nFixedMb });
  });

  renderServerOptionsText();
  renderServerSpecs();
  setGauge(state.gaugeValue, state.gaugeUnitKey, state.gaugeStateKey, state.gaugeColorMode);
  setStatus(state.statusKey, state.statusVars, state.statusRawError);
  renderMetricDetails();
  renderLocalDiagnostics();
  renderAnalysisMeta();
  updateChart();
}

document.addEventListener('DOMContentLoaded', () => {
  initChart();
  applyLanguage(state.lang);
  loadServers();
  setPhase('idle');
  setGauge(0, 'unitMbps', 'phaseIdle', 'download');

  el('langSelect')?.addEventListener('change', (e) => applyLanguage(e.target.value));
  el('serverSelect')?.addEventListener('change', renderServerSpecs);
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
