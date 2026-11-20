import test from 'node:test';
import assert from 'node:assert/strict';
import { describeColumn, processColumn } from './data-processing.js';

const dataset = (ys, xs = ys.map((_, index) => index)) => ({ name: '实验', columns: ['X', 'Y'], rows: ys.map((y, index) => [xs[index], y]) });
const values = result => result.dataset.rows.map(row => row[result.columnIndex]);
const near = (actual, expected, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≠ ${expected}`);

test('statistics use sample variance, R7 quantiles and finite-value missing counts', () => {
  const stats = describeColumn(dataset([1, 2, null, 3, 4]), 1);
  assert.equal(stats.count, 4); assert.equal(stats.missing, 1);
  assert.equal(stats.mean, 2.5); assert.equal(stats.median, 2.5);
  assert.equal(stats.q1, 1.75); assert.equal(stats.q3, 3.25);
  near(stats.variance, 5 / 3); near(stats.std, Math.sqrt(5 / 3));
  near(stats.sem, Math.sqrt(5 / 3) / 2); near(stats.rms, Math.sqrt(7.5));
});

test('empty and singleton statistics do not invent variance', () => {
  const empty = describeColumn(dataset([null, null]), 1);
  assert.equal(empty.count, 0); assert.equal(empty.missing, 2);
  for (const key of ['mean', 'median', 'min', 'max', 'std', 'variance', 'q1', 'q3', 'sem', 'rms']) assert.equal(empty[key], null);
  const one = describeColumn(dataset([2, null]), 1);
  assert.equal(one.mean, 2); assert.equal(one.std, null); assert.equal(one.variance, null); assert.equal(one.sem, null);
});

test('statistics remain stable for a large baseline and extreme finite values', () => {
  const shifted = describeColumn(dataset([1e12 + 1, 1e12 + 2, 1e12 + 3]), 1);
  near(shifted.mean, 1e12 + 2); near(shifted.std, 1);
  const extreme = describeColumn(dataset([-1e308, 1e308]), 1);
  assert.equal(extreme.mean, 0); assert.ok(Number.isFinite(extreme.std));
  assert.equal(extreme.variance, null); assert.ok(Number.isFinite(extreme.rms));
  const tiny = describeColumn(dataset([1e-200, 2e-200, 3e-200]), 1);
  near(tiny.std / 1e-200, 1);
});

test('moving average shrinks its centered window and preserves center gaps', () => {
  const result = processColumn(dataset([1, 3, null, 7, 9]), { method: 'moving-average', column: 1, window: 3 });
  assert.deepEqual(values(result), [2, 2, null, 8, 8]);
  assert.equal(result.report.changedCount, 4);
});

test('median filter removes an isolated impulse and defines even edge neighborhoods', () => {
  assert.deepEqual(values(processColumn(dataset([1, 1, 100, 1, 1]), { method: 'median-filter', window: 3 })), [1, 1, 1, 1, 1]);
  assert.deepEqual(values(processColumn(dataset([1, 5, 9]), { method: 'median-filter', window: 3 })), [3, 5, 7]);
});

test('Gaussian weights are normalized at edges and around missing values', () => {
  const result = values(processColumn(dataset([0, 10, 0]), { method: 'gaussian-filter', window: 3, sigma: 1 }));
  const weight = Math.exp(-.5);
  near(result[0], 10 * weight / (1 + weight));
  near(result[1], 10 / (1 + 2 * weight));
  assert.equal(result[0], result[2]);
  assert.deepEqual(values(processColumn(dataset([3, null, 3]), { method: 'gaussian-filter', window: 3, sigma: 1 })), [3, null, 3]);
});

test('lowpass restarts at each missing-value boundary', () => {
  assert.deepEqual(values(processColumn(dataset([0, 8, 8, null, 10, 2]), { method: 'lowpass', alpha: .5 })), [0, 4, 6, null, 10, 6]);
});

test('Savitzky–Golay preserves quadratic data including both edges on irregular X', () => {
  const xs = [0, .2, 1, 1.5, 2.9, 4, 6];
  const ys = xs.map(x => 3 + 2 * x + x * x);
  const result = values(processColumn(dataset(ys, xs), { method: 'savitzky-golay', degree: 2, window: 5 }));
  result.forEach((value, index) => near(value, ys[index], 1e-9));
});

test('Savitzky–Golay matches known five-point quadratic coefficients', () => {
  const result = values(processColumn(dataset([0, 0, 35, 0, 0]), { method: 'savitzky-golay', degree: 2, window: 5 }));
  near(result[2], 17);
  near(result[0], -3);
  near(result[1], 12);
});

test('Savitzky–Golay preserves center gaps and reports insufficient fitting points', () => {
  const result = processColumn(dataset([1, null, 3, null, 5]), { method: 'savitzky-golay', degree: 2, window: 3 });
  assert.deepEqual(values(result), [null, null, null, null, null]);
  assert.ok(result.report.details.some(detail => detail.includes('不足')));
  assert.throws(() => processColumn(dataset([1, 2, 3]), { method: 'savitzky-golay', degree: 3, window: 3 }), /阶数/);
});

test('Butterworth steady initialization preserves lowpass DC and removes highpass DC', () => {
  const source = dataset(Array(20).fill(7));
  for (const filterType of ['lowpass', 'highpass']) {
    const result = values(processColumn(source, { method: 'butterworth', filterType, sampleRate: 100, cutoff: 10 }));
    result.forEach(value => near(value, filterType === 'lowpass' ? 7 : 0, 1e-10));
  }
});

test('Butterworth resets on gaps and validates Nyquist and uniform X', () => {
  const result = values(processColumn(dataset([0, 1, null, 9, 9]), { method: 'butterworth', sampleRate: 100, cutoff: 10 }));
  assert.equal(result[0], 0); assert.equal(result[2], null); assert.equal(result[3], 9); near(result[4], 9);
  assert.throws(() => processColumn(dataset([1, 2, 3]), { method: 'butterworth', sampleRate: 100, cutoff: 50 }), /截止/);
  assert.throws(() => processColumn(dataset([1, 2, 3], [0, 1, 3]), { method: 'butterworth' }), /等间距/);
});

test('Butterworth has approximately minus-three-decibel response at its cutoff', () => {
  const sampleRate = 100, cutoff = 10, length = 2000;
  const signal = Array.from({ length }, (_, index) => Math.sin(2 * Math.PI * cutoff * index / sampleRate));
  const source = dataset(signal, signal.map((_, index) => index / sampleRate));
  for (const filterType of ['lowpass', 'highpass']) {
    const filtered = values(processColumn(source, { method: 'butterworth', filterType, sampleRate, cutoff })).slice(1000);
    const rms = Math.sqrt(filtered.reduce((sum, value) => sum + value * value, 0) / filtered.length);
    near(rms, .5, 1e-8);
  }
});

test('scalar and column math preserve gaps and report zero division', () => {
  const source = { name: 'test', columns: ['X', 'Y', 'Z'], rows: [[0, 6, 2], [1, null, 3], [2, 4, 0], [3, 5, null]] };
  assert.deepEqual(values(processColumn(source, { method: 'scalar', value: 2, operator: 'multiply' })), [12, null, 8, 10]);
  const divided = processColumn(source, { method: 'column-math', otherColumn: 2, operator: 'divide' });
  assert.deepEqual(values(divided), [3, null, null, null]);
  assert.ok(divided.report.details.some(detail => detail.includes('1 处分母为 0')));
  const overflow = processColumn(dataset([1e308, 1]), { method: 'scalar', operator: 'multiply', value: 10 });
  assert.deepEqual(values(overflow), [null, 10]);
  assert.ok(overflow.report.details.some(detail => detail.includes('超出')));
});

test('normalization defines constant columns and uses sample standard deviation', () => {
  assert.deepEqual(values(processColumn(dataset([2, 4, null, 6]), { method: 'normalize', normalize: 'minmax' })), [0, .5, null, 1]);
  assert.deepEqual(values(processColumn(dataset([7, null, 7]), { method: 'normalize', normalize: 'zscore' })), [0, null, 0]);
  assert.deepEqual(values(processColumn(dataset([1, 2, 3]), { method: 'normalize', normalize: 'zscore' })), [-1, 0, 1]);
  assert.deepEqual(values(processColumn(dataset([-1e308, 0, 1e308]), { method: 'normalize', normalize: 'minmax' })), [0, .5, 1]);
});

test('IQR outliers can be removed or clipped without deleting rows', () => {
  const source = dataset([1, 2, 3, 4, 100]);
  const removed = processColumn(source, { method: 'outliers', outlierRule: 'iqr', threshold: 1.5, action: 'remove' });
  assert.deepEqual(values(removed), [1, 2, 3, 4, null]);
  const clipped = processColumn(source, { method: 'outliers', outlierRule: 'iqr', threshold: 1.5, action: 'clip' });
  assert.deepEqual(values(clipped), [1, 2, 3, 4, 7]);
});

test('Z-score outliers use sample rather than population deviation', () => {
  const source = dataset([0, 0, 0, 10]);
  assert.deepEqual(values(processColumn(source, { method: 'outliers', outlierRule: 'zscore', threshold: 1.6, action: 'remove' })), [0, 0, 0, 10]);
  assert.deepEqual(values(processColumn(source, { method: 'outliers', outlierRule: 'zscore', threshold: 1.4, action: 'remove' })), [0, 0, 0, null]);
});

test('outlier interpolation uses X spacing and preserves original gaps and edges', () => {
  const source = dataset([0, 100, 2, 3, 4], [0, 1, 4, 5, 6]);
  const result = processColumn(source, { method: 'outliers', outlierRule: 'iqr', threshold: 1.5, action: 'interpolate', xColumn: 0 });
  assert.deepEqual(values(result), [0, .5, 2, 3, 4]);
  const gap = processColumn(dataset([0, 100, null, 2, 3, 4]), { method: 'outliers', action: 'interpolate' });
  assert.deepEqual(values(gap), [0, null, null, 2, 3, 4]);
  assert.deepEqual(values(processColumn(dataset([100, 1, 2, 3, 4]), { method: 'outliers', action: 'interpolate' })), [null, 1, 2, 3, 4]);
});

test('fill-missing interpolates interior runs only and never crosses missing X', () => {
  assert.deepEqual(values(processColumn(dataset([null, 2, null, null, 10, null], [0, 1, 2, 4, 5, 6]), { method: 'fill-missing' })), [null, 2, 4, 8, 10, null]);
  assert.deepEqual(values(processColumn(dataset([0, null, null, 6], [0, 1, null, 3]), { method: 'fill-missing' })), [0, null, null, 6]);
});

test('nonuniform three-point derivative is exact for an interior quadratic', () => {
  const xs = [0, 1, 3, 6], ys = xs.map(x => x * x);
  assert.deepEqual(values(processColumn(dataset(ys, xs), { method: 'derivative' })), [1, 2, 6, 9]);
  assert.deepEqual(values(processColumn(dataset([0, 1, null, 9, 16, null, 36]), { method: 'derivative' })), [1, 1, null, 7, 7, null, null]);
});

test('trapezoidal integral uses X intervals and resets after gaps', () => {
  assert.deepEqual(values(processColumn(dataset([0, 2, 6, null, 8, 10], [0, 1, 3, 4, 5, 8]), { method: 'integral' })), [0, 1, 9, null, 0, 27]);
  const missingX = values(processColumn(dataset([0, 2, 3, 4], [0, 1, null, 3]), { method: 'integral' }));
  assert.deepEqual(missingX, [0, 1, null, 0]);
});

test('X-dependent methods reject duplicate or descending valid X values', () => {
  for (const method of ['derivative', 'integral', 'fill-missing', 'outliers']) {
    for (const xs of [[0, 1, 1], [0, 2, 1]]) {
      assert.throws(() => processColumn(dataset([1, 10, 2], xs), { method, action: 'interpolate' }), /严格递增/);
    }
  }
});

test('processing does not mutate original rows and makes safe unique names', () => {
  const source = dataset([1, 2, 3]), before = structuredClone(source);
  const result = processColumn(source, { method: 'scalar', name: '\u202eY\u0000', value: 1 });
  assert.deepEqual(source, before);
  assert.notEqual(result.dataset, source);
  assert.notEqual(result.dataset.rows[0], source.rows[0]);
  assert.equal(result.dataset.columns.at(-1), 'Y (2)');
  assert.deepEqual(values(result), [2, 3, 4]);
  assert.equal(result.statistics.mean, 3);
});

test('invalid settings, full tables and wholly missing source columns are rejected', () => {
  assert.throws(() => processColumn(dataset([1, 2]), { method: 'moving-average', window: 4 }), /窗口/);
  assert.throws(() => processColumn(dataset([1, 2]), { method: 'lowpass', alpha: 0 }), /平滑/);
  assert.throws(() => processColumn(dataset([null, null]), { method: 'fill-missing' }), /有效数值/);
  assert.throws(() => processColumn({ name: 'full', columns: Array(100).fill('x'), rows: [Array(100).fill(1)] }, { method: 'scalar' }), /100/);
});
