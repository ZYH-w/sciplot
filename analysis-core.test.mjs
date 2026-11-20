import test from 'node:test';
import assert from 'node:assert/strict';
import { runAnalysis, fitDataset, compareModels, spectrumDataset, correlateDataset, summarizeReplicates, fftRadix2, studentTCritical95 } from './analysis-core.js';

const data = rows => ({ name: '实验', columns: Array.from({ length: rows[0].length }, (_, i) => i ? `Y${i}` : 'X'), rows });
const near = (value, expected, tolerance = 1e-9) => assert.ok(Math.abs(value - expected) <= tolerance, `${value} ≠ ${expected}`);
const metric = (result, label) => result.report.metrics.find(entry => entry.label === label)?.value;

test('Student-t 95% quantiles agree with reference values including small samples', () => {
  for (const [df, reference] of [[1, 12.706204736432095], [2, 4.302652729696142], [3, 3.182446305284263], [10, 2.2281388519649385], [30, 2.0422724563012373], [1000, 1.9623390808264074]]) near(studentTCritical95(df), reference, 2e-9);
  assert.throws(() => studentTCritical95(0), /自由度/);
});

test('linear least squares returns coefficients, standard errors, residuals and mean confidence width', () => {
  const source = data([[0, 1], [1, 2], [2, 2], [3, 4], [4, 4]]);
  const result = fitDataset(source, { fitModel: 'linear' });
  near(result.report.parameters[0].value, 1); near(result.report.parameters[1].value, .8);
  near(result.report.parameters[1].stderr, Math.sqrt(.8 / 3 / 10));
  near(result.report.parameters[0].stderr, Math.sqrt(.8 / 3 * .6));
  near(metric(result, 'R²'), 8 / 9); near(metric(result, 'RMSE'), .4);
  const fittedColumn = result.series[0].yColumn, confidence = result.series[0].yErrorColumn;
  near(result.dataset.rows[2][fittedColumn], 2.6);
  near(result.dataset.rows[2][confidence], studentTCritical95(3) * Math.sqrt(.8 / 3 / 5));
  assert.equal(result.series[0].errorStyle, 'band');
  assert.equal(result.replaceDataset, false);
  assert.deepEqual(source.rows, [[0, 1], [1, 2], [2, 2], [3, 4], [4, 4]]);
});

test('polynomial fit remains stable with large X offset through degree six', () => {
  for (let degree = 2; degree <= 6; degree++) {
    const source = data(Array.from({ length: 25 }, (_, index) => { const z = (index - 12) / 12; return [1e9 + index, 4 + 2 * z - z * z + .1 * z ** degree]; }));
    const result = fitDataset(source, { fitModel: 'polynomial', degree });
    const output = result.series[0].yColumn;
    source.rows.forEach((row, index) => near(result.dataset.rows[index][output], row[1], 2e-10));
    assert.ok(result.report.equation.includes('z ='));
    assert.equal(result.report.parameters.length, degree + 1);
  }
});

test('fitting handles missing observations and zero residual degrees of freedom explicitly', () => {
  const result = fitDataset(data([[0, 1], [1, null], [2, 5], [null, 8]]), {});
  near(result.dataset.rows[1][result.series[0].yColumn], 3);
  assert.equal(metric(result, '有效配对 n'), 2);
  assert.equal(result.report.parameters[0].stderr, null);
  assert.equal(result.dataset.rows[0][result.series[0].yErrorColumn], null);
  assert.equal(result.dataset.rows[3][result.series[0].yColumn], null);
});

test('rank deficient and invalid-domain models report errors', () => {
  assert.throws(() => fitDataset(data([[1, 1], [1, 2], [1, 3]]), {}), /两个不同/);
  assert.throws(() => fitDataset(data([[0, 1], [1, 2], [1, 3], [0, 4]]), { fitModel: 'polynomial', degree: 3 }), /秩不足/);
  assert.throws(() => fitDataset(data([[0, 1], [1, 0], [2, 3]]), { fitModel: 'exponential' }), /大于 0/);
  assert.throws(() => fitDataset(data([[0, 1], [1, 2], [2, 3]]), { fitModel: 'power' }), /大于 0/);
});

