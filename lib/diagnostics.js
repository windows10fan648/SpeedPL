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

  const BLOAT_COPY = {
    pl: {
      none: { label: 'Brak danych', detail: 'Pomiar opóźnienia pod obciążeniem nie został wykonany.' },
      'A+': { label: 'Wzrost minimalny', detail: 'Brak odczuwalnego bufferbloatu pod obciążeniem.' },
      A: { label: 'Bardzo stabilne', detail: 'Niewielki wzrost opóźnień podczas pełnego transferu.' },
      B: { label: 'Dobre zarządzanie kolejką', detail: 'Umiarkowany wzrost latencji przy obciążeniu.' },
      C: { label: 'Umiarkowany bufferbloat', detail: 'Przy jednoczesnym pobieraniu i grze ping może zauważalnie rosnąć.' },
      D: { label: 'Podwyższony bufferbloat', detail: 'Warto włączyć QoS / SQM na routerze dla płynnych wideorozmów.' },
      F: { label: 'Wysoki bufferbloat', detail: 'Kolejkowanie w routerze mocno podbija opóźnienia przy obciążeniu.' }
    },
    en: {
      none: { label: 'No data', detail: 'Loaded latency measurement was not performed.' },
      'A+': { label: 'Minimal increase', detail: 'Virtually zero perceptible bufferbloat under full load.' },
      A: { label: 'Very stable', detail: 'Slight latency rise during saturated transfer.' },
      B: { label: 'Good queue management', detail: 'Moderate latency increase under load.' },
      C: { label: 'Moderate bufferbloat', detail: 'Latency may rise noticeably when downloading and gaming simultaneously.' },
      D: { label: 'Elevated bufferbloat', detail: 'Consider enabling QoS / SQM on your router for smoother calls.' },
      F: { label: 'High bufferbloat', detail: 'Router queue buildup heavily inflates latency under traffic.' }
    },
    fr: {
      none: { label: 'Aucune donnée', detail: 'La mesure de latence sous charge n’a pas été effectuée.' },
      'A+': { label: 'Hausse minimale', detail: 'Quasi aucun bufferbloat perceptible à pleine charge.' },
      A: { label: 'Très stable', detail: 'Faible hausse de latence pendant un transfert saturé.' },
      B: { label: 'Bonne gestion de file', detail: 'Hausse modérée de la latence sous charge.' },
      C: { label: 'Bufferbloat modéré', detail: 'Le ping peut augmenter sensiblement lors de téléchargements et jeux simultanés.' },
      D: { label: 'Bufferbloat élevé', detail: 'Activez la QoS / SQM sur votre routeur pour des appels plus fluides.' },
      F: { label: 'Bufferbloat critique', detail: 'La file d’attente du routeur augmente fortement la latence sous charge.' }
    }
  };

  function pickLang(lang) {
    const code = String(lang || 'pl').toLowerCase().slice(0, 2);
    return BLOAT_COPY[code] ? code : 'pl';
  }

  function computeBufferbloatGrade(ping, loadedLatency, lang = 'pl') {
    const l = pickLang(lang);
    const copy = BLOAT_COPY[l];

    if (!Number.isFinite(ping) || !Number.isFinite(loadedLatency)) {
      return {
        deltaMs: null,
        grade: '--',
        status: 'neutral',
        label: copy.none.label,
        detail: copy.none.detail
      };
    }

    const deltaMs = Math.max(0, loadedLatency - ping);
    let grade = 'F';
    let status = 'bad';
    if (deltaMs < 5) { grade = 'A+'; status = 'good'; }
    else if (deltaMs < 15) { grade = 'A'; status = 'good'; }
    else if (deltaMs < 35) { grade = 'B'; status = 'good'; }
    else if (deltaMs < 75) { grade = 'C'; status = 'warn'; }
    else if (deltaMs < 150) { grade = 'D'; status = 'warn'; }

    return {
      deltaMs,
      grade,
      status,
      label: copy[grade].label,
      detail: copy[grade].detail
    };
  }

  const USE_CASE_COPY = {
    pl: {
      gaming: {
        title: 'Gry online',
        good: (p, j) => ({ statusLabel: 'Komfortowe', reason: `Ping ${p} ms, jitter ${j} ms` }),
        warn: (p) => ({ statusLabel: 'Dobre z uwagą', reason: `Ping ${p} ms; przy dużym ruchu w sieci opóźnienie może wzrosnąć.` }),
        badLoss: (loss, p) => ({ statusLabel: 'Wymagające', reason: `Wykryto stratę prób (${loss}%) lub wyższe opóźnienie (${p} ms).` }),
        badBloat: (b) => ({ statusLabel: 'Wymagające', reason: `Podwyższone opóźnienie lub bufferbloat (+${b} ms).` })
      },
      streaming: {
        title: 'Streaming 4K',
        good: (dl) => ({ statusLabel: 'Płynne 4K HDR', reason: `Pobieranie ${dl} Mb/s zapewnia duży zapas dla kilku strumieni 4K.` }),
        warn: (dl) => ({ statusLabel: '1 strumień 4K', reason: `Prędkość ${dl} Mb/s obsłuży pojedynczy strumień 4K bez równoległego pobierania.` }),
        bad: (dl) => ({ statusLabel: 'Lepsze 1080p', reason: `Prędkość ${dl} Mb/s wystarczy dla Full HD; 4K może wymagać buforowania.` })
      },
      remote_work: {
        title: 'Praca zdalna',
        good: (ul, j) => ({ statusLabel: 'Stabilne spotkania', reason: `Wysyłanie ${ul} Mb/s i jitter ${j} ms sprzyjają HD wideo.` }),
        warn: () => ({ statusLabel: 'Dobre solo', reason: 'Wystarczające do spotkań; duże pliki w tle mogą podbijać opóźnienie.' }),
        bad: (ul) => ({ statusLabel: 'Ograniczona kamera', reason: `Wysyłanie ${ul} Mb/s lub niestabilność może obniżać jakość obrazu.` })
      },
      cloud: {
        title: 'Chmura i backup',
        good: (ul) => ({ statusLabel: 'Szybki backup', reason: `Wysyłanie ${ul} Mb/s pozwala sprawnie przesyłać duże pliki.` }),
        warn: (ul) => ({ statusLabel: 'Umiarkowane', reason: `Wysyłanie ${ul} Mb/s pozwala wysyłać multimedia w rozsądnym czasie.` }),
        bad: (ul) => ({ statusLabel: 'Wolniejszy backup', reason: `Wysyłanie ${ul} Mb/s sprawdzi się do dokumentów, większe kopie potrwają dłużej.` })
      }
    },
    en: {
      gaming: {
        title: 'Online gaming',
        good: (p, j) => ({ statusLabel: 'Smooth', reason: `Ping ${p} ms, jitter ${j} ms` }),
        warn: (p) => ({ statusLabel: 'Fair with load', reason: `Ping ${p} ms; heavy household traffic may raise latency.` }),
        badLoss: (loss, p) => ({ statusLabel: 'Challenging', reason: `Sample loss (${loss}%) or higher ping (${p} ms) detected.` }),
        badBloat: (b) => ({ statusLabel: 'Challenging', reason: `Elevated latency or bufferbloat (+${b} ms).` })
      },
      streaming: {
        title: '4K streaming',
        good: (dl) => ({ statusLabel: 'Smooth 4K HDR', reason: `${dl} Mbps download gives ample headroom for multiple 4K streams.` }),
        warn: (dl) => ({ statusLabel: 'Single 4K stream', reason: `${dl} Mbps handles one 4K stream cleanly without parallel downloads.` }),
        bad: (dl) => ({ statusLabel: 'Best at 1080p', reason: `${dl} Mbps suits Full HD; 4K may require buffering.` })
      },
      remote_work: {
        title: 'Remote work',
        good: (ul, j) => ({ statusLabel: 'Reliable calls', reason: `${ul} Mbps upload and ${j} ms jitter support crisp HD video.` }),
        warn: () => ({ statusLabel: 'Good solo', reason: 'Fine for calls; large background uploads may raise latency.' }),
        bad: (ul) => ({ statusLabel: 'Limited video', reason: `${ul} Mbps upload or instability may reduce video quality.` })
      },
      cloud: {
        title: 'Cloud & backup',
        good: (ul) => ({ statusLabel: 'Fast backup', reason: `${ul} Mbps upload transfers large archives efficiently.` }),
        warn: (ul) => ({ statusLabel: 'Moderate', reason: `${ul} Mbps upload handles media backups in reasonable time.` }),
        bad: (ul) => ({ statusLabel: 'Slow backup', reason: `${ul} Mbps upload suits documents; large backups will take longer.` })
      }
    },
    fr: {
      gaming: {
        title: 'Jeux en ligne',
        good: (p, j) => ({ statusLabel: 'Confortable', reason: `Ping ${p} ms, gigue ${j} ms` }),
        warn: (p) => ({ statusLabel: 'Correct sous réserve', reason: `Ping ${p} ms ; un trafic parallèle peut augmenter la latence.` }),
        badLoss: (loss, p) => ({ statusLabel: 'Exigeant', reason: `Perte détectée (${loss}%) ou latence élevée (${p} ms).` }),
        badBloat: (b) => ({ statusLabel: 'Exigeant', reason: `Latence élevée ou bufferbloat (+${b} ms).` })
      },
      streaming: {
        title: 'Streaming 4K',
        good: (dl) => ({ statusLabel: '4K HDR fluide', reason: `${dl} Mbit/s en réception offre une large marge pour plusieurs flux 4K.` }),
        warn: (dl) => ({ statusLabel: '1 flux 4K', reason: `${dl} Mbit/s suffit pour un flux 4K sans téléchargement parallèle.` }),
        bad: (dl) => ({ statusLabel: 'Idéal en 1080p', reason: `${dl} Mbit/s convient au Full HD ; la 4K peut nécessiter du tampon.` })
      },
      remote_work: {
        title: 'Télétravail',
        good: (ul, j) => ({ statusLabel: 'Appels stables', reason: `${ul} Mbit/s en envoi et ${j} ms de gigue assurent une vidéo HD nette.` }),
        warn: () => ({ statusLabel: 'Correct en solo', reason: 'Suffisant pour les appels ; les gros envois peuvent augmenter le ping.' }),
        bad: (ul) => ({ statusLabel: 'Vidéo limitée', reason: `${ul} Mbit/s en envoi ou instabilité pouvant réduire la qualité vidéo.` })
      },
      cloud: {
        title: 'Cloud et sauvegarde',
        good: (ul) => ({ statusLabel: 'Sauvegarde rapide', reason: `${ul} Mbit/s en envoi permet de transférer rapidement de gros fichiers.` }),
        warn: (ul) => ({ statusLabel: 'Modéré', reason: `${ul} Mbit/s en envoi gère les médias dans un délai raisonnable.` }),
        bad: (ul) => ({ statusLabel: 'Sauvegarde lente', reason: `${ul} Mbit/s convient aux documents ; les gros volumes prendront plus de temps.` })
      }
    }
  };

  function evaluateUseCases(metrics, lang = 'pl') {
    const l = pickLang(lang);
    const copy = USE_CASE_COPY[l];

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

    if (Number.isFinite(ping)) {
      let status = 'good';
      let msg;
      if (packetLoss > 1 || ping > 70 || jitter > 20 || (bloat !== null && bloat > 90)) {
        status = 'bad';
        msg = packetLoss > 0
          ? copy.gaming.badLoss(packetLoss, formatMetric(ping))
          : copy.gaming.badBloat(formatMetric(bloat));
      } else if (ping > 35 || jitter > 8 || (bloat !== null && bloat > 35)) {
        status = 'warn';
        msg = copy.gaming.warn(formatMetric(ping));
      } else {
        msg = copy.gaming.good(formatMetric(ping), formatMetric(jitter));
      }
      results.push({ id: 'gaming', title: copy.gaming.title, status, statusLabel: msg.statusLabel, reason: msg.reason });
    }

    if (Number.isFinite(dl) && dl > 0) {
      let status = 'good';
      let msg;
      if (dl < 15) {
        status = 'bad';
        msg = copy.streaming.bad(formatMetric(dl));
      } else if (dl < 35) {
        status = 'warn';
        msg = copy.streaming.warn(formatMetric(dl));
      } else {
        msg = copy.streaming.good(formatMetric(dl));
      }
      results.push({ id: 'streaming', title: copy.streaming.title, status, statusLabel: msg.statusLabel, reason: msg.reason });
    }

    if (Number.isFinite(ul) && Number.isFinite(ping)) {
      let status = 'good';
      let msg;
      if (ul < 5 || packetLoss > 1 || jitter > 25) {
        status = 'bad';
        msg = copy.remote_work.bad(formatMetric(ul));
      } else if (ul < 15 || (bloat !== null && bloat > 50)) {
        status = 'warn';
        msg = copy.remote_work.warn();
      } else {
        msg = copy.remote_work.good(formatMetric(ul), formatMetric(jitter));
      }
      results.push({ id: 'remote_work', title: copy.remote_work.title, status, statusLabel: msg.statusLabel, reason: msg.reason });
    }

    if (Number.isFinite(ul) && ul > 0) {
      let status = 'good';
      let msg;
      if (ul < 10) {
        status = 'bad';
        msg = copy.cloud.bad(formatMetric(ul));
      } else if (ul < 30) {
        status = 'warn';
        msg = copy.cloud.warn(formatMetric(ul));
      } else {
        msg = copy.cloud.good(formatMetric(ul));
      }
      results.push({ id: 'cloud', title: copy.cloud.title, status, statusLabel: msg.statusLabel, reason: msg.reason });
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
