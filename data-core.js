/** Browser-local numeric data import and project validation. No network or dependencies. */
const MAX_ROWS = 50000;
const MAX_COLUMNS = 100;
const MAX_INPUT_LENGTH = 25 * 1024 * 1024;
const numericPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const missingPattern = /^(?:n\/?a|null|nan|--?|—)$/i;

function numberValue(value) {
  const text = String(value ?? '').trim();
  if (!text || missingPattern.test(text)) return { value: null, invalid: false };
  if (!numericPattern.test(text)) return { value: null, invalid: true };
  const number = Number(text);
  return Number.isFinite(number) ? { value: number, invalid: false } : { value: null, invalid: true };
}

function detectDelimiter(text) {
  const candidates = [',', '\t', ';'];
  const counts = candidates.map(() => []);
  let current = [0, 0, 0];
  let quoted = false;
  for (let i = 0; i < Math.min(text.length, 64000); i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') i++;
      else quoted = !quoted;
    } else if (!quoted && (char === '\n' || char === '\r')) {
      if (current.some(Boolean)) current.forEach((count, index) => counts[index].push(count));
      current = [0, 0, 0];
      if (char === '\r' && text[i + 1] === '\n') i++;
      if (counts.some(values => values.length >= 20)) break;
    } else if (!quoted) {
      const index = candidates.indexOf(char);
      if (index >= 0) current[index]++;
    }
  }
  if (current.some(Boolean)) current.forEach((count, index) => counts[index].push(count));
  let best = null;
  let bestScore = 0;
  counts.forEach((values, index) => {
    const positive = values.filter(value => value > 0);
    if (!positive.length) return;
    const frequencies = new Map();
    for (const value of positive) frequencies.set(value, (frequencies.get(value) || 0) + 1);
    let consistency = 0;
    for (const frequency of frequencies.values()) consistency = Math.max(consistency, frequency);
    const score = consistency * 10 + positive.length + Math.min(positive[0], 10) / 20;
    if (score > bestScore) { best = candidates[index]; bestScore = score; }
  });
  return best;
}

function readRecords(text, delimiter) {
  if (!delimiter) {
    const lines = text.split(/\r\n|\n|\r/).filter(line => line.trim());
    if (lines.length > MAX_ROWS + 1) throw new Error(`单次最多导入 ${MAX_ROWS.toLocaleString('en-US')} 行数据，请拆分文件后再试。`);
    return lines.map(line => line.trim().split(/\s+/));
  }
  const records = [];
  let row = [];
  let field = '';
  let quoted = false;
  let closedQuote = false;
  const finishField = () => {
    row.push(field.trim());
    if (row.length > MAX_COLUMNS) throw new Error(`单次最多导入 ${MAX_COLUMNS} 列数据。`);
    field = '';
    closedQuote = false;
  };
  const finishRow = () => {
    finishField();
    if (row.some(value => value !== '')) records.push(row);
    if (records.length > MAX_ROWS + 1) throw new Error(`单次最多导入 ${MAX_ROWS.toLocaleString('en-US')} 行数据，请拆分文件后再试。`);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; closedQuote = true; }
      } else field += char;
    } else if (char === '"' && field.trim() === '' && !closedQuote) {
      quoted = true;
      field = '';
    } else if (char === delimiter) finishField();
    else if (char === '\r' || char === '\n') {
      finishRow();
      if (char === '\r' && text[i + 1] === '\n') i++;
    } else if (closedQuote && char.trim()) {
      throw new Error('CSV 引号后的内容格式不正确，请检查分隔符或双引号。');
    } else field += char;
  }
  if (quoted) throw new Error('CSV 中有未闭合的双引号，请检查文件后重试。');
  if (field !== '' || row.length) finishRow();
  return records;
}

function columnNames(header, count) {
  const used = new Set();
  return Array.from({ length: count }, (_, index) => {
    const base = (String(header?.[index] ?? '').trim() || (index === 0 ? 'X' : `Y${index}`)).slice(0, 120);
    let name = base;
    let suffix = 2;
    while (used.has(name)) name = `${base} (${suffix++})`;
    used.add(name);
    return name;
  });
}

