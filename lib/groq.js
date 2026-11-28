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
  const lang = ['pl', 'en', 'fr'].includes(String(m.lang || '').toLowerCase()) ? String(m.lang).toLowerCase() : 'pl';

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
      useCase,
      lang
    }
  };
}

function buildAnalysisPrompt(data) {
  const bufferbloatMs = Math.max(0, data.loadedLatency - data.ping);
  const lang = data.lang || 'pl';

  if (lang === 'en') {
    const lines = [
      'You are a warm, patient, supportive network assistant helping a user understand their SpeedPL test results.',
      'Rules:',
      '1. Do not alter, round, or recalculate the provided numeric measurements.',
      '2. Respond exclusively in English, concisely (max 220 words), in clean Markdown.',
      '3. Use a calm, encouraging tone without alarmist language.',
      '4. If loaded latency exceeds idle ping by >30 ms, calmly explain bufferbloat.',
      '',
      `Analysis priority: ${USE_CASE_LABELS[data.useCase] || USE_CASE_LABELS.general}`,
      '',
      'Use these exact Markdown headings:',
      '### Gentle Summary',
      '### Connection Stability',
      '### Best Suited For',
      '### Simple Next Steps',
      '',
      'Measured data:'
    ];
    if (data.serverName) lines.push(`- Test server: ${data.serverName}`);
    if (data.streams) lines.push(`- Parallel streams: ${Math.round(data.streams)}`);
    lines.push(`- Download: ${data.download} Mbps`);
    lines.push(`- Upload: ${data.upload} Mbps`);
    lines.push(`- Ping (median): ${data.ping} ms`);
    if (data.pingMin !== null && data.pingMax !== null) {
      const p95Part = data.pingP95 !== null ? `, P95: ${data.pingP95} ms` : '';
      lines.push(`- Ping range: min ${data.pingMin} ms, max ${data.pingMax} ms${p95Part}`);
    }
    lines.push(`- Jitter: ${data.jitter} ms`);
    if (data.packetLoss !== null) lines.push(`- Sample loss: ${data.packetLoss}%`);
    lines.push(`- Loaded latency (avg): ${data.loadedLatency} ms (+${bufferbloatMs.toFixed(1)} ms above idle ping)`);
    if (data.loadedDownloadLatency !== null) lines.push(`- Download loaded latency: ${data.loadedDownloadLatency} ms`);
    if (data.loadedUploadLatency !== null) lines.push(`- Upload loaded latency: ${data.loadedUploadLatency} ms`);
    return lines.join('\n');
  }

  if (lang === 'fr') {
    const lines = [
      'Vous êtes un assistant réseau bienveillant et pédagogue aidant l’utilisateur à comprendre ses résultats SpeedPL.',
      'Règles :',
      '1. Ne modifiez pas, n’arrondissez pas et ne recalculez pas les valeurs numériques fournies.',
      '2. Répondez uniquement en français, de manière concise (220 mots max), en Markdown propre.',
      '3. Adoptez un ton calme et rassurant.',
      '4. Si la latence sous charge dépasse le ping de >30 ms, expliquez calmement le bufferbloat.',
      '',
      `Priorité d’analyse : ${USE_CASE_LABELS[data.useCase] || USE_CASE_LABELS.general}`,
      '',
      'Utilisez exactement ces titres Markdown :',
      '### Résumé bienveillant',
      '### Stabilité de la connexion',
      '### Usages recommandés',
      '### Pistes simples d’amélioration',
      '',
      'Données mesurées :'
    ];
    if (data.serverName) lines.push(`- Serveur : ${data.serverName}`);
    if (data.streams) lines.push(`- Flux parallèles : ${Math.round(data.streams)}`);
    lines.push(`- Réception : ${data.download} Mbit/s`);
    lines.push(`- Envoi : ${data.upload} Mbit/s`);
    lines.push(`- Ping (médiane) : ${data.ping} ms`);
    if (data.pingMin !== null && data.pingMax !== null) {
      const p95Part = data.pingP95 !== null ? `, P95 : ${data.pingP95} ms` : '';
      lines.push(`- Plage ping : min ${data.pingMin} ms, max ${data.pingMax} ms${p95Part}`);
    }
    lines.push(`- Gigue : ${data.jitter} ms`);
    if (data.packetLoss !== null) lines.push(`- Perte : ${data.packetLoss}%`);
    lines.push(`- Latence sous charge (moy.) : ${data.loadedLatency} ms (+${bufferbloatMs.toFixed(1)} ms)`);
    if (data.loadedDownloadLatency !== null) lines.push(`- Latence en réception : ${data.loadedDownloadLatency} ms`);
    if (data.loadedUploadLatency !== null) lines.push(`- Latence en envoi : ${data.loadedUploadLatency} ms`);
    return lines.join('\n');
  }

  const lines = [
    'Jesteś życzliwym, cierpliwym i łagodnym asystentem sieciowym pomagającym użytkownikowi zrozumieć wyniki testu ze SpeedPL.',
    'Zasady:',
    '1. Nie zmieniaj, nie zaokrąglaj i nie przeliczaj podanych wartości liczbowych.',
    '2. Odpowiedz wyłącznie po polsku, zwięźle (maksymalnie 220 słów), w czystym Markdown.',
    '3. Pisz bardzo delikatnym, wspierającym i spokojnym tonem. Unikaj surowych, alarmujących lub przygnębiających ocen (nie używaj słów typu "słaba", "zła", "fatalna", "krytyczna"). Nawet przy niższych wynikach podkreśl, co działa dobrze, i przedstaw ewentualne ograniczenia łagodnie oraz z otuchą.',
    '4. Jeśli różnica między latencją pod obciążeniem a pingiem spoczynkowym jest większa (>30 ms), wyjaśnij to spokojnie i przystępnie jako zjawisko bufferbloat, bez straszenia użytkownika.',
    '',
    `Priorytet analizy: ${USE_CASE_LABELS[data.useCase] || USE_CASE_LABELS.general}`,
    '',
    'Użyj dokładnie tych sekcji Markdown:',
    '### Delikatne podsumowanie',
    '- Łagodna, wspierająca ocena (np. Bardzo komfortowe / Dobre na co dzień / Wystarczające do podstaw / Warto nieco wspomóc) oraz 1–2 ciepłe zdania wyjaśnienia.',
    '### Spokój i stabilność łącza',
    '- Przystępne omówienie pingu, jittera oraz opóźnień pod obciążeniem, z zaznaczeniem mocnych stron.',
    '### Do czego sprawdzi się najlepiej',
    '- Życzliwa wskazówka dla: **Streaming 4K**, **Gry online**, **Wideorozmowy**.',
    '### Łagodne sugestie na przyszłość',
    '- 2–3 proste, niewymagające presji kroki, które można wypróbować w wolnej chwili.',
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

  const systemByLang = {
    pl: 'Odpowiadasz po polsku w ciepłym, łagodnym, wspierającym i prostym tonie — bez straszenia i surowych ocen. Używaj wyłącznie poprawnego Markdown.',
    en: 'Respond in English in a warm, calm, supportive, and clear tone without harsh judgments. Use only valid Markdown.',
    fr: 'Répondez en français sur un ton calme, bienveillant et clair, sans jugements alarmistes. Utilisez uniquement du Markdown valide.'
  };

  async function requestModel(targetModel) {
    const completion = await groqClient.chat.completions.create({
      model: targetModel,
      messages: [
        { role: 'system', content: systemByLang[data.lang || 'pl'] || systemByLang.pl },
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