test('exponential and power fits solve the stated logarithmic-domain models', () => {
  for (const fitModel of ['exponential', 'power']) {
    const source = data(Array.from({ length: 10 }, (_, i) => { const x = (i + 1) / 3; return [x, fitModel === 'exponential' ? 2.5 * Math.exp(.4 * x) : 2.5 * x ** .4]; }));
    const result = fitDataset(source, { fitModel });
    near(result.report.parameters[0].value, 2.5); near(result.report.parameters[1].value, .4);
    near(metric(result, 'R²'), 1); assert.ok(result.report.details.some(detail => detail.includes('对数')));
  }
});

test('model comparison computes prediction R², MAE, RMSE, bias and Pearson', () => {
  const source = data([[0, 1, 2], [1, 2, 3], [2, 3, 4], [3, null, 8]]);
  const result = compareModels(source, { predictionColumns: [2] });
  const metrics = result.report.models[0];
  assert.equal(metrics.count, 3); near(metrics.mae, 1); near(metrics.rmse, 1); near(metrics.bias, 1); near(metrics.r2, -.5); near(metrics.pearson, 1);
  assert.deepEqual(result.dataset.rows.map(row => row[result.series[0].yColumn]), [1, 1, 1, null]);
  const constant = compareModels(data([[0, 2, 2], [1, 2, 3], [2, 2, 1]]), { predictionColumns: [2] });
  assert.equal(constant.report.models[0].r2, null); assert.equal(constant.report.models[0].pearson, null);
});

test('comparison pairs models separately and supports absolute-error output', () => {
  const result = compareModels(data([[0, 1, 2, null], [1, 2, 1, 2], [2, 3, 3, 2]]), { predictionColumns: [2, 3], output: 'absolute' });
  assert.deepEqual(result.report.models.map(model => model.count), [3, 2]);
  assert.deepEqual(result.dataset.rows.map(row => row[result.series[0].yColumn]), [1, 1, 0]);
  assert.throws(() => compareModels(data([[0, 1, 2], [1, 2, 3]]), { predictionColumns: [1] }), /不能相同/);
});

test('radix-two FFT agrees with an elementary DFT and inverts it', () => {
  const input = [1, 2, -1, 3, .5, 0, -4, 2], real = Float64Array.from(input), imaginary = new Float64Array(8);
  fftRadix2(real, imaginary);
  for (let k = 0; k < 8; k++) {
    const expectedReal = input.reduce((sum, value, i) => sum + value * Math.cos(-2 * Math.PI * k * i / 8), 0);
    const expectedImaginary = input.reduce((sum, value, i) => sum + value * Math.sin(-2 * Math.PI * k * i / 8), 0);
    near(real[k], expectedReal); near(imaginary[k], expectedImaginary);
  }
  fftRadix2(real, imaginary, true); input.forEach((value, index) => near(real[index], value));
  assert.throws(() => fftRadix2(new Float64Array(3), new Float64Array(3)), /FFT/);
});

test('single-sided FFT amplitude and PSD have correct sine, DC and Nyquist scaling', () => {
  const n = 128, fs = 128;
  const source = data(Array.from({ length: n }, (_, i) => [i / fs, 3 + 2 * Math.sin(2 * Math.PI * 8 * i / n) + .5 * (-1) ** i]));
  const result = spectrumDataset(source, { window: 'rectangular', detrend: false, sampleRate: fs });
  near(result.dataset.rows[0][1], 3); near(result.dataset.rows[8][1], 2); near(result.dataset.rows[64][1], .5);
  near(metric(result, 'PSD 积分'), 9 + 2 + .25);
  const detrended = spectrumDataset(source, { window: 'rectangular', detrend: true, sampleRate: fs });
  near(detrended.dataset.rows[0][1], 0);
  assert.equal(result.replaceDataset, true);
});

test('Hann coherent gain and zero-padding length are handled explicitly', () => {
  const source = data(Array.from({ length: 128 }, (_, i) => [i / 128, 2 * Math.sin(2 * Math.PI * 8 * i / 128)]));
  const result = spectrumDataset(source, { window: 'hann', sampleRate: 128 });
  near(result.dataset.rows[8][1], 2); near(metric(result, 'PSD 积分'), 2);
  const nonPowerTwo = spectrumDataset(data(source.rows.slice(0, 100)), { sampleRate: 128 });
  assert.equal(metric(nonPowerTwo, 'FFT 长度'), 128);
  assert.ok(nonPowerTwo.report.details.some(detail => detail.includes('不提升')));
});

