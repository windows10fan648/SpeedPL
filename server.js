const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
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
const {
  resolveGroqBaseUrl,
  parseAnalyzePayload,
  formatGroqError,
  analyzeWithGroq
} = require('./lib/groq');

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

const rawDbUrl = process.env.DATABASE_URL || '';
const explicitPg = /^postgres(ql)?:\/\//i.test(rawDbUrl);
const explicitMysql = /^mysql2?:\/\//i.test(rawDbUrl) || /^tidb:\/\//i.test(rawDbUrl);
const looksLikeTiDB = /tidb|:4000\b/i.test(rawDbUrl);
const useDbParts = !!process.env.DB_HOST;

let pgUrl = null;
let mysqlUrl = process.env.MYSQL_URL || process.env.TIDB_DATABASE_URL || null;

if (rawDbUrl) {
  if (explicitPg) {
    pgUrl = rawDbUrl;
  } else if (explicitMysql || looksLikeTiDB) {
    mysqlUrl = mysqlUrl || rawDbUrl.replace(/^tidb:\/\//i, 'mysql://');
  } else if (!mysqlUrl && !explicitPg) {
    // Ambiguous URL: prefer MySQL/TiDB when mysql2 is available, otherwise PostgreSQL.
    try {
      require.resolve('mysql2/promise');
      mysqlUrl = rawDbUrl;
    } catch (e) {
      pgUrl = rawDbUrl;
    }
  } else {
    pgUrl = rawDbUrl;
  }
}

// Normalize TiDB scheme.
if (mysqlUrl) mysqlUrl = mysqlUrl.replace(/^tidb:\/\//i, 'mysql://');

if (useDbParts) {
  pgUrl = null;
  mysqlUrl = null;
}

if (pgUrl) {
  try {
    dbType = 'pg';
    pgPool = new Pool({
      connectionString: pgUrl,
      ssl: pgUrl.includes('localhost') ? false : { rejectUnauthorized: false }
    });
    pgPool.on('error', (err) => {
      console.error('Database pool error:', err.message);
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
  } catch (err) {
    console.error('Database config failed:', err.message);
    pgPool = null;
    dbType = null;
  }
} else if (mysqlUrl || useDbParts) {
  let mysql;
  try {
    mysql = require('mysql2/promise');
  } catch (err) {
    console.error('mysql2 is not installed; TiDB/MySQL history disabled:', err.message);
  }
  if (mysql) {
    try {
      dbType = 'mysql';
      let mysqlPoolOptions;
      if (useDbParts) {
        mysqlPoolOptions = {
          host: process.env.DB_HOST,
          port: Number(process.env.DB_PORT || 4000),
          user: process.env.DB_USERNAME,
          password: process.env.DB_PASSWORD,
          database: process.env.DB_DATABASE,
          ssl: { rejectUnauthorized: false },
          waitForConnections: true,
          connectionLimit: 10
        };
      } else {
        mysqlPoolOptions = looksLikeTiDB
          ? { uri: mysqlUrl, ssl: { rejectUnauthorized: false } }
          : mysqlUrl;
      }
      mysqlPool = mysql.createPool(mysqlPoolOptions);
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
    } catch (err) {
      console.error('Database config failed:', err.message);
      mysqlPool = null;
      dbType = null;
    }
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

const DEFAULT_SERVER_LOCATION = process.env.SERVER_LOCATION || process.env.RENDER_REGION || '';
const DEFAULT_SERVER_PROVIDER = process.env.SERVER_PROVIDER || (process.env.RENDER ? 'Render' : '');
const DEFAULT_SERVER_NAME = process.env.SERVER_NAME || (DEFAULT_SERVER_LOCATION ? `Węzeł (${DEFAULT_SERVER_LOCATION})` : 'Węzeł główny');

function buildServerInfo(req) {
  const host = process.env.PUBLIC_HOST || (req && typeof req.get === 'function' ? req.get('host') : '') || 'localhost';
  const protocol = req && req.protocol ? String(req.protocol).toUpperCase() : 'HTTP';
  const cpuCount = os.cpus().length || 1;
  return {
    name: DEFAULT_SERVER_NAME,
    host,
    protocol,
    location: DEFAULT_SERVER_LOCATION || null,
    provider: DEFAULT_SERVER_PROVIDER || null,
    cpuCount,
    nodeVersion: process.version,
    randomPoolMb: 4
  };
}

const servers = [
  {
    id: 'current',
    name: DEFAULT_SERVER_NAME,
    location: DEFAULT_SERVER_LOCATION || null,
    provider: DEFAULT_SERVER_PROVIDER || null,
    specs: `${os.cpus().length || 1} vCPU · 4 MB CSPRNG`,
    url: null,
    configured: true
  }
];
for (const city of DEFAULT_CITIES) {
  const override = configuredServers.find((s) => s && s.id === city.id);
  servers.push(override
    ? {
        ...city,
        ...override,
        location: override.location || city.name,
        specs: override.specs || null,
        configured: !!override.url
      }
    : city);
}
// Add any extra configured servers not in default list.
for (const s of configuredServers) {
  if (s && s.id && !servers.some((x) => x.id === s.id)) {
    servers.push({
      id: s.id,
      name: s.name || s.id,
      location: s.location || null,
      specs: s.specs || null,
      url: s.url || null,
      configured: !!s.url
    });
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
app.get('/vendor/diagnostics.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'lib', 'diagnostics.js'));
});
app.get('/vendor/i18n.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'lib', 'i18n.js'));
});

// Permissive CORS for speed endpoints so configured remote nodes can be tested.
app.use('/api', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.set('trust proxy', 1);

const pingLimiter = rateLimit({ windowMs: 60 * 1000, max: 1200, message: { error: 'Too many ping requests.' } });
const downloadLimiter = rateLimit({ windowMs: 60 * 1000, max: 600, message: { error: 'Too many download tests.' } });
const uploadLimiter = rateLimit({ windowMs: 60 * 1000, max: 600, message: { error: 'Too many upload tests.' } });
const analyzeLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, message: { error: 'Too many AI analysis requests.' } });
const historyReadLimiter = rateLimit({ windowMs: 60 * 1000, max: 90, message: { error: 'Too many history requests.' } });
const historyWriteLimiter = rateLimit({ windowMs: 60 * 1000, max: 45, message: { error: 'Too many history writes.' } });

function isGroqConfigured() {
  const apiKey = process.env.GROQ_API_KEY;
  return Boolean(apiKey && apiKey !== '<your_api_key_here>');
}

// ---- Routes ----
app.get('/', (req, res) => {
  res.render('index', {
    servers,
    serverInfo: buildServerInfo(req),
    groqConfigured: isGroqConfigured(),
    dbConfigured: dbEnabled()
  });
});

app.get('/history', (req, res) => {
  res.render('history', { dbConfigured: dbEnabled() });
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    db: dbEnabled(),
    dbType: dbEnabled() ? dbType : null,
    groqConfigured: isGroqConfigured(),
    serverName: servers[0]?.name || 'Węzeł główny'
  });
});

app.get('/api/server-info', (req, res) => {
  res.json(buildServerInfo(req));
});

app.get('/api/servers', (req, res) => {
  const info = buildServerInfo(req);
  const enriched = servers.map((s, idx) =>
    idx === 0 ? { ...s, host: info.host, protocol: info.protocol } : s
  );
  res.json({ servers: enriched, serverInfo: info });
});

app.get('/api/ping', pingLimiter, (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.json({ now: Date.now() });
});

// Pre-generated cryptographically random pool so high-speed multi-stream downloads
// are not CPU-bound by per-chunk randomBytes calls while remaining uncompressible.
const RANDOM_POOL_SIZE = 4 * 1024 * 1024;
const RANDOM_POOL = crypto.randomBytes(RANDOM_POOL_SIZE);

// Download: streams cryptographically random bytes.
app.get('/api/download', downloadLimiter, async (req, res) => {
  const requested = Number(req.query.bytes);
  const bytes = Math.min(Math.max(Number.isFinite(requested) ? requested : 16 * 1024 * 1024, 512 * 1024), 128 * 1024 * 1024);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Content-Length', String(bytes));
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const chunkSize = 64 * 1024;
  let offset = crypto.randomInt(0, RANDOM_POOL_SIZE);
  let remaining = bytes;
  let aborted = false;
  req.on('close', () => { aborted = true; });
  res.on('close', () => { aborted = true; });

  try {
    while (remaining > 0 && !aborted && !res.writableEnded) {
      const size = Math.min(chunkSize, remaining, RANDOM_POOL_SIZE - offset);
      const chunk = RANDOM_POOL.subarray(offset, offset + size);
      const ok = res.write(chunk);
      remaining -= size;
      offset = (offset + size) % RANDOM_POOL_SIZE;
      if (!ok && !aborted) {
        await new Promise((resolve) => {
          const done = () => {
            res.off('drain', done);
            res.off('close', done);
            req.off('close', done);
            resolve();
          };
          res.once('drain', done);
          res.once('close', done);
          req.once('close', done);
        });
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
  req.on('aborted', () => { aborted = true; });
  res.on('close', () => { aborted = true; });
  req.on('data', (chunk) => {
    if (aborted) return;
    received += chunk.length;
    if (received > 128 * 1024 * 1024) {
      aborted = true;
      req.destroy();
    }
  });
  req.on('end', () => {
    if (aborted || res.headersSent || res.writableEnded) return;
    res.json({ received });
  });
  req.on('error', (err) => {
    if (!aborted && !res.headersSent && !res.writableEnded) {
      res.status(400).json({ error: err.message });
    }
  });
});

// AI analysis (backend only).
app.post('/api/analyze', analyzeLimiter, async (req, res) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey || apiKey === '<your_api_key_here>') {
    return res.status(503).json({ error: 'GROQ_API_KEY nie jest skonfigurowany.' });
  }

  const parsed = parseAnalyzePayload(req.body);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }

  const model = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
  const fallbackModel = process.env.GROQ_FALLBACK_MODEL || 'llama-3.1-8b-instant';
  const baseUrl = resolveGroqBaseUrl(process.env.GROQ_API_URL);

  const groq = new Groq({ apiKey, baseURL: baseUrl, timeout: 20000, maxRetries: 1 });

  try {
    const result = await analyzeWithGroq({
      groqClient: groq,
      data: parsed.data,
      model,
      fallbackModel
    });
    res.json(result);
  } catch (err) {
    const mapped = formatGroqError(err);
    res.status(mapped.httpStatus).json({ error: mapped.error });
  }
});

// History (optional).
app.get('/api/history', historyReadLimiter, async (req, res) => {
  if (!dbEnabled()) return res.json({ enabled: false, items: [] });
  try {
    const sql = 'SELECT id, created_at, server_id, download_mbps, upload_mbps, ping_ms, jitter_ms, loaded_latency_ms FROM speed_tests ORDER BY created_at DESC LIMIT 50';
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

app.delete('/api/history', historyWriteLimiter, async (req, res) => {
  if (!dbEnabled()) return res.status(503).json({ error: 'Database not configured.' });
  try {
    await (dbType === 'pg'
      ? pgPool.query('DELETE FROM speed_tests')
      : mysqlPool.query('DELETE FROM speed_tests'));
    res.json({ ok: true });
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