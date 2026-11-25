const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveGroqBaseUrl,
  parseAnalyzePayload,
  buildAnalysisPrompt,
  formatGroqError,
  analyzeWithGroq
} = require('../lib/groq');

test('resolveGroqBaseUrl extracts origin or falls back', () => {
  assert.equal(resolveGroqBaseUrl('https://api.groq.com/openai/v1/chat/completions'), 'https://api.groq.com');
  assert.equal(resolveGroqBaseUrl('not-a-url'), 'https://api.groq.com');
  assert.equal(resolveGroqBaseUrl(''), 'https://api.groq.com');
});

test('parseAnalyzePayload validates required fields and normalizes optional context', () => {
  assert.deepEqual(parseAnalyzePayload({ download: -1, upload: 10, ping: 12, jitter: 1, loadedLatency: 20 }), {
    error: 'Invalid measurements.'
  });

  const parsed = parseAnalyzePayload({
    download: 312.5,
    upload: 84.2,
    ping: 14,
    jitter: 2.3,
    loadedLatency: 48,
    pingMin: 11,
    pingMax: 29,
    packetLoss: 0,
    loadedDownloadLatency: 42,
    loadedUploadLatency: 54,
    streams: 4,
    serverName: 'Warszawa',
    useCase: 'gaming'
  });

  assert.equal(parsed.error, undefined);
  assert.equal(parsed.data.download, 312.5);
  assert.equal(parsed.data.useCase, 'gaming');
  assert.equal(parsed.data.serverName, 'Warszawa');
  assert.equal(parsed.data.loadedDownloadLatency, 42);

  const unknownUseCase = parseAnalyzePayload({
    download: 100,
    upload: 50,
    ping: 15,
    jitter: 2,
    loadedLatency: 25,
    useCase: 'unknown_mode'
  });
  assert.equal(unknownUseCase.data.useCase, 'general');
});

test('buildAnalysisPrompt preserves exact numbers and computes bufferbloat', () => {
  const { data } = parseAnalyzePayload({
    download: 250.45,
    upload: 51.2,
    ping: 15,
    jitter: 3.1,
    loadedLatency: 55,
    packetLoss: 0.5,
    serverName: 'Kraków',
    useCase: 'remote_work'
  });

  const prompt = buildAnalysisPrompt(data);
  assert.match(prompt, /250\.45 Mb\/s/);
  assert.match(prompt, /51\.2 Mb\/s/);
  assert.match(prompt, /wzrost o \+40\.0 ms/);
  assert.match(prompt, /Utrata pakietów \(próby\): 0\.5%/);
  assert.match(prompt, /Kraków/);
  assert.match(prompt, /Praca zdalna/);
  assert.match(prompt, /delikatnym, wspierającym/i);
});

test('analyzeWithGroq uses fallback model on 429/404 and skips fallback on 401', async () => {
  const { data } = parseAnalyzePayload({
    download: 100,
    upload: 20,
    ping: 10,
    jitter: 1,
    loadedLatency: 18
  });

  const calls = [];
  const groqFallbackClient = {
    chat: {
      completions: {
        create: async ({ model }) => {
          calls.push(model);
          if (model === 'primary-model') {
            const err = new Error('Rate limited');
            err.status = 429;
            throw err;
          }
          return { choices: [{ message: { content: '### Ocena ogólna\n- Dobra.' } }] };
        }
      }
    }
  };

  const res = await analyzeWithGroq({
    groqClient: groqFallbackClient,
    data,
    model: 'primary-model',
    fallbackModel: 'llama-3.1-8b-instant'
  });
  assert.deepEqual(calls, ['primary-model', 'llama-3.1-8b-instant']);
  assert.equal(res.fallbackUsed, true);
  assert.equal(res.model, 'llama-3.1-8b-instant');
  assert.match(res.analysis, /Ocena ogólna/);

  const groqAuthFailClient = {
    chat: {
      completions: {
        create: async () => {
          const err = new Error('Invalid key');
          err.status = 401;
          throw err;
        }
      }
    }
  };

  await assert.rejects(
    () =>
      analyzeWithGroq({
        groqClient: groqAuthFailClient,
        data,
        model: 'primary-model',
        fallbackModel: 'llama-3.1-8b-instant'
      }),
    (err) => err.status === 401
  );
});

test('formatGroqError maps status codes to clear Polish messages', () => {
  assert.equal(formatGroqError({ status: 401 }).httpStatus, 502);
  assert.match(formatGroqError({ status: 401 }).error, /autoryzacji/i);
  assert.equal(formatGroqError({ status: 429 }).httpStatus, 429);
  assert.equal(formatGroqError({ message: 'Request timed out' }).httpStatus, 504);
});
