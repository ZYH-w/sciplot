import { parseMatrix } from './data-core.js';

const workbookCache = new WeakMap();
const MAX_FILE_SIZE = 25 * 1024 * 1024;
const MAX_ROWS = 50000;
const MAX_COLUMNS = 100;

function getLibrary() {
  if (!globalThis.XLSX?.read) throw new Error('Excel 解析组件未加载，请刷新页面后重试。');
  return globalThis.XLSX;
}

function readError(error) {
  if (/password|encrypt/i.test(error?.message || '')) return new Error('该工作簿已加密，请解除密码保护后再导入。');
  return new Error('无法读取此工作簿，请确认文件未损坏，并使用 Excel 另存为 XLSX 后重试。');
}

async function loadWorkbook(file) {
  if (!file || typeof file.arrayBuffer !== 'function') throw new Error('请选择 Excel 或 ODS 工作簿文件。');
  if (file.size > MAX_FILE_SIZE) throw new Error('工作簿超过 25 MB，请删除不需要的工作表或拆分文件后再试。');
  if (!workbookCache.has(file)) {
    const pending = (async () => {
      const bytes = await file.arrayBuffer();
      if (!bytes.byteLength) throw new Error('工作簿为空，请选择包含数据的文件。');
      let metadata;
      try {
        metadata = getLibrary().read(bytes, { type: 'array', bookSheets: true, cellHTML: false, cellText: false });
      } catch (error) {
        if (error.message.includes('组件未加载')) throw error;
        throw readError(error);
      }
      if (!metadata.SheetNames?.length) throw new Error('工作簿中没有可读取的工作表。');
      return { bytes, sheets: Array.from(metadata.SheetNames), parsedSheets: new Map() };
    })();
    workbookCache.set(file, pending);
    pending.catch(() => workbookCache.delete(file));
  }
  return workbookCache.get(file);
}

/** Read names without turning the workbook into application data. */
export async function inspectSpreadsheet(file) {
  const workbook = await loadWorkbook(file);
  return { name: file.name || '导入工作簿', sheets: workbook.sheets.slice(), sheetName: workbook.sheets[0] };
}

function toMatrix(sheet, library) {
  const denseRows = sheet['!data'];
  const records = [];
  let firstColumn = Infinity;
  let lastColumn = -1;
  let formulaCount = 0;
  let missingFormulaCount = 0;
  let errorCount = 0;
  let dateCount = 0;
  // Dense worksheets may contain sparse row indexes. Iterating occupied keys
  // avoids expanding a worksheet whose formatting extends to the last row.
  const rows = denseRows ? Object.keys(denseRows).filter(key => /^\d+$/.test(key)).map(Number).sort((a, b) => a - b) : [];
  for (const rowIndex of rows) {
    const cells = denseRows[rowIndex];
    if (!cells) continue;
    const values = new Map();
    for (const columnKey of Object.keys(cells)) {
      if (!/^\d+$/.test(columnKey)) continue;
      const cell = cells[columnKey];
      if (!cell || cell.t === 'z') continue;
      const columnIndex = Number(columnKey);
      if (cell.f) {
        formulaCount++;
        if (cell.v === undefined || cell.v === null) missingFormulaCount++;
      }
      if (cell.t === 'e') errorCount++;
      if (cell.t === 'n' && cell.z && library.SSF?.is_date(cell.z)) dateCount++;
      const value = cell.t === 'e' ? null : cell.v ?? null;
      // Empty strings and absent formula caches do not enlarge the data range.
      if (value === null || (typeof value === 'string' && value.trim() === '')) continue;
      values.set(columnIndex, typeof value === 'boolean' ? String(value) : value);
      firstColumn = Math.min(firstColumn, columnIndex);
      lastColumn = Math.max(lastColumn, columnIndex);
    }
    if (values.size) records.push(values);
    if (records.length > MAX_ROWS + 1) throw new Error('单次最多导入 50,000 行数据，请拆分工作表后再试。');
    if (lastColumn - firstColumn + 1 > MAX_COLUMNS) throw new Error('单次最多导入 100 列数据，请移除无关列后再试。');
  }
  if (!records.length) throw new Error('当前工作表没有有效数据，请选择其他工作表。');
  const matrix = records.map(values => Array.from({ length: lastColumn - firstColumn + 1 }, (_, i) => values.get(firstColumn + i) ?? null));
  const warnings = [];
  if (formulaCount) warnings.push('公式使用工作簿中已保存的计算结果，导入时不会重新计算。');
  if (missingFormulaCount) warnings.push(`${missingFormulaCount} 个公式没有已保存的结果，已作为空值处理；可在 Excel 中重新计算并保存后导入。`);
  if (errorCount) warnings.push(`${errorCount} 个 Excel 错误单元格已作为空值处理。`);
  if (dateCount) warnings.push('日期或时间单元格保留为 Excel 序列数值，请按需要转换单位。');
  return { matrix, warnings };
}

/** Import XLSX / legacy XLS / ODS locally. Header interpretation matches text import. */
export async function parseSpreadsheet(file, options = {}) {
  const library = getLibrary();
  const cached = await loadWorkbook(file);
  const sheetName = options.sheetName || cached.sheets[0];
  if (!cached.sheets.includes(sheetName)) throw new Error('所选工作表不存在，请重新选择。');
  if (!cached.parsedSheets.has(sheetName)) {
    let workbook;
    try {
      workbook = library.read(cached.bytes, {
        type: 'array', dense: true, sheets: [sheetName],
        cellHTML: false, cellText: false, cellNF: true, cellFormula: true, cellDates: false,
      });
    } catch (error) { throw readError(error); }
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) throw new Error('当前工作表无法读取，请选择其他工作表。');
    cached.parsedSheets.set(sheetName, toMatrix(sheet, library));
  }
  const { matrix, warnings } = cached.parsedSheets.get(sheetName);
  const name = `${file.name || '导入工作簿'} · ${sheetName}`;
  const parsed = parseMatrix(matrix, name, { headerMode: options.headerMode || 'auto' });
  return { ...parsed, warnings: [...warnings, ...parsed.warnings], sheets: cached.sheets.slice(), sheetName };
}
