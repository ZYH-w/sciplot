import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { File } from 'node:buffer';
import { parseSpreadsheet, inspectSpreadsheet } from './excel-import.js';

const context = vm.createContext({ console, ArrayBuffer, Uint8Array, Uint16Array, Uint32Array, Int32Array, DataView, Date });
vm.runInContext(await readFile(new URL('./assets/xlsx.full.min.js', import.meta.url), 'utf8'), context);
globalThis.XLSX = context.XLSX;
const XLSX = globalThis.XLSX;

function fileFromSheets(sheets, bookType = 'xlsx') {
  const book = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    const sheet = Array.isArray(rows) ? XLSX.utils.aoa_to_sheet(rows) : rows;
    XLSX.utils.book_append_sheet(book, sheet, name);
  }
  return new File([XLSX.write(book, { type: 'array', bookType })], `实验.${bookType}`);
}

test('XLSX inspects sheets and automatically detects Chinese headers', async () => {
  const file = fileFromSheets({ '实验数据': [['时间', '信号'], [0, 1.25], [1, -2.5]], '验证数据': [['x', 'y'], [2, 7], [3, 8]] });
  const metadata = await inspectSpreadsheet(file);
  assert.deepEqual(metadata.sheets, ['实验数据', '验证数据']);
  const result = await parseSpreadsheet(file);
  assert.deepEqual(result.dataset.columns, ['时间', '信号']);
  assert.deepEqual(result.dataset.rows, [[0, 1.25], [1, -2.5]]);
  assert.equal(result.sheetName, '实验数据');
  const selected = await parseSpreadsheet(file, { sheetName: '验证数据' });
  assert.deepEqual(selected.dataset.rows, [[2, 7], [3, 8]]);
});

for (const format of ['xls', 'ods']) {
  test(`reads real ${format.toUpperCase()} binary data`, async () => {
    const result = await parseSpreadsheet(fileFromSheets({ Sheet1: [['时间', '数值'], [0, 2.25], [1, 3.5]] }, format));
    assert.deepEqual(result.dataset.rows, [[0, 2.25], [1, 3.5]]);
  });
}

test('headerless numeric first row is preserved and explicit numeric header works', async () => {
  const file = fileFromSheets({ Sheet1: [[0, 2], [1, 3], [2, 4]] });
  assert.deepEqual((await parseSpreadsheet(file)).dataset.rows, [[0, 2], [1, 3], [2, 4]]);
  const header = await parseSpreadsheet(file, { headerMode: 'yes' });
  assert.deepEqual(header.dataset.columns, ['0', '2']);
  assert.deepEqual(header.dataset.rows, [[1, 3], [2, 4]]);
});

test('leading blank rows and columns, duplicate headers, numeric text and gaps', async () => {
  const file = fileFromSheets({ Sheet1: [[], [null, '值', '值', '第三列'], [null, 0, '1.2e-3', 8], [null, 1, null, 9]] });
  const result = await parseSpreadsheet(file);
  assert.equal(new Set(result.dataset.columns).size, 3);
  assert.deepEqual(result.dataset.rows, [[0, 0.0012, 8], [1, null, 9]]);
});

test('uses cached formula values and warns about formulas without cached values', async () => {
  const sheet = XLSX.utils.aoa_to_sheet([['x', 'y'], [0, 2], [1, 4], [2, 5]]);
  sheet.B2 = { t: 'n', f: '1+1', v: 2 };
  sheet.B3 = { t: 'n', f: '2+2' };
  const result = await parseSpreadsheet(fileFromSheets({ Sheet1: sheet }));
  assert.equal(result.dataset.rows[0][1], 2);
  assert.equal(result.dataset.rows[1][1], null);
  assert.ok(result.warnings.some(warning => warning.includes('不会重新计算')));
  assert.ok(result.warnings.some(warning => warning.includes('没有已保存')));
});

test('rejects unknown and empty worksheets', async () => {
  const file = fileFromSheets({ Empty: [], Data: [['x', 'y'], [1, 2], [2, 3]] });
  await assert.rejects(parseSpreadsheet(file, { sheetName: 'missing' }), /不存在/);
  await assert.rejects(parseSpreadsheet(file), /没有有效数据/);
});

test('rejects excessive effective columns without expanding a worksheet', async () => {
  const file = fileFromSheets({ Sheet1: [Array.from({ length: 101 }, (_, i) => `列${i}`), Array(101).fill(1), Array(101).fill(2)] });
  await assert.rejects(parseSpreadsheet(file), /100 列/);
});
