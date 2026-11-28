const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computeMbps,
  formatMetric,
  computePingStats,
  computeBufferbloatGrade,
  evaluateUseCases
} = require('../lib/diagnostics');

test('computeMbps computes megabits per second accurately', () => {
  assert.equal(computeMbps(12_500_000, 1), 100);
  assert.equal(computeMbps(0, 2), 0);
  assert.equal(computeMbps(1000, 0), 0);
  assert.equal(computeMbps(-5, 1), 0);
});

test('formatMetric formats numbers consistently by magnitude', () => {
  assert.equal(formatMetric(null), '--');
  assert.equal(formatMetric(NaN), '--');
  assert.equal(formatMetric(3.456), '3.46');
  assert.equal(formatMetric(42.34), '42.3');
  assert.equal(formatMetric(312.8), '313');
});

test('computePingStats calculates median, min, max, percentiles, jitter, and loss', () => {
  const stats = computePingStats([10, 20, 12, 14, 100], 1);
  assert.equal(stats.min, 10);
  assert.equal(stats.max, 100);
  assert.equal(stats.ping, 14);
  assert.equal(stats.packetLoss, 16.7);
  assert.ok(stats.p95 >= 20);
  assert.ok(stats.jitter > 0);

  const empty = computePingStats([], 4);
  assert.ok(Number.isNaN(empty.ping));
  assert.equal(empty.packetLoss, 100);
});

test('computeBufferbloatGrade assigns accurate grades', () => {
  assert.equal(computeBufferbloatGrade(12, 14).grade, 'A+');
  assert.equal(computeBufferbloatGrade(12, 22).grade, 'A');
  assert.equal(computeBufferbloatGrade(12, 36).grade, 'B');
  assert.equal(computeBufferbloatGrade(12, 62).grade, 'C');
  assert.equal(computeBufferbloatGrade(12, 112).grade, 'D');
  assert.equal(computeBufferbloatGrade(12, 212).grade, 'F');
  assert.equal(computeBufferbloatGrade(12, NaN).grade, '--');
});

test('evaluateUseCases produces clear readiness statuses', () => {
  const fast = evaluateUseCases({
    downloadMbps: 350,
    uploadMbps: 120,
    ping: 11,
    jitter: 1.8,
    packetLoss: 0,
    loadedLatency: 19
  });
  assert.equal(fast.length, 4);
  assert.ok(fast.every((item) => item.status === 'good'));

  const constrained = evaluateUseCases({
    downloadMbps: 12,
    uploadMbps: 3,
    ping: 85,
    jitter: 28,
    packetLoss: 2.5,
    loadedLatency: 220
  });
  assert.equal(constrained.find((x) => x.id === 'gaming').status, 'bad');
  assert.equal(constrained.find((x) => x.id === 'streaming').status, 'bad');
  assert.equal(constrained.find((x) => x.id === 'remote_work').status, 'bad');
});
