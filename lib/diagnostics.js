(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SpeedPLDiagnostics = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function computeMbps(bytes, elapsedSeconds) {
    if (!Number.isFinite(bytes) || !Number.isFinite(elapsedSeconds) || bytes <= 0 || elapsedSeconds <= 0) {
      return 0;
    }
    return (bytes * 8) / (elapsedSeconds * 1e6);
  }

  function formatMetric(value) {
    if (value == null || value === '' || !Number.isFinite(Number(value))) return '--';
    const n = Number(value);
    if (n >= 100) return n.toFixed(0);
    if (n >= 10) return n.toFixed(1);
    return n.toFixed(2);
  }

  function computePingStats(rtts, failures = 0) {
    const valid = Array.isArray(rtts)
      ? rtts.filter((v) => Number.isFinite(v) && v >= 0)
      : [];
    const safeFailures = Number.isFinite(failures) && failures > 0 ? failures : 0;
    const attempted = valid.length + safeFailures;
    const packetLoss = attempted > 0 ? Math.round((safeFailures / attempted) * 1000) / 10 : 0;

    if (!valid.length) {
      return {
        ping: NaN,
        min: NaN,
        max: NaN,
        avg: NaN,
        p95: NaN,
        p99: NaN,
        jitter: NaN,
        packetLoss,
        samples: []
      };
    }

    const sorted = [...valid].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const ping = sorted.length % 2 === 1
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const avg = valid.reduce((sum, x) => sum + x, 0) / valid.length;
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * 0.95))];
    const p99 = sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * 0.99))];

    const deltas = [];
    for (let i = 1; i < valid.length; i++) {
      deltas.push(Math.abs(valid[i] - valid[i - 1]));
    }
    const jitter = deltas.length
      ? deltas.reduce((sum, d) => sum + d, 0) / deltas.length
      : 0;

    return {
      ping,
      min,
      max,
      avg,
      p95,
      p99,
      jitter,
      packetLoss,
      samples: [...valid]
    };
  }

  function computeBufferbloatGrade(ping, loadedLatency) {
    if (!Number.isFinite(ping) || !Number.isFinite(loadedLatency)) {
      return {
        deltaMs: null,
        grade: '--',
        status: 'neutral',
        label: 'Brak danych',
        detail: 'Pomiar opóźnienia pod obciążeniem nie został wykonany.'
      };
    }

    const deltaMs = Math.max(0, loadedLatency - ping);

    if (deltaMs < 5) {
      return {
        deltaMs,
        grade: 'A+',
        status: 'good',
        label: 'Wzrost minimalny',
        detail: 'Brak odczuwalnego bufferbloatu pod obciążeniem.'
      };
    }
    if (deltaMs < 15) {
      return {
        deltaMs,
        grade: 'A',
        status: 'good',
        label: 'Bardzo stabilne',
        detail: 'Niewielki wzrost opóźnień podczas pełnego transferu.'
      };
    }
    if (deltaMs < 35) {
      return {
        deltaMs,
        grade: 'B',
        status: 'good',
        label: 'Dobre zarządzanie kolejką',
        detail: 'Umiarkowany wzrost latencji przy obciążeniu.'
      };
    }
    if (deltaMs < 75) {
      return {
        deltaMs,
        grade: 'C',
        status: 'warn',
        label: 'Umiarkowany bufferbloat',
        detail: 'Przy jednoczesnym pobieraniu i grze ping może zauważalnie rosnąć.'
      };
    }
    if (deltaMs < 150) {
      return {
        deltaMs,
        grade: 'D',
        status: 'warn',
        label: 'Podwyższony bufferbloat',
        detail: 'Warto włączyć QoS / SQM na routerze dla płynnych wideorozmów.'
      };
    }
    return {
      deltaMs,
      grade: 'F',
      status: 'bad',
      label: 'Wysoki bufferbloat',
      detail: 'Kolejkowanie w routerze mocno podbija opóźnienia przy obciążeniu.'
    };
  }

  function evaluateUseCases(metrics) {
    const dl = Number(metrics?.downloadMbps);
    const ul = Number(metrics?.uploadMbps);
    const ping = Number(metrics?.ping);
    const jitter = Number(metrics?.jitter);
    const packetLoss = Number.isFinite(Number(metrics?.packetLoss)) ? Number(metrics.packetLoss) : 0;
    const loadedLatency = Number(metrics?.loadedLatency);
    const bloat = Number.isFinite(ping) && Number.isFinite(loadedLatency)
      ? Math.max(0, loadedLatency - ping)
      : null;

    const results = [];

    // 1. Gaming
    if (Number.isFinite(ping)) {
      let status = 'good';
      let statusLabel = 'Komfortowe';
      let reason = `Ping ${formatMetric(ping)} ms, jitter ${formatMetric(jitter)} ms`;
      if (packetLoss > 1 || ping > 70 || jitter > 20 || (bloat !== null && bloat > 90)) {
        status = 'bad';
        statusLabel = 'Wymagające';
        reason = packetLoss > 0
          ? `Wykryto stratę prób (${packetLoss}%) lub wyższe opóźnienie (${formatMetric(ping)} ms).`
          : `Podwyższone opóźnienie lub bufferbloat (+${formatMetric(bloat)} ms).`;
      } else if (ping > 35 || jitter > 8 || (bloat !== null && bloat > 35)) {
        status = 'warn';
        statusLabel = 'Dobre z uwagą';
        reason = `Ping ${formatMetric(ping)} ms; przy dużym ruchu w sieci opóźnienie może wzrosnąć.`;
      }
      results.push({ id: 'gaming', title: 'Gry online', status, statusLabel, reason });
    }

    // 2. Streaming 4K
    if (Number.isFinite(dl) && dl > 0) {
      let status = 'good';
      let statusLabel = 'Płynne 4K HDR';
      let reason = `Pobieranie ${formatMetric(dl)} Mb/s zapewnia duży zapas dla kilku strumieni 4K.`;
      if (dl < 15) {
        status = 'bad';
        statusLabel = 'Lepsze 1080p';
        reason = `Prędkość ${formatMetric(dl)} Mb/s wystarczy dla Full HD; 4K może wymagać buforowania.`;
      } else if (dl < 35) {
        status = 'warn';
        statusLabel = '1 strumień 4K';
        reason = `Prędkość ${formatMetric(dl)} Mb/s obsłuży pojedynczy strumień 4K bez równoległego pobierania.`;
      }
      results.push({ id: 'streaming', title: 'Streaming 4K', status, statusLabel, reason });
    }

    // 3. Remote work / Video calls
    if (Number.isFinite(ul) && Number.isFinite(ping)) {
      let status = 'good';
      let statusLabel = 'Stabilne spotkania';
      let reason = `Wysyłanie ${formatMetric(ul)} Mb/s i jitter ${formatMetric(jitter)} ms sprzyjają HD wideo.`;
      if (ul < 5 || packetLoss > 1 || jitter > 25) {
        status = 'bad';
        statusLabel = 'Ograniczona kamera';
        reason = `Wysyłanie ${formatMetric(ul)} Mb/s lub niestabilność może obniżać jakość obrazu.`;
      } else if (ul < 15 || (bloat !== null && bloat > 50)) {
        status = 'warn';
        statusLabel = 'Dobre solo';
        reason = `Wystarczające do spotkań; duże pliki w tle mogą podbijać opóźnienie.`;
      }
      results.push({ id: 'remote_work', title: 'Praca zdalna', status, statusLabel, reason });
    }

    // 4. Cloud backups & large uploads
    if (Number.isFinite(ul) && ul > 0) {
      let status = 'good';
      let statusLabel = 'Szybki backup';
      let reason = `Wysyłanie ${formatMetric(ul)} Mb/s pozwala sprawnie przesyłać duże pliki.`;
      if (ul < 10) {
        status = 'bad';
        statusLabel = 'Wolniejszy backup';
        reason = `Wysyłanie ${formatMetric(ul)} Mb/s sprawdzi się do dokumentów, większe kopie potrwają dłużej.`;
      } else if (ul < 30) {
        status = 'warn';
        statusLabel = 'Umiarkowane';
        reason = `Wysyłanie ${formatMetric(ul)} Mb/s pozwala wysyłać multimedia w rozsądnym czasie.`;
      }
      results.push({ id: 'cloud', title: 'Chmura i backup', status, statusLabel, reason });
    }

    return results;
  }

  return {
    computeMbps,
    formatMetric,
    computePingStats,
    computeBufferbloatGrade,
    evaluateUseCases
  };
});
