/** Numerically defined, browser-local column operations. Source columns are immutable. */
const MAX_ROWS = 50000;
const MAX_COLUMNS = 100;
const LABELS = {
  'moving-average': '移动平均', 'median-filter': '中值滤波', 'gaussian-filter': '高斯平滑',
  'savitzky-golay': 'Savitzky–Golay 平滑', butterworth: 'Butterworth 滤波',
  lowpass: '一阶低通', scalar: '常数运算', 'column-math': '列间运算', normalize: '归一化',
  outliers: '异常值处理', derivative: '数值求导', integral: '累积积分', 'fill-missing': '缺失值插值',
};

const finite = value => typeof value === 'number' && Number.isFinite(value);

function validateColumn(dataset, index) {
  if (!dataset || !Array.isArray(dataset.columns) || !Array.isArray(dataset.rows)) throw new Error('数据表格式不正确。');
  if (!Number.isInteger(index) || index < 0 || index >= dataset.columns.length) throw new Error('请选择有效的数据列。');
}

function validateDataset(dataset) {
  if (!dataset || !Array.isArray(dataset.columns) || !Array.isArray(dataset.rows)) throw new Error('数据表格式不正确。');
  if (!dataset.rows.length || dataset.rows.length > MAX_ROWS) throw new Error('数据处理支持 1–50,000 行数据。');
  if (!dataset.columns.length || dataset.columns.length >= MAX_COLUMNS) throw new Error('处理结果需要新增一列，数据表最多支持 100 列。');
  if (dataset.columns.some(name => typeof name !== 'string')) throw new Error('数据列名称格式不正确。');
  for (const row of dataset.rows) {
    if (!Array.isArray(row) || row.length !== dataset.columns.length || row.some(value => value !== null && !finite(value))) throw new Error('数据中包含不合法的数值或列数不一致的数据行。');
  }
}

function quantile(sorted, probability) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position), fraction = position - lower;
  if (fraction === 0) return sorted[lower];
  // Weighted addition avoids overflow for opposite extreme endpoints.
  return sorted[lower] * (1 - fraction) + sorted[lower + 1] * fraction;
}

function summarize(values, totalCount) {
  const count = values.length;
  if (!count) return { count: 0, missing: totalCount, mean: null, median: null, min: null, max: null, std: null, variance: null, q1: null, q3: null, sem: null, rms: null };
  const sorted = [...values].sort((a, b) => a - b);
  const scale = Math.max(Math.abs(sorted[0]), Math.abs(sorted.at(-1)));
  let mean = 0, m2 = 0, scaledMean = 0, scaledM2 = 0, squareMean = 0;
  values.forEach((value, index) => {
    const n = index + 1, delta = value - mean;
    mean += delta / n;
    m2 += delta * (value - mean);
    const unit = scale ? value / scale : 0, scaledDelta = unit - scaledMean;
    scaledMean += scaledDelta / n;
    scaledM2 += scaledDelta * (unit - scaledMean);
    squareMean += (unit * unit - squareMean) / n;
  });
  if (!finite(mean)) mean = scaledMean * scale;
  const directVariance = count > 1 ? m2 / (count - 1) : null;
  const scaledVariance = count > 1 ? Math.max(0, scaledM2 / (count - 1)) : null;
  const variance = count > 1 ? (finite(directVariance) && directVariance >= 0 ? directVariance : scaledVariance * scale * scale) : null;
  const std = count > 1 ? (finite(variance) && (variance > 0 || sorted[0] === sorted.at(-1)) ? Math.sqrt(variance) : Math.sqrt(scaledVariance) * scale) : null;
  const sem = count > 1 ? (finite(std) ? std / Math.sqrt(count) : Math.sqrt(Math.max(0, scaledM2 / ((count - 1) * count))) * scale) : null;
  const safe = value => finite(value) ? value : null;
  return {
    count, missing: totalCount - count, mean: safe(mean), median: quantile(sorted, .5),
    min: sorted[0], max: sorted.at(-1), std: safe(std), variance: safe(variance),
    q1: quantile(sorted, .25), q3: quantile(sorted, .75), sem: safe(sem),
    rms: safe(Math.sqrt(Math.max(0, squareMean)) * scale),
  };
}