/** Import comma-, tab-, semicolon-, or whitespace-separated numeric columns. */
export function parseDelimited(text, name = '导入数据.csv', options = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('文件内容为空，请导入至少两列、两行数值数据。');
  if (text.length > MAX_INPUT_LENGTH) throw new Error('文件过大，请使用 25 MB 以内的文本数据文件。');
  const content = text.replace(/^\uFEFF/, '');
  const requestedDelimiter = options.delimiter ?? 'auto';
  if (!['auto', ',', ';', '\t', 'whitespace'].includes(requestedDelimiter)) throw new Error('不支持所选的分隔符。');
  const delimiter = requestedDelimiter === 'auto' ? detectDelimiter(content) : requestedDelimiter === 'whitespace' ? null : requestedDelimiter;
  return parseMatrix(readRecords(content, delimiter), name, options);
}

/** Share header detection and numeric conversion with the Excel importer. */
export function parseMatrix(matrix, name = '导入数据', options = {}) {
  if (!Array.isArray(matrix) || matrix.some(row => !Array.isArray(row))) throw new Error('数据表格式不正确，请使用按行排列的表格。');
  if (matrix.length > MAX_ROWS + 1) throw new Error(`单次最多导入 ${MAX_ROWS.toLocaleString('en-US')} 行数据，请拆分文件后再试。`);
  const records = matrix.filter(row => row.some(value => value !== null && value !== undefined && String(value).trim() !== ''));
  if (!records.length) throw new Error('没有找到可绘制的数据。');
  const headerMode = options.headerMode ?? 'auto';
  if (!['auto', 'yes', 'no'].includes(headerMode)) throw new Error('表头模式格式不正确。');
  const first = records[0];
  const firstHasText = first.some(value => numberValue(value).invalid);
  const laterHasNumber = records.slice(1, 8).some(row => row.some(value => numberValue(value).value !== null));
  // A numeric first coordinate remains data even if one of its Y cells is bad.
  // Numeric table headers remain available through the explicit header switch.
  const firstCoordinateIsNumeric = numberValue(first[0]).value !== null;
  const hasHeader = headerMode === 'yes' || headerMode === 'auto' && firstHasText && laterHasNumber && !firstCoordinateIsNumeric;
  const rawRows = hasHeader ? records.slice(1) : records;
  const columnCount = records.reduce((max, row) => Math.max(max, row.length), 0);
  if (columnCount < 2) throw new Error('至少需要两列数据：一列 X 坐标和一列 Y 数值。支持逗号、制表符、分号或空格分隔。');
  if (columnCount > MAX_COLUMNS) throw new Error(`单次最多导入 ${MAX_COLUMNS} 列数据。`);
  if (rawRows.length < 2) throw new Error('至少需要两行数值数据才能绘图。');
  if (rawRows.length > MAX_ROWS) throw new Error(`单次最多导入 ${MAX_ROWS.toLocaleString('en-US')} 行数据，请拆分文件后再试。`);
  let invalidCount = 0;
  let missingCount = 0;
  let numericCount = 0;
  let shortRows = 0;
  const rows = rawRows.map(rawRow => {
    if (rawRow.length < columnCount) shortRows++;
    return Array.from({ length: columnCount }, (_, index) => {
      const parsed = numberValue(rawRow[index]);
      if (parsed.invalid) invalidCount++;
      if (parsed.value === null) missingCount++;
      else numericCount++;
      return parsed.value;
    });
  });
  if (!numericCount) throw new Error('没有找到有效数值，请检查数据格式和分隔符。');
  const populatedColumns = Array.from({ length: columnCount }, (_, index) => rows.some(row => row[index] !== null)).filter(Boolean).length;
  if (populatedColumns < 2) throw new Error('至少两列中需要包含有效数值，才能指定 X 和 Y 数据。');
  const warnings = [];
  if (!hasHeader) warnings.push(headerMode === 'no' ? '已按无表头数据处理，列名为 X、Y1、Y2…' : '未检测到表头，已自动命名为 X、Y1、Y2…');
  if (invalidCount) warnings.push(`${invalidCount} 个非数值单元格已作为缺失值保留，不会转换为 0。`);
  if (missingCount) warnings.push(`共 ${missingCount} 个缺失值；绘图时对应位置会断开。`);
  if (shortRows) warnings.push(`${shortRows} 行列数不足，已在行末补充缺失值。`);
  return { dataset: { name: String(name).slice(0, 240), columns: columnNames(hasHeader ? first : null, columnCount), rows }, warnings };
}

