import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasKrMetric, krProgress } from '../src/domain.js';

const increasing = { baseline: 0, target: 10, actual: 5, direction: 'increase' };

test('missing or non-finite metric values remain unknown instead of becoming zero or NaN', () => {
  for (const field of ['baseline', 'target'] as const) {
    for (const value of [null, undefined, NaN, Infinity, -Infinity]) {
      const metric = { ...increasing, [field]: value };
      assert.equal(hasKrMetric(metric), false, `${field}: ${String(value)}`);
      assert.equal(krProgress(metric), null, `${field}: ${String(value)}`);
    }
  }
  for (const actual of [null, undefined, NaN, Infinity, -Infinity]) {
    assert.equal(hasKrMetric({ ...increasing, actual }), true);
    assert.equal(krProgress({ ...increasing, actual }), null);
  }
  assert.equal(hasKrMetric({}), false);
  assert.equal(krProgress({}), null);
});

test('only known directions with a finite positive target distance configure a metric', () => {
  for (const direction of [null, undefined, '', 'sideways', 'Increase']) {
    const metric = { ...increasing, direction };
    assert.equal(hasKrMetric(metric), false);
    assert.equal(krProgress(metric), null);
  }
  for (const metric of [
    { ...increasing, target: 0 },
    { ...increasing, target: -1 },
    { ...increasing, direction: 'decrease' },
    { baseline: -Number.MAX_VALUE, target: Number.MAX_VALUE, actual: 0, direction: 'increase' },
  ]) {
    assert.equal(hasKrMetric(metric), false);
    assert.equal(krProgress(metric), null);
  }
});

test('zero is a valid observed value and progress is clamped in both directions', () => {
  for (const [actual, expected] of [[-2, 0], [0, 0], [5, 0.5], [10, 1], [12, 1]]) {
    assert.equal(krProgress({ ...increasing, actual }), expected);
  }
  const decreasing = { baseline: 10, target: 0, direction: 'decrease' };
  assert.equal(hasKrMetric(decreasing), true);
  for (const [actual, expected] of [[12, 0], [10, 0], [5, 0.5], [0, 1], [-2, 1]]) {
    assert.equal(krProgress({ ...decreasing, actual }), expected);
  }
});

test('metric configuration does not require an observation or a unit from legacy callers', () => {
  const { actual: _actual, ...configured } = increasing;
  assert.equal(hasKrMetric(configured), true);
  assert.equal(krProgress(configured), null);
  assert.equal(krProgress(increasing), 0.5);
  assert.equal(hasKrMetric({ ...configured, unit: null }), true);
  assert.equal(krProgress({ ...increasing, unit: 'items' }), 0.5);
});