/** Descriptive statistics use sample variance (n−1) and R7 interpolated quantiles. */
export function describeColumn(dataset, columnIndex) {
  validateColumn(dataset, columnIndex);
  const values = [];
  for (const row of dataset.rows) if (finite(row?.[columnIndex])) values.push(row[columnIndex]);
  return summarize(values, dataset.rows.length);
}

function numberOption(value, fallback, label, condition = () => true) {
  const result = value === undefined ? fallback : value;
  if (!finite(result) || !condition(result)) throw new Error(`${label}设置不正确。`);
  return result;
}

function choice(value, fallback, available, label) {
  const result = value === undefined ? fallback : value;
  if (!available.includes(result)) throw new Error(`${label}不受支持。`);
  return result;
}

function uniqueColumnName(dataset, requested, fallback) {
  if (requested !== undefined && typeof requested !== 'string') throw new Error('结果列名称必须是文字。');
  const clean = value => [...String(value).toWellFormed().normalize('NFC').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim()].slice(0, 120).join('');
  const base = clean(requested ?? '') || clean(fallback) || '处理结果';
  const used = new Set(dataset.columns.map(clean));
  let name = base, suffix = 2;
  while (used.has(name)) {
    const end = ` (${suffix++})`;
    name = [...base].slice(0, 120 - end.length).join('') + end;
  }
  return name;
}

function orderedX(dataset, column) {
  validateColumn(dataset, column);
  const xs = dataset.rows.map(row => row[column]);
  let previous = null;
  for (const value of xs) {
    if (!finite(value)) continue;
    if (previous !== null && value <= previous) throw new Error('此操作要求有效 X 坐标严格递增，不能包含重复值。请先整理数据顺序。');
    if (previous !== null && !finite(value - previous)) throw new Error('相邻 X 坐标跨度过大，无法可靠计算。请先缩放 X 的单位。');
    previous = value;
  }
  return xs;
}

/** Only target runs bounded by valid neighbors are interpolated; gaps in X are barriers. */
function interpolateTargets(values, xs, targets) {
  const result = values.map((value, index) => targets[index] ? null : value);
  let filled = 0;
  for (let index = 0; index < result.length;) {
    if (!targets[index] || !finite(xs[index])) { index++; continue; }
    const start = index;
    while (index < result.length && targets[index] && finite(xs[index])) index++;
    const left = start - 1, right = index;
    if (left < 0 || right >= result.length || !finite(result[left]) || !finite(result[right]) || !finite(xs[left]) || !finite(xs[right])) continue;
    const span = xs[right] - xs[left];
    if (!finite(span) || span <= 0) throw new Error('插值区间 X 跨度过大，请先缩放单位。');
    for (let target = start; target < right; target++) {
      const ratio = (xs[target] - xs[left]) / span;
      const value = result[left] * (1 - ratio) + result[right] * ratio;
      if (finite(value)) { result[target] = value; filled++; }
    }
  }
  return { values: result, filled };
}

function validSegments(values, xs) {
  const segments = [];
  let start = null;
  for (let index = 0; index <= values.length; index++) {
    const valid = index < values.length && finite(values[index]) && finite(xs[index]);
    if (valid && start === null) start = index;
    if (!valid && start !== null) { segments.push([start, index]); start = null; }
  }
  return segments;
}