/** A deterministic, representative three-series experiment, including subtle detail. */
export function makeDemoDataset() {
  const rows = [];
  for (let index = 0; index <= 150; index++) {
    const time = index / 5;
    const trend = 39.3 + 0.25 * time + 3.1 * Math.sin(time * 0.65 - 0.4) + 1.65 * Math.sin(time * 1.23);
    const detail = 0.45 * Math.sin(time * 6.6) + 0.25 * Math.cos(time * 10.5);
    const dip = 3.9 * Math.exp(-(((time - 18.2) / 1.1) ** 2));
    const lift = 3.3 / (1 + Math.exp(-(time - 28.1) * 3));
    const a = trend + detail - dip + lift;
    const b = trend + 1.9 + 0.8 * Math.sin(time * 0.8 + 0.6) - dip * 0.7 + lift;
    const c = trend + 4.1 + 0.6 * Math.sin(time * 1.4 - 0.4) - dip * 0.4 + lift;
    rows.push([Number(time.toFixed(1)), Number(a.toFixed(3)), Number(b.toFixed(3)), Number(c.toFixed(3))]);
  }
  return { name: '动态响应实验.csv', columns: ['时间 (s)', '实验值', '模型 A', '模型 B'], rows };
}

function csvField(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function datasetToCSV(dataset) {
  if (!dataset || !Array.isArray(dataset.columns) || !Array.isArray(dataset.rows)) throw new Error('数据表格式不正确。');
  return '\uFEFF' + [dataset.columns, ...dataset.rows].map(row => row.map(csvField).join(',')).join('\r\n');
}

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function projectText(value, fallback, label, limit = 500) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > limit) throw new Error(`${label}格式不正确。`);
  return value;
}

function projectBoolean(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${label}格式不正确。`);
  return value;
}

function projectChoice(value, fallback, choices, label) {
  if (value === undefined) return fallback;
  if (!choices.includes(value)) throw new Error(`${label}不受支持。`);
  return value;
}

function projectNumber(value, fallback, min, max, label) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${label}需在 ${min}–${max} 之间。`);
  return value;
}

function projectBound(value, fallback = '') {
  if (value === undefined) return fallback;
  if (typeof value === 'string' && value.trim() === '') return '';
  if ((typeof value !== 'number' && typeof value !== 'string') || !numericPattern.test(String(value).trim()) || !Number.isFinite(Number(value))) throw new Error('坐标范围必须为有效数值或留空。');
  return Number(value);
}

function projectBounds(value) {
  const bounds = Object.fromEntries(['xMin', 'xMax', 'yMin', 'yMax'].map(key => [key, projectBound(value[key])]));
  for (const axis of ['x', 'y']) {
    const lo = bounds[`${axis}Min`], hi = bounds[`${axis}Max`];
    if (lo !== '' && hi !== '' && lo >= hi) throw new Error('坐标范围起点必须小于终点。');
  }
  return bounds;
}

