const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Minimal .env loader (no extra dependency).
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnv();

const express = require('express');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const Groq = require('groq-sdk');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

// ---- Database (optional): PostgreSQL or MySQL/TiDB when mysql2 is installed ----
let dbType = null; // 'pg' | 'mysql'
let pgPool = null;
let mysqlPool = null;
let dbReady = false;

const pgUrl = process.env.DATABASE_URL && !/^mysql:\/\//i.test(process.env.DATABASE_URL)
  ? process.env.DATABASE_URL
  : null;
const mysqlUrl = process.env.MYSQL_URL || process.env.TIDB_DATABASE_URL ||
  (/^mysql:\/\//i.test(process.env.DATABASE_URL || '') ? process.env.DATABASE_URL : null);

if (pgUrl) {
  dbType = 'pg';
  pgPool = new Pool({
    connectionString: pgUrl,
    ssl: pgUrl.includes('localhost') ? false : { rejectUnauthorized: false }
  });
  pgPool.query(`
    CREATE TABLE IF NOT EXISTS speed_tests (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      server_id TEXT NOT NULL,
      download_mbps DOUBLE PRECISION,
      upload_mbps DOUBLE PRECISION,
      ping_ms DOUBLE PRECISION,
      jitter_ms DOUBLE PRECISION,
      loaded_latency_ms DOUBLE PRECISION,
      download_bytes BIGINT,
      upload_bytes BIGINT
    )
  `).then(() => { dbReady = true; })
    .catch((err) => { console.error('Database init failed:', err.message); });
} else if (mysqlUrl) {
  let mysql;
  try {
    mysql = require('mysql2/promise');
  } catch (err) {
    console.error('mysql2 is not installed; TiDB/MySQL history disabled:', err.message);
  }
  if (mysql) {
    dbType = 'mysql';
    mysqlPool = mysql.createPool(mysqlUrl);
    mysqlPool.query(`
      CREATE TABLE IF NOT EXISTS speed_tests (
        id INT AUTO_INCREMENT PRIMARY KEY,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        server_id VARCHAR(64) NOT NULL,
        download_mbps DOUBLE NULL,
        upload_mbps DOUBLE NULL,
        ping_ms DOUBLE NULL,
        jitter_ms DOUBLE NULL,
        loaded_latency_ms DOUBLE NULL,
        download_bytes BIGINT NULL,
        upload_bytes BIGINT NULL
      )
    `).then(() => { dbReady = true; })
      .catch((err) => { console.error('Database init failed:', err.message); });
  }
}

function dbEnabled() {
  return dbReady && ((dbType === 'pg' && pgPool) || (dbType === 'mysql' && mysqlPool));
}

// ---- Polish city nodes (disabled until configured) ----
const DEFAULT_CITIES = ['Warszawa', 'Kraków', 'Gdańsk', 'Wrocław', 'Poznań']
  .map((name) => {
    const id = name.toLowerCase()
      .replace(/ą/g, 'a').replace(/ć/g, 'c').replace(/ę/g, 'e')
      .replace(/ł/g, 'l').replace(/ń/g, 'n').replace(/ó/g, 'o')
      .replace(/ś/g, 's').replace(/ź/g, 'z').replace(/ż/g, 'z');
    return { id, name, url: null, configured: false };
  });

let configuredServers = [];
try {
  if (process.env.SPEEDPL_SERVERS) {
    const parsed = JSON.parse(process.env.SPEEDPL_SERVERS);
    if (Array.isArray(parsed)) configuredServers = parsed;
  }
} catch (err) {
  console.error('Invalid SPEEDPL_SERVERS JSON:', err.message);
}

const servers = [
  { id: 'current', name: process.env.SERVER_NAME || 'Serwer biezacy', url: null, configured: true }
];
for (const city of DEFAULT_CITIES) {
  const override = configuredServers.find((s) => s && s.id === city.id);
  servers.push(override ? { ...city, ...override, configured: !!override.url } : city);
}
// Add any extra configured servers not in default list.
for (const s of configuredServers) {
  if (s && s.id && !servers.some((x) => x.id === s.id)) {
    servers.push({ id: s.id, name: s.name || s.id, url: s.url || null, configured: !!s.url });
  }
}

function serverBase(serverId) {
  const server = servers.find((s) => s.id === serverId) || servers[0];
  if (!server || !server.url) return '';
  return String(server.url).replace(/\/+$/, '');
}

// ---- Middleware ----
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/chart.js', express.static(path.join(__dirname, 'node_modules', 'chart.js', 'dist')));

// Permissive CORS for speed endpoints so configured remote nodes can be tested.
app.use('/api', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.set('trust proxy', 1);

const pingLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, message: { error: 'Too many ping requests.' } });
const downloadLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, message: { error: 'Too many download tests.' } });
const uploadLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, message: { error: 'Too many upload tests.' } });
const analyzeLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, message: { error: 'Too many AI analysis requests.' } });
const historyReadLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, message: { error: 'Too many history requests.' } });
const historyWriteLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, message: { error: 'Too many history writes.' } });

// ---- Routes ----
app.get('/', (req, res) => {
  res.render('index', { servers });
});

app.get('/api/servers', (req, res) => {
  res.json({ servers });
});

app.get('/api/ping', pingLimiter, (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.json({ now: Date.now() });
});

