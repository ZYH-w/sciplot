import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDelimited, parseMatrix, makeDemoDataset, datasetToCSV, validateProject } from './data-core.js';

test('imports BOM CSV with headers, negatives, decimals and scientific notation', () => {
  const { dataset, warnings } = parseDelimited('\uFEFF时间,实验\r\n-1,.5\r\n2,1.2e-3', '实验.csv');
  assert.deepEqual(dataset, { name: '实验.csv', columns: ['时间', '实验'], rows: [[-1, .5], [2, .0012]] });
  assert.deepEqual(warnings, []);
});

test('supports quoted commas, escaped quotes and embedded line breaks', () => {
  const { dataset } = parseDelimited('"Time, s","model ""A""\nresponse"\n0,2\n1,3');
  assert.deepEqual(dataset.columns, ['Time, s', 'model "A"\nresponse']);
  assert.deepEqual(dataset.rows, [[0, 2], [1, 3]]);
});

test('detects tabs, semicolons and whitespace', () => {
  for (const separator of ['\t', ';', '   ']) {
    const { dataset } = parseDelimited(`X${separator}Y\n0${separator}3\n1${separator}4`);
    assert.deepEqual(dataset.rows, [[0, 3], [1, 4]]);
  }
});

test('keeps missing and invalid data as gaps instead of zero', () => {
  const { dataset, warnings } = parseDelimited('t,A,B\n0,,3\n1,nope,4\n2,6\n3,NaN,7');
  assert.deepEqual(dataset.rows, [[0, null, 3], [1, null, 4], [2, 6, null], [3, null, 7]]);
  assert.ok(warnings.some(warning => warning.includes('1 个非数值')));
  assert.ok(warnings.some(warning => warning.includes('4 个缺失')));
});

test('unlabelled data retains its first row and creates unique column names', () => {
  const { dataset } = parseDelimited('-2,5\n-1,8\n0,12');
  assert.deepEqual(dataset.columns, ['X', 'Y1']);
  assert.equal(dataset.rows[0][0], -2);
  assert.deepEqual(parseDelimited('t,A,A\n0,1,2\n1,2,3').dataset.columns, ['t', 'A', 'A (2)']);
});

test('a numeric first X with an invalid Y is kept as data rather than mistaken for a header', () => {
  const { dataset } = parseDelimited('0,invalid,3\n1,2,4\n2,3,5');
  assert.deepEqual(dataset.columns, ['X', 'Y1', 'Y2']);
  assert.deepEqual(dataset.rows[0], [0, null, 3]);
  assert.equal(dataset.rows.length, 3);
});

test('rejects empty, nonnumeric, insufficient and malformed files with helpful errors', () => {
  for (const content of ['', 'X,Y\na,b\nc,d', 'X,Y\n1,2', '1\n2\n3', '"X,Y\n0,2\n1,3']) assert.throws(() => parseDelimited(content), Error);
});

test('enforces the row and column bounds', () => {
  assert.throws(() => parseDelimited(Array.from({ length: 50001 }, (_, index) => `${index},2`).join('\n')), /50,000/);
  assert.throws(() => parseDelimited(`${Array(101).fill('1').join(',')}\n${Array(101).fill('2').join(',')}`), /100/);
});

test('CSV export round trips missing values and quoted headers', () => {
  const original = { name: 'roundtrip.csv', columns: ['Time (s)', 'A, "value"'], rows: [[-1, null], [0, 2.5], [1, 3e-8]] };
  assert.deepEqual(parseDelimited(datasetToCSV(original), original.name).dataset, original);
});

test('manual header options support numeric headers and preserve first numeric row', () => {
  const content = '0,1\n1,2\n2,3';
  assert.equal(parseDelimited(content).dataset.rows.length, 3);
  assert.equal(parseDelimited(content, 'data.csv', { headerMode: 'no' }).dataset.rows.length, 3);
  const withHeader = parseDelimited(content, 'data.csv', { headerMode: 'yes' }).dataset;
  assert.deepEqual(withHeader.columns, ['0', '1']);
  assert.deepEqual(withHeader.rows, [[1, 2], [2, 3]]);
});

test('manual delimiters are respected', () => {
  assert.deepEqual(parseDelimited('X;Y\n0;1\n1;2', 'data.txt', { delimiter: ';' }).dataset.rows, [[0, 1], [1, 2]]);
  assert.throws(() => parseDelimited('X;Y\n0;1\n1;2', 'data.txt', { delimiter: ',' }), /两列/);
});

test('Excel matrices share header, gap and numeric detection', () => {
  const matrix = [[null, null], ['Time', 'Value'], [-2, .002], [-1, null], [0, 4.3e8]];
  const { dataset } = parseMatrix(matrix, '实验.xlsx');
  assert.deepEqual(dataset.columns, ['Time', 'Value']);
  assert.deepEqual(dataset.rows, [[-2, .002], [-1, null], [0, 4.3e8]]);
  assert.deepEqual(parseMatrix([[0, 2], [1, 3]], 'raw').dataset.rows, [[0, 2], [1, 3]]);
});