test('FFT rejects missing, nonuniform X and invalid sample rate', () => {
  assert.throws(() => spectrumDataset(data([[0, 1], [1, null], [2, 3], [3, 4]])), /缺失/);
  assert.throws(() => spectrumDataset(data([[0, 1], [1, 2], [2, 3], [4, 4]])), /等间距/);
  assert.throws(() => spectrumDataset(data([[0, 1], [1, 2], [2, 3], [3, 4]]), { sampleRate: 0 }), /采样率/);
});

test('autocorrelation matches a direct energy-normalized calculation', () => {
  const input = [1, 2, -1, 3, 2, 0], average = input.reduce((a, b) => a + b) / input.length;
  const centered = input.map(value => value - average), denominator = centered.reduce((sum, value) => sum + value * value, 0);
  const result = correlateDataset(data(input.map((value, i) => [i, value])), { correlationType: 'auto', maxLag: 4, sampleRate: 1 });
  for (const row of result.dataset.rows) {
    const lag = row[0], expected = centered.slice(0, input.length - lag).reduce((sum, value, i) => sum + value * centered[i + lag], 0) / denominator;
    near(row[2], expected); assert.equal(row[3], input.length - lag);
  }
  near(result.dataset.rows[0][2], 1);
});

test('cross-correlation sign identifies the second signal delayed relative to the first', () => {
  const first = [0, 0, 1, -1, 2, -2, 0, 0, 0, 0], second = [0, 0, 0, 0, 1, -1, 2, -2, 0, 0];
  const result = correlateDataset(data(first.map((value, i) => [i / 10, value, second[i]])), { correlationType: 'cross', otherColumn: 2, sampleRate: 10, maxLag: 4 });
  assert.equal(metric(result, '对应滞后（样本）'), 2); near(metric(result, '对应滞后（s）'), .2);
  near(metric(result, '最大相关绝对值'), 1);
  assert.throws(() => correlateDataset(data([[0, 2], [1, 2], [2, 2], [3, 2]])), /常量/);
});

test('replicate mean, sample SD, SEM and t confidence use row-specific n', () => {
  const source = data([[0, 1, 2, 3], [1, 2, null, 4], [2, null, 7, null], [3, null, null, null]]);
  const result = summarizeReplicates(source, { replicateColumns: [1, 2, 3], error: 'ci95', errorStyle: 'band' });
  const start = source.columns.length;
  assert.deepEqual(result.dataset.rows.map(row => row[start + 4]), [3, 2, 1, 0]);
  near(result.dataset.rows[0][start], 2); near(result.dataset.rows[0][start + 1], 1); near(result.dataset.rows[0][start + 2], 1 / Math.sqrt(3));
  near(result.dataset.rows[0][start + 3], studentTCritical95(2) / Math.sqrt(3));
  near(result.dataset.rows[1][start + 3], studentTCritical95(1));
  assert.equal(result.dataset.rows[2][start + 1], null); assert.equal(result.dataset.rows[3][start], null);
  assert.equal(result.series[0].yErrorColumn, start + 3); assert.equal(result.series[0].errorStyle, 'band');
});

test('all workflows preserve input arrays and validate result column limits', () => {
  const source = data([[0, 1, 2], [1, 2, 3], [2, 3, 4], [3, 4, 5]]), before = structuredClone(source);
  for (const method of ['fit', 'compare', 'fft', 'correlation', 'replicates']) runAnalysis(source, { method, predictionColumns: [2], replicateColumns: [1, 2] });
  assert.deepEqual(source, before);
  const full = { name: 'full', columns: Array.from({ length: 100 }, (_, index) => `c${index}`), rows: Array.from({ length: 4 }, (_, i) => Array.from({ length: 100 }, (_, j) => i + j)) };
  assert.throws(() => fitDataset(full), /100 列/);
  assert.throws(() => runAnalysis(source, { method: 'unknown' }), /方法/);
});