/** Local polynomial least squares via reorthogonalized QR; evaluate at centered X=0. */
function polynomialAtCenter(xs, ys, center, degree) {
  const anchor = ys[center], centerX = xs[center];
  const indices = xs.map((x, index) => index).filter(index => finite(xs[index]) && finite(ys[index]));
  if (indices.length < degree + 1) return null;
  const offsets = indices.map(index => xs[index] - centerX);
  const xScale = Math.max(...offsets.map(Math.abs));
  if (!finite(xScale) || xScale <= 0) return null;
  let responseAnchor = anchor;
  let response = indices.map(index => ys[index] - responseAnchor);
  if (response.some(value => !finite(value))) { responseAnchor = 0; response = indices.map(index => ys[index]); }
  const yScale = Math.max(...response.map(Math.abs));
  if (yScale === 0) return anchor;
  const target = response.map(value => value / yScale);
  const coordinates = offsets.map(value => value / xScale);
  const q = [], r = Array.from({ length: degree + 1 }, () => Array(degree + 1).fill(0));
  for (let power = 0; power <= degree; power++) {
    const vector = coordinates.map(value => value ** power);
    for (let pass = 0; pass < 2; pass++) {
      for (let previous = 0; previous < power; previous++) {
        const dot = vector.reduce((sum, value, index) => sum + value * q[previous][index], 0);
        r[previous][power] += dot;
        vector.forEach((value, index) => { vector[index] = value - dot * q[previous][index]; });
      }
    }
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (!finite(norm) || norm < 1e-12) return null;
    r[power][power] = norm;
    q.push(vector.map(value => value / norm));
  }
  const coefficients = Array(degree + 1).fill(0);
  for (let row = degree; row >= 0; row--) {
    let residual = target.reduce((sum, value, index) => sum + value * q[row][index], 0);
    for (let column = row + 1; column <= degree; column++) residual -= r[row][column] * coefficients[column];
    coefficients[row] = residual / r[row][row];
  }
  const value = responseAnchor + coefficients[0] * yScale;
  return finite(value) ? value : null;
}

function requireUniformX(xs) {
  let previous = null, referenceStep = null;
  for (const value of xs) {
    if (!finite(value)) { previous = null; continue; }
    if (previous !== null) {
      const step = value - previous;
      if (referenceStep === null) referenceStep = step;
      else if (Math.abs(step - referenceStep) > Math.abs(referenceStep) * 1e-4) throw new Error('Butterworth 滤波需要等间距 X 采样（步长相对误差不超过 0.01%）。请先重采样，或选择支持非均匀 X 的局部多项式平滑。');
    }
    previous = value;
  }
}

