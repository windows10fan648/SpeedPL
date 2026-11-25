const USE_CASE_LABELS = {
  general: 'Ogólna ocena połączenia',
  gaming: 'Gry online (priorytet: niski ping, niski jitter, brak utraty pakietów i niski bufferbloat)',
  streaming: 'Streaming 4K / VOD (priorytet: wysoka i stabilna prędkość pobierania)',
  remote_work: 'Praca zdalna i wideorozmowy (priorytet: stabilne wysyłanie, niski jitter i niska latencja pod obciążeniem)'
};

function resolveGroqBaseUrl(apiUrl) {
  const fallback = 'https://api.groq.com';
  if (!apiUrl) return fallback;
  try {
    return new URL(apiUrl).origin;
  } catch (e) {
    return fallback;
  }
}

function optionalFinite(value, min = 0) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) return null;
  return n;
}

function parseAnalyzePayload(body) {
  const m = body || {};
  const required = {
    download: Number(m.download),
    upload: Number(m.upload),
    ping: Number(m.ping),
    jitter: Number(m.jitter),
    loadedLatency: Number(m.loadedLatency)
  };
  for (const v of Object.values(required)) {
    if (!Number.isFinite(v) || v < 0) {
      return { error: 'Invalid measurements.' };
    }
  }

  const useCase = USE_CASE_LABELS[m.useCase] ? m.useCase : 'general';
  const serverName = typeof m.serverName === 'string' ? m.serverName.trim().slice(0, 80) : '';

  return {
    data: {
      ...required,
      pingMin: optionalFinite(m.pingMin),
      pingMax: optionalFinite(m.pingMax),
      pingP95: optionalFinite(m.pingP95),
      packetLoss: optionalFinite(m.packetLoss),
      loadedDownloadLatency: optionalFinite(m.loadedDownloadLatency),
      loadedUploadLatency: optionalFinite(m.loadedUploadLatency),
      downloadBytes: optionalFinite(m.downloadBytes),
      uploadBytes: optionalFinite(m.uploadBytes),
      streams: optionalFinite(m.streams, 1),
      serverName,
      useCase
    }
  };
}

function buildAnalysisPrompt(data) {
  const bufferbloatMs = Math.max(0, data.loadedLatency - data.ping);
  const lines = [
    'Jesteś ekspertem sieciowym oceniającym jakość połączenia internetowego na podstawie rzeczywistych pomiarów ze SpeedPL.',
    'Zasady:',
    '1. Nie zmieniaj, nie zaokrąglaj i nie przeliczaj podanych wartości liczbowych.',
    '2. Odpowiedz wyłącznie po polsku, zwięźle (maksymalnie 220 słów), w czystym Markdown.',
    '3. Jeśli wskaźnik bufferbloat (różnica między latencją pod obciążeniem a pingiem spoczynkowym) jest wysoki (>30 ms), wyraźnie to wskaż.',
    '',
    `Priorytet analizy: ${USE_CASE_LABELS[data.useCase] || USE_CASE_LABELS.general}`,
    '',
    'Użyj dokładnie tych sekcji Markdown:',
    '### Ocena ogólna',
    '- Werdykt (Bardzo dobra / Dobra / Średnia / Słaba) oraz 1–2 krótkie zdania podsumowania.',
    '### Bufferbloat i stabilność',
    '- Krótka ocena pingu, jittera oraz wzrostu opóźnień pod obciążeniem.',
    '### Przydatność do zastosowań',
    '- Krótka ocena dla: **Streaming 4K**, **Gry online**, **Wideorozmowy**.',
    '### Rekomendacje',
    '- 2–3 konkretne, praktyczne wskazówki dopasowane do tych wyników.',
    '',
    'Zmierzone dane:'
  ];

  if (data.serverName) lines.push(`- Serwer testowy: ${data.serverName}`);
  if (data.streams) lines.push(`- Równoległe strumienie: ${Math.round(data.streams)}`);
  lines.push(`- Pobieranie: ${data.download} Mb/s`);
  lines.push(`- Wysyłanie: ${data.upload} Mb/s`);
  lines.push(`- Ping (mediana): ${data.ping} ms`);
  if (data.pingMin !== null && data.pingMax !== null) {
    const p95Part = data.pingP95 !== null ? `, P95: ${data.pingP95} ms` : '';
    lines.push(`- Zakres pingu: min ${data.pingMin} ms, max ${data.pingMax} ms${p95Part}`);
  }
  lines.push(`- Jitter: ${data.jitter} ms`);
  if (data.packetLoss !== null) lines.push(`- Utrata pakietów (próby): ${data.packetLoss}%`);
  lines.push(`- Latencja pod obciążeniem (średnia): ${data.loadedLatency} ms (wzrost o +${bufferbloatMs.toFixed(1)} ms względem pingu)`);
  if (data.loadedDownloadLatency !== null) {
    lines.push(`- Latencja podczas pobierania: ${data.loadedDownloadLatency} ms`);
  }
  if (data.loadedUploadLatency !== null) {
    lines.push(`- Latencja podczas wysyłania: ${data.loadedUploadLatency} ms`);
  }

  return lines.join('\n');
}

function shouldFallback(err) {
  const status = err?.status || err?.statusCode;
  if (status === 401 || status === 403) return false;
  return status === 404 || status === 429 || (status >= 500 && status < 600) || /model/i.test(err?.message || '');
}

function formatGroqError(err) {
  const status = err?.status || err?.statusCode;
  const msg = err?.message || 'nieznany błąd';
  if (status === 401 || status === 403) {
    return { httpStatus: 502, error: 'Błąd autoryzacji Groq API (sprawdź GROQ_API_KEY).' };
  }
  if (status === 429) {
    return { httpStatus: 429, error: 'Przekroczono limit zapytań Groq API. Spróbuj ponownie za chwilę.' };
  }
  if (/timeout|timed out|abort/i.test(msg)) {
    return { httpStatus: 504, error: 'Przekroczono czas oczekiwania na odpowiedź Groq AI.' };
  }
  return { httpStatus: 502, error: 'Żądanie Groq nie powiodło się: ' + msg };
}

async function analyzeWithGroq({ groqClient, data, model, fallbackModel }) {
  const prompt = buildAnalysisPrompt(data);
  const startedAt = Date.now();

  async function requestModel(targetModel) {
    const completion = await groqClient.chat.completions.create({
      model: targetModel,
      messages: [
        { role: 'system', content: 'Odpowiadasz po polsku, rzeczowo, krótko i wyłącznie w poprawnym Markdown.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.25,
      max_tokens: 550
    });
    return completion?.choices?.[0]?.message?.content?.trim() || 'Brak odpowiedzi modelu.';
  }

  try {
    const analysis = await requestModel(model);
    return {
      analysis,
      model,
      fallbackUsed: false,
      durationMs: Date.now() - startedAt
    };
  } catch (err) {
    if (fallbackModel && fallbackModel !== model && shouldFallback(err)) {
      const analysis = await requestModel(fallbackModel);
      return {
        analysis,
        model: fallbackModel,
        fallbackUsed: true,
        durationMs: Date.now() - startedAt
      };
    }
    throw err;
  }
}

module.exports = {
  USE_CASE_LABELS,
  resolveGroqBaseUrl,
  parseAnalyzePayload,
  buildAnalysisPrompt,
  formatGroqError,
  analyzeWithGroq
};