test('demo is deterministic and provides finite scientific traces', () => {
  const dataset = makeDemoDataset();
  assert.deepEqual(dataset, makeDemoDataset());
  assert.equal(dataset.rows.length, 151);
  assert.equal(dataset.rows[0][0], 0);
  assert.equal(dataset.rows.at(-1)[0], 30);
  assert.ok(dataset.rows.every(row => row.length === 4 && row.every(Number.isFinite)));
});

test('validates project numbers and series column references', () => {
  const project = { schemaVersion: 1, dataset: makeDemoDataset(), series: [{ xColumn: 0, yColumn: 1, color: '#123456', width: 2 }], chartType: 'line-scatter' };
  assert.deepEqual(validateProject(project).dataset, project.dataset);
  assert.throws(() => validateProject({ ...project, schemaVersion: 2 }), /版本/);
  assert.throws(() => validateProject({ ...project, series: [{ xColumn: 0, yColumn: 50 }] }), /数据列/);
  assert.throws(() => validateProject({ ...project, axes: { xMin: 'invalid' } }), /范围/);
  assert.throws(() => validateProject({ ...project, dataset: { ...project.dataset, rows: [[0, NaN, 2, 3], [1, 2, 3, 4]] } }), /数值/);
});

test('fills missing project style fields with usable defaults and auto ranges', () => {
  const project = validateProject({ schemaVersion: 1, dataset: makeDemoDataset(), series: [{ xColumn: 0, yColumn: 1 }] });
  assert.equal(typeof project.series[0].id, 'string');
  assert.equal(project.series[0].name, '实验值');
  assert.match(project.series[0].color, /^#[0-9a-f]{6}$/);
  assert.equal(project.series[0].visible, true);
  assert.equal(project.axes.xMin, '');
  assert.equal(project.axes.xMax, '');
  assert.equal(project.inset.enabled, false);
  assert.deepEqual(validateProject(project), project);
});

test('rejects attribute injection and duplicate series identifiers', () => {
  const base = { schemaVersion: 1, dataset: makeDemoDataset(), series: [{ id: 's-1', xColumn: 0, yColumn: 1 }] };
  for (const id of ['a" onclick="alert(1)', {}, 123, '', 's 1']) {
    assert.throws(() => validateProject({ ...base, series: [{ ...base.series[0], id }] }), /标识/);
  }
  assert.throws(() => validateProject({ ...base, series: [base.series[0], base.series[0]] }), /标识/);
});

test('rejects invalid colors and normalizes three-digit colors for the color input', () => {
  const base = { schemaVersion: 1, dataset: makeDemoDataset(), series: [{ xColumn: 0, yColumn: 1 }] };
  for (const color of ['red', '#12345', '#1234567', '#fff" oninput="alert(1)', 'url(https://example.com)']) {
    assert.throws(() => validateProject({ ...base, series: [{ ...base.series[0], color }] }), /颜色/);
  }
  assert.equal(validateProject({ ...base, series: [{ ...base.series[0], color: '#abc' }] }).series[0].color, '#aabbcc');
});

test('strips unknown fields and prototype keys without changing literal names', () => {
  const malicious = JSON.parse('{"__proto__":{"polluted":true},"unknown":{"html":"<script>"}}');
  const base = { ...malicious, schemaVersion: 1, dataset: { ...makeDemoDataset(), ...malicious }, series: [{ ...malicious, id: 'safe', name: '<img src=x onerror=alert(1)>', xColumn: 0, yColumn: 1 }], axes: { ...malicious, xLabel: '<svg onload=alert(1)>' } };
  const project = validateProject(base);
  for (const object of [project, project.dataset, project.series[0], project.axes]) {
    assert.equal(Object.hasOwn(object, '__proto__'), false);
    assert.equal(Object.hasOwn(object, 'unknown'), false);
  }
  assert.equal({}.polluted, undefined);
  assert.equal(project.series[0].name, '<img src=x onerror=alert(1)>');
});

test('validates configuration types and the 30-series project limit', () => {
  const base = { schemaVersion: 1, dataset: makeDemoDataset(), series: [{ xColumn: 0, yColumn: 1 }] };
  assert.throws(() => validateProject({ ...base, series: Array.from({ length: 31 }, () => ({ xColumn: 0, yColumn: 1 })) }), /30/);
  assert.throws(() => validateProject({ ...base, projectName: { name: 'invalid' } }), /名称/);
  assert.throws(() => validateProject({ ...base, legend: { show: 'false' } }), /图例/);
  assert.throws(() => validateProject({ ...base, inset: { xMin: 'bad' } }), /范围/);
  assert.throws(() => validateProject({ ...base, axes: { xMin: 5, xMax: 1 } }), /起点/);
  assert.throws(() => validateProject({ ...base, axisBreak: { enabled: true, from: 5, to: 2 } }), /断轴/);
  assert.throws(() => validateProject({ ...base, palette: 'arbitrary' }), /配色/);
});