/** Append one calculated column; data, row arrays, and existing columns are not mutated. */
export function processColumn(dataset, options = {}) {
  validateDataset(dataset);
  const column = options.column ?? 1;
  validateColumn(dataset, column);
  const method = options.method;
  if (!Object.hasOwn(LABELS, method)) throw new Error('请选择有效的数据处理方法。');
  const source = dataset.rows.map(row => row[column]);
  const stats = describeColumn(dataset, column);
  if (!stats.count) throw new Error('所选列没有可处理的有效数值。');
  const details = [];
  let result = source.slice(), nonfiniteCount = 0;
  const safe = value => {
    if (finite(value)) return value;
    nonfiniteCount++;
    return null;
  };

  if (['moving-average', 'median-filter', 'gaussian-filter'].includes(method)) {
    const window = numberOption(options.window, 7, '窗口大小（1–101 的奇数）', value => Number.isInteger(value) && value >= 1 && value <= 101 && value % 2 === 1);
    const radius = (window - 1) / 2;
    const sigma = method === 'gaussian-filter' ? numberOption(options.sigma, 1.5, '高斯标准差（大于 0）', value => value > 0) : 1;
    result = source.map((center, index) => {
      if (!finite(center)) return null;
      const neighbors = [];
      for (let offset = -radius; offset <= radius; offset++) {
        const value = source[index + offset];
        if (finite(value)) neighbors.push({ value, weight: method === 'gaussian-filter' ? Math.exp(-.5 * (offset / sigma) ** 2) : 1 });
      }
      if (method === 'median-filter') return quantile(neighbors.map(item => item.value).sort((a, b) => a - b), .5);
      const weightTotal = neighbors.reduce((sum, item) => sum + item.weight, 0);
      return safe(neighbors.reduce((sum, item) => sum + item.value * (item.weight / weightTotal), 0));
    });
    details.push(`使用 ${window} 点居中窗口；边缘缩短窗口并重新归一化。`, '中心缺失值保持为空，邻域缺失值不参与计算。');
    if (method === 'gaussian-filter') details.push(`高斯 σ = ${sigma}（采样点单位）。`);
  } else if (method === 'savitzky-golay') {
    const window = numberOption(options.window, 7, '窗口大小（3–101 的奇数）', value => Number.isInteger(value) && value >= 3 && value <= 101 && value % 2 === 1);
    const degree = numberOption(options.degree, 2, '多项式阶数（2–5 且小于窗口）', value => Number.isInteger(value) && value >= 2 && value <= 5 && value < window);
    const xs = orderedX(dataset, options.xColumn ?? 0);
    const radius = (window - 1) / 2;
    let skipped = 0;
    result = source.map((value, index) => {
      if (!finite(value) || !finite(xs[index])) return null;
      const start = Math.max(0, Math.min(index - radius, source.length - window));
      const end = Math.min(source.length, start + window);
      const fitted = polynomialAtCenter(xs.slice(start, end), source.slice(start, end), index - start, degree);
      if (fitted === null) skipped++;
      return fitted;
    });
    details.push(`${window} 点窗口、${degree} 阶局部多项式最小二乘；使用真实 X 坐标，支持非均匀采样。`, '边缘移动拟合窗口，不使用镜像填充；邻域缺失点会跳过，可利用缺失点两侧邻居，但中心缺失 X / Y 保持为空。');
    if (source.length < window) details.push(`数据少于窗口长度，使用现有 ${source.length} 行拟合。`);
    if (skipped) details.push(`${skipped} 处窗口有效点不足 ${degree + 1} 个或拟合不稳定，结果保留为空。`);
  } else if (method === 'butterworth') {
    const filterType = choice(options.filterType, 'lowpass', ['lowpass', 'highpass'], 'Butterworth 类型');
    const sampleRate = numberOption(options.sampleRate, 100, '采样率（大于 0）', value => value > 0);
    const cutoff = numberOption(options.cutoff, 5, '截止频率（大于 0 且低于奈奎斯特频率）', value => value > 0 && value < sampleRate / 2);
    const xs = orderedX(dataset, options.xColumn ?? 0);
    requireUniformX(xs);
    const omega = 2 * Math.PI * (cutoff / sampleRate);
    const alpha = Math.sin(omega) / Math.SQRT2;
    const a0 = 1 + alpha;
    const a1 = -2 * Math.cos(omega) / a0, a2 = (1 - alpha) / a0;
    const b0 = (filterType === 'lowpass' ? Math.sin(omega / 2) ** 2 : Math.cos(omega / 2) ** 2) / a0;
    const b1 = (filterType === 'lowpass' ? 2 : -2) * b0, b2 = b0;
    if (!finite(a1) || !finite(a2) || a2 >= 1 || b0 === 0) throw new Error('截止频率过于接近 0 或奈奎斯特频率，已超出可靠计算精度。请调整截止频率。');
    let x1 = null, x2 = null, y1 = null, y2 = null;
    result = source.map((value, index) => {
      if (!finite(value) || !finite(xs[index])) { x1 = null; return null; }
      if (x1 === null) {
        x1 = x2 = value; y1 = y2 = filterType === 'lowpass' ? value : 0;
        return y1;
      }
      const output = safe(b0 * value + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2);
      if (output === null) { x1 = null; return null; }
      x2 = x1; x1 = value; y2 = y1; y1 = output;
      return output;
    });
    details.push(`二阶 Butterworth ${filterType === 'lowpass' ? '低通' : '高通'}，Q = 1/√2；截止频率 ${cutoff}，采样率 ${sampleRate}，截止处单程幅度约 −3 dB。`, '单向因果滤波会产生相位延迟；不是双向零相位滤波。', '频率单位与输入采样率一致，X 用于验证等间距；每段使用首值对应稳态初值，缺失 X / Y 时重置。');
  } else if (method === 'lowpass') {
    const alpha = numberOption(options.alpha, .25, '平滑系数 α（大于 0 且不超过 1）', value => value > 0 && value <= 1);
    let previous = null;
    result = source.map(value => {
      if (!finite(value)) { previous = null; return null; }
      previous = previous === null ? value : safe(alpha * value + (1 - alpha) * previous);
      return previous;
    });
    details.push(`一阶递推：输出 = ${alpha} × 当前值 + ${1 - alpha} × 上次输出。`, '每个连续有效段从首个原始值开始；遇到缺失值时重置。');
  } else if (method === 'scalar' || method === 'column-math') {
    const operator = choice(options.operator, 'add', ['add', 'subtract', 'multiply', 'divide'], '运算符');
    const symbols = { add: '+', subtract: '−', multiply: '×', divide: '÷' };
    let other, zeroCount = 0;
    if (method === 'scalar') other = numberOption(options.value, 1, '常数');
    else { other = options.otherColumn ?? 2; validateColumn(dataset, other); }
    result = source.map((value, index) => {
      const right = method === 'scalar' ? other : dataset.rows[index][other];
      if (!finite(value) || !finite(right)) return null;
      if (operator === 'divide' && right === 0) { zeroCount++; return null; }
      return safe(operator === 'add' ? value + right : operator === 'subtract' ? value - right : operator === 'multiply' ? value * right : value / right);
    });
    details.push(`结果 = ${dataset.columns[column]} ${symbols[operator]} ${method === 'scalar' ? other : dataset.columns[other]}。`);
    if (zeroCount) details.push(`${zeroCount} 处分母为 0，结果保留为空。`);
    if (method === 'column-math') details.push('按同一行逐项计算，任一操作数缺失时结果为空。');
  } else if (method === 'normalize') {
    const mode = choice(options.normalize, 'minmax', ['minmax', 'zscore'], '归一化方式');
    const constant = stats.min === stats.max;
    if (constant) {
      result = source.map(value => finite(value) ? 0 : null);
      details.push('有效数值为常数，归一化结果统一设为 0；原有缺失值保持为空。');
    } else if (mode === 'minmax') {
      const span = stats.max - stats.min;
      result = source.map(value => finite(value) ? safe(finite(span) ? (value - stats.min) / span : (value / 2 - stats.min / 2) / (stats.max / 2 - stats.min / 2)) : null);
      details.push('最小–最大归一化：(Y − 最小值) / (最大值 − 最小值)，映射到 [0, 1]。');
    } else {
      if (!finite(stats.std) || stats.std <= 0) throw new Error('数值跨度过大，无法可靠进行 Z-score 标准化，请先缩放数据。');
      result = source.map(value => finite(value) ? safe(finite(value - stats.mean) ? (value - stats.mean) / stats.std : value / stats.std - stats.mean / stats.std) : null);
      details.push('Z-score 标准化：(Y − 均值) / 样本标准差；标准差采用 n−1 分母。');
    }
  } else if (method === 'outliers') {
    const rule = choice(options.outlierRule, 'iqr', ['iqr', 'zscore'], '异常值判据');
    const threshold = numberOption(options.threshold, rule === 'iqr' ? 1.5 : 3, '异常值阈值（大于 0）', value => value > 0);
    const action = choice(options.action, 'remove', ['remove', 'clip', 'interpolate'], '异常值处理方式');
    let lower, upper;
    if (rule === 'iqr') {
      const iqr = stats.q3 - stats.q1;
      lower = stats.q1 - threshold * iqr; upper = stats.q3 + threshold * iqr;
      details.push(`IQR 规则：低于 Q1 − ${threshold} × IQR 或高于 Q3 + ${threshold} × IQR 判为异常；四分位数采用 R7。`);
    } else {
      if (stats.std === null && stats.count >= 2) throw new Error('数值跨度过大，无法可靠计算异常值的标准差，请先缩放数据。');
      if (stats.std === null || stats.std === 0) { lower = -Infinity; upper = Infinity; details.push('样本不足或标准差为 0，没有标记异常值。'); }
      else { lower = stats.mean - threshold * stats.std; upper = stats.mean + threshold * stats.std; }
      details.push(`Z-score 规则：与均值之差超过 ${threshold} 倍样本标准差判为异常。`);
    }
    const targets = source.map(value => finite(value) && (value < lower || value > upper));
    const flagged = targets.filter(Boolean).length;
    if (action === 'remove') result = source.map((value, index) => targets[index] ? null : value);
    else if (action === 'clip') result = source.map((value, index) => targets[index] ? safe(Math.max(lower, Math.min(upper, value))) : value);
    else {
      const xs = orderedX(dataset, options.xColumn ?? 0);
      const interpolation = interpolateTargets(source, xs, targets);
      result = interpolation.values;
      details.push(`已按 X 线性插值 ${interpolation.filled} 个异常点；${flagged - interpolation.filled} 个无法内插的异常点保留为空。`, '不进行边缘外推，不跨越缺失 X 或原有缺失 Y；原有缺失值保持为空。');
    }
    details.push(`共识别 ${flagged} 个异常值；${action === 'remove' ? '置为空值，不删除数据行' : action === 'clip' ? '限制在判据上下界' : '替换为邻点插值'}。`);
  } else if (method === 'fill-missing') {
    const xs = orderedX(dataset, options.xColumn ?? 0);
    const interpolation = interpolateTargets(source, xs, source.map(value => !finite(value)));
    result = interpolation.values;
    details.push(`按 X 线性插值补齐 ${interpolation.filled} 个内点缺失值。`, '仅在两侧有效数据之间内插；不进行边缘外推，不填补或跨越缺失 X。');
  } else {
    const xs = orderedX(dataset, options.xColumn ?? 0);
    const segments = validSegments(source, xs);
    result = source.map(() => null);
    for (const [start, end] of segments) {
      if (method === 'derivative') {
        if (end - start < 2) continue;
        const slope = (left, right) => (source[right] - source[left]) / (xs[right] - xs[left]);
        result[start] = safe(slope(start, start + 1));
        result[end - 1] = safe(slope(end - 2, end - 1));
        for (let index = start + 1; index < end - 1; index++) {
          const before = xs[index] - xs[index - 1], after = xs[index + 1] - xs[index];
          const span = before + after;
          const leftWeight = finite(span) ? after / span : (after / Math.max(before, after)) / (before / Math.max(before, after) + after / Math.max(before, after));
          result[index] = safe(leftWeight * slope(index - 1, index) + (1 - leftWeight) * slope(index, index + 1));
        }
      } else {
        let integral = 0, compensation = 0;
        result[start] = 0;
        for (let index = start + 1; index < end; index++) {
          const area = (source[index - 1] / 2 + source[index] / 2) * (xs[index] - xs[index - 1]);
          const increment = area - compensation;
          const next = integral + increment;
          compensation = (next - integral) - increment;
          integral = next;
          result[index] = safe(integral);
        }
      }
    }
    if (method === 'derivative') details.push('对 X 求导：段内采用适用于非等间距 X 的三点公式，端点采用相邻两点单侧差分。', '缺失 X 或 Y 会断开计算；只有一个点的段结果为空。');
    else details.push(`使用梯形法按 X 累积积分，共 ${segments.length} 个连续有效段，每段从 0 重新开始。`, '缺失 X 或 Y 会断开积分，不跨越缺失值累计面积。');
  }
  if (nonfiniteCount) details.push(`${nonfiniteCount} 个结果超出有限数值范围，已保留为空；请调整数据量级后重试。`);
  const name = uniqueColumnName(dataset, options.name, `${dataset.columns[column]} · ${LABELS[method]}`);
  const next = { ...dataset, columns: [...dataset.columns, name], rows: dataset.rows.map((row, index) => [...row, result[index]]) };
  const columnIndex = next.columns.length - 1;
  const changedCount = result.reduce((count, value, index) => count + (value === source[index] ? 0 : 1), 0);
  return { dataset: next, columnIndex, report: { label: LABELS[method], changedCount, details }, statistics: describeColumn(next, columnIndex) };
}