/** Validate and normalize external JSON, retaining only supported project fields. */
export function validateProject(value) {
  if (!isRecord(value)) throw new Error('项目文件格式不正确。');
  if (value.schemaVersion !== 1) throw new Error('不支持此项目版本，请使用简图导出的版本 1 项目文件。');
  const dataset = value.dataset;
  if (!isRecord(dataset) || !Array.isArray(dataset.columns) || !Array.isArray(dataset.rows)) throw new Error('项目缺少有效的数据表。');
  if (dataset.columns.length < 2 || dataset.columns.length > MAX_COLUMNS) throw new Error(`项目数据表需包含 2–${MAX_COLUMNS} 列。`);
  if (dataset.columns.some(column => typeof column !== 'string' || column.length > 500)) throw new Error('项目列名格式不正确。');
  if (dataset.rows.length < 2 || dataset.rows.length > MAX_ROWS) throw new Error(`项目数据表需包含 2–${MAX_ROWS.toLocaleString('en-US')} 行。`);
  if (dataset.rows.some(row => !Array.isArray(row) || row.length !== dataset.columns.length || row.some(cell => cell !== null && (typeof cell !== 'number' || !Number.isFinite(cell))))) throw new Error('项目中包含不合法的数值或列数不一致的数据行。');
  const datasetName = projectText(dataset.name, '导入数据', '项目数据名称');
  if (!Array.isArray(value.series) || value.series.length > 30 || value.series.length === 0) throw new Error('项目需包含 1–30 条曲线。');
  const seriesIds = new Set();
  const normalizedSeries = value.series.map((series, index) => {
    if (!isRecord(series) || !Number.isInteger(series.xColumn) || !Number.isInteger(series.yColumn) || series.xColumn < 0 || series.yColumn < 0 || series.xColumn >= dataset.columns.length || series.yColumn >= dataset.columns.length) throw new Error('项目曲线引用了不存在的数据列。');
    const id = series.id ?? `import-series-${index + 1}`;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(id) || seriesIds.has(id)) throw new Error('曲线标识需为不重复的字母、数字、下划线或短横线。');
    seriesIds.add(id);
    let color = series.color ?? ['#347c9c', '#d97559', '#579b87', '#a492b3', '#d7b56d', '#596a79'][index % 6];
    if (typeof color !== 'string' || !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color)) throw new Error('曲线颜色需为有效的 3 位或 6 位十六进制颜色。');
    if (color.length === 4) color = '#' + [...color.slice(1)].map(char => char + char).join('');
    return {
      id, name: projectText(series.name, dataset.columns[series.yColumn], '曲线名称'),
      xColumn: series.xColumn, yColumn: series.yColumn, color,
      width: projectNumber(series.width, 2.2, .1, 20, '曲线线宽'),
      markerSize: projectNumber(series.markerSize, 6, 0, 30, '曲线标记大小'),
      visible: projectBoolean(series.visible, true, '曲线可见性'),
      dash: projectChoice(series.dash, 'solid', ['solid', 'dashed', 'dotted', 'dashdot'], '曲线线型'),
      marker: projectChoice(series.marker, ['circle', 'square', 'triangle', 'diamond'][index % 4], ['circle', 'square', 'triangle', 'diamond', 'none'], '曲线标记'),
    };
  });
  for (const key of ['axes', 'legend', 'inset', 'axisBreak']) {
    if (value[key] !== undefined && !isRecord(value[key])) throw new Error(`项目 ${key} 配置格式不正确。`);
  }
  const axes = value.axes || {};
  const legend = value.legend || {}, inset = value.inset || {}, axisBreak = value.axisBreak || {};
  const positions = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  const from = projectBound(axisBreak.from, 10), to = projectBound(axisBreak.to, 14);
  const breakEnabled = projectBoolean(axisBreak.enabled, false, '断轴开关');
  if (breakEnabled && (from === '' || to === '' || from >= to)) throw new Error('断轴范围需要两个有效数值，且起点必须小于终点。');
  return {
    schemaVersion: 1,
    projectName: projectText(value.projectName, datasetName, '项目名称'),
    dataset: { name: datasetName, columns: dataset.columns, rows: dataset.rows },
    series: normalizedSeries,
    chartType: projectChoice(value.chartType, 'line-scatter', ['line', 'scatter', 'line-scatter', 'bar'], '项目图表类型'),
    title: projectText(value.title, '', '项目标题'),
    template: projectChoice(value.template, 'custom', ['classic', 'minimal', 'contrast', 'scatter', 'mono', 'bar', 'custom'], '模板'),
    palette: projectChoice(value.palette, 'journal', ['journal', 'nature', 'accessible', 'reference', 'mono', 'vivid'], '配色'),
    axes: {
      ...projectBounds(axes),
      xLabel: projectText(axes.xLabel, dataset.columns[normalizedSeries[0].xColumn], 'X 轴标题'),
      yLabel: projectText(axes.yLabel, normalizedSeries.length === 1 ? normalizedSeries[0].name : '数值', 'Y 轴标题'),
      fontFamily: projectText(axes.fontFamily, 'Times New Roman', '图表字体'),
      fontSize: projectNumber(axes.fontSize, 18, 6, 72, '坐标字号'),
      grid: projectBoolean(axes.grid, true, '网格线开关'),
      minorTicks: projectBoolean(axes.minorTicks, true, '次刻度开关'),
      frame: projectBoolean(axes.frame, true, '坐标边框开关'),
    },
    legend: {
      show: projectBoolean(legend.show, true, '图例开关'),
      border: projectBoolean(legend.border, false, '图例边框'),
      position: projectChoice(legend.position, 'top-left', positions, '图例位置'),
    },
    inset: {
      ...projectBounds(inset),
      enabled: projectBoolean(inset.enabled, false, '局部放大开关'),
      position: projectChoice(inset.position, 'top-right', positions, '局部放大位置'),
    },
    axisBreak: { enabled: breakEnabled, from, to },
  };
}
