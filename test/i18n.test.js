const test = require('node:test');
const assert = require('node:assert/strict');
const { SUPPORTED_LANGS, TRANSLATIONS, normalizeLang, t } = require('../lib/i18n');
const { computeBufferbloatGrade, evaluateUseCases } = require('../lib/diagnostics');

test('all supported languages define the same translation keys', () => {
  const baseKeys = Object.keys(TRANSLATIONS.pl).sort();
  for (const lang of SUPPORTED_LANGS) {
    assert.deepEqual(Object.keys(TRANSLATIONS[lang]).sort(), baseKeys, `Key mismatch in ${lang}`);
  }
});

test('normalizeLang and t resolve tokens and fallback cleanly', () => {
  assert.equal(normalizeLang('en-GB'), 'en');
  assert.equal(normalizeLang('FR'), 'fr');
  assert.equal(normalizeLang('de'), 'pl');
  assert.equal(t('en', 'gradeLabel', { grade: 'A+' }), 'Grade: A+');
  assert.equal(t('fr', 'gradeLabel', { grade: 'B' }), 'Note : B');
});

test('diagnostics localize bufferbloat and use cases in PL, EN, and FR', () => {
  const enBloat = computeBufferbloatGrade(12, 20, 'en');
  const frBloat = computeBufferbloatGrade(12, 20, 'fr');
  assert.equal(enBloat.grade, 'A');
  assert.equal(enBloat.label, 'Very stable');
  assert.equal(frBloat.label, 'Très stable');

  const enCases = evaluateUseCases({ downloadMbps: 200, uploadMbps: 80, ping: 12, jitter: 2, packetLoss: 0, loadedLatency: 20 }, 'en');
  const frCases = evaluateUseCases({ downloadMbps: 200, uploadMbps: 80, ping: 12, jitter: 2, packetLoss: 0, loadedLatency: 20 }, 'fr');
  assert.equal(enCases[0].title, 'Online gaming');
  assert.equal(frCases[0].title, 'Jeux en ligne');
});