// Download: streams cryptographically random bytes.
app.get('/api/download', downloadLimiter, async (req, res) => {
  const requested = Number(req.query.bytes);
  const bytes = Math.min(Math.max(Number.isFinite(requested) ? requested : 16 * 1024 * 1024, 1 * 1024 * 1024), 64 * 1024 * 1024);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Content-Length', String(bytes));
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const chunkSize = 64 * 1024;
  let remaining = bytes;
  let aborted = false;
  req.on('close', () => { aborted = true; });

  try {
    while (remaining > 0 && !aborted && !res.writableEnded) {
      const size = Math.min(chunkSize, remaining);
      const chunk = crypto.randomBytes(size);
      const ok = res.write(chunk);
      remaining -= size;
      if (!ok) {
        await new Promise((resolve) => res.once('drain', resolve));
      }
    }
    if (!aborted && !res.writableEnded) res.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).end();
    else if (!res.writableEnded) res.end();
  }
});

// Upload: discards body and reports received byte count.
app.post('/api/upload', uploadLimiter, (req, res) => {
  let received = 0;
  let aborted = false;
  req.on('data', (chunk) => {
    received += chunk.length;
    if (received > 128 * 1024 * 1024) {
      aborted = true;
      req.destroy();
    }
  });
  req.on('end', () => {
    if (aborted) return;
    res.json({ received });
  });
  req.on('error', (err) => {
    if (!res.headersSent) res.status(400).json({ error: err.message });
  });
});

// AI analysis (backend only).
app.post('/api/analyze', analyzeLimiter, async (req, res) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'GROQ_API_KEY is not configured.' });
  }
  const m = req.body || {};
  const nums = {
    download: Number(m.download),
    upload: Number(m.upload),
    ping: Number(m.ping),
    jitter: Number(m.jitter),
    loadedLatency: Number(m.loadedLatency)
  };
  for (const v of Object.values(nums)) {
    if (!Number.isFinite(v) || v < 0) {
      return res.status(400).json({ error: 'Invalid measurements.' });
    }
  }

  const model = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
  const apiUrl = process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1/chat/completions';
  let baseUrl = 'https://api.groq.com';
  try { baseUrl = new URL(apiUrl).origin; } catch (e) {}

  const groq = new Groq({ apiKey, baseURL: baseUrl });

  const prompt = [
    'Jestes asystentem oceniajacym jakosc polaczenia internetowego na podstawie rzeczywistych pomiarow.',
    'Nie zmieniaj, nie zaokraglaj i nie przeliczaj podanych wartosci. Analizuj je takimi, jakie sa.',
    'Kazde zdanie zaczynaj od nowej linii.',
    'Odpowiedz po polsku, krotko (max 180 slow), w punktach:',
    '- Ogolna ocena jakosci (bardzo dobra/dobra/srednia/slaba).',
    '- Co oznaczaja wyniki dla uzytkownika.',
    '- 2-3 praktyczne rekomendacje.',
    '',
    'Pomiary:',
    `Pobieranie: ${nums.download} Mb/s`,
    `Wysylanie: ${nums.upload} Mb/s`,
    `Ping: ${nums.ping} ms`,
    `Jitter: ${nums.jitter} ms`,
    `Latencja pod obciazeniem: ${nums.loadedLatency} ms`
  ].join('\n');

  try {
    const completion = await groq.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: 'Odpowiadasz po polsku, rzeczowo i krotko.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 400
    });
    let analysis = completion?.choices?.[0]?.message?.content?.trim() || 'Brak odpowiedzi modelu.';
    analysis = analysis.replace(/([.!?])\\s+(?=[A-ZĄĆĘŁŃÓŚŹŻ])/g, '$1\\n');
    res.json({ analysis, model });
  } catch (err) {
    res.status(502).json({ error: 'Groq request failed: ' + (err.message || 'unknown error') });
  }
});

// History (optional).
app.get('/api/history', historyReadLimiter, async (req, res) => {
  if (!dbEnabled()) return res.json({ enabled: false, items: [] });
  try {
    const sql = 'SELECT id, created_at, server_id, download_mbps, upload_mbps, ping_ms, jitter_ms, loaded_latency_ms FROM speed_tests ORDER BY created_at DESC LIMIT 25';
    const rows = dbType === 'pg'
      ? (await pgPool.query(sql)).rows
      : (await mysqlPool.query(sql))[0];
    res.json({ enabled: true, items: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/history', historyWriteLimiter, async (req, res) => {
  if (!dbEnabled()) return res.status(503).json({ error: 'Database not configured.' });
  const b = req.body || {};
  const serverId = String(b.serverId || 'current').slice(0, 64);
  const values = [
    serverId,
    finiteOrNull(b.download), finiteOrNull(b.upload), finiteOrNull(b.ping),
    finiteOrNull(b.jitter), finiteOrNull(b.loadedLatency),
    finiteOrNull(b.downloadBytes, true), finiteOrNull(b.uploadBytes, true)
  ];
  try {
    if (dbType === 'pg') {
      const result = await pgPool.query(
        `INSERT INTO speed_tests (server_id, download_mbps, upload_mbps, ping_ms, jitter_ms, loaded_latency_ms, download_bytes, upload_bytes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, created_at`,
        values
      );
      res.json({ ok: true, id: result.rows[0].id, createdAt: result.rows[0].created_at });
    } else {
      const [result] = await mysqlPool.query(
        `INSERT INTO speed_tests (server_id, download_mbps, upload_mbps, ping_ms, jitter_ms, loaded_latency_ms, download_bytes, upload_bytes)
         VALUES (?,?,?,?,?,?,?,?)`,
        values
      );
      res.json({ ok: true, id: result.insertId, createdAt: new Date().toISOString() });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function finiteOrNull(value, integer = false) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return integer ? Math.round(n) : n;
}

app.listen(PORT, HOST, () => {
  console.log(`SpeedPL listening on http://${HOST}:${PORT}`);
});