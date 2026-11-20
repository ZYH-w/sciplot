/** Local, unweighted engineering analysis. No external runtime or source-data mutation. */
const finite = value => typeof value === 'number' && Number.isFinite(value);
const COLORS = ['#16836b', '#d97559', '#617bb6', '#a492b3', '#d7b56d', '#579b87'];
const safe = value => finite(value) ? value : null;
function requireNumber(value, fallback, label, condition = () => true) {
  const result = value === undefined ? fallback : value;
  if (!finite(result) || !condition(result)) throw new Error(`${label}设置不正确。`);
  return result;
}
function requireChoice(value, fallback, allowed, label) {
  const result = value === undefined ? fallback : value;
  if (!allowed.includes(result)) throw new Error(`${label}不受支持。`);
  return result;
}
function requireColumn(dataset, index) {
  if (!Number.isInteger(index) || index < 0 || index >= dataset.columns.length) throw new Error('请选择有效的数据列。');
  return index;
}
function validate(dataset) {
  if (!dataset || !Array.isArray(dataset.columns) || !Array.isArray(dataset.rows) || !dataset.rows.length || dataset.rows.length > 50000 || !dataset.columns.length || dataset.columns.length > 100) throw new Error('分析需要 1–50,000 行、1–100 列数值数据。');
  if (dataset.columns.some(column => typeof column !== 'string') || dataset.rows.some(row => !Array.isArray(row) || row.length !== dataset.columns.length || row.some(value => value !== null && !finite(value)))) throw new Error('数据表中存在不合法的数值或列数不一致的数据行。');
}
function mean(values) {
  let result = 0;
  values.forEach((value, index) => { result += (value - result) / (index + 1); });
  if (!finite(result)) {
    let scale = 0; for (const value of values) scale = Math.max(scale, Math.abs(value));
    result = values.reduce((sum, value) => sum + value / scale / values.length, 0) * scale;
  }
  return result;
}
function squaredNorm(values) { let sum = 0; for (const value of values) sum += value * value; return sum; }
function rootMeanSquare(values) {
  let scale = 0; for (const value of values) scale = Math.max(scale, Math.abs(value));
  return scale ? scale * Math.sqrt(values.reduce((sum, value) => sum + (value / scale) ** 2, 0) / values.length) : 0;
}
function series(name, xColumn, yColumn, index = 0, extra = {}) {
  return { name, xColumn, yColumn, color: COLORS[index % COLORS.length], width: 2.2, dash: 'solid', marker: 'none', markerSize: 5, visible: true, ...extra };
}
function appendColumns(dataset, definitions) {
  if (dataset.columns.length + definitions.length > 100) throw new Error(`本次需要新增 ${definitions.length} 列，合计将超过 100 列上限，请减少数据列后再试。`);
  const columns = dataset.columns.slice(), indices = [];
  for (const definition of definitions) {
    const base = [...String(definition.name).toWellFormed().normalize('NFC').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim()].slice(0, 110).join('') || '分析结果';
    let name = base, suffix = 2;
    while (columns.includes(name)) name = `${base} (${suffix++})`;
    indices.push(columns.length); columns.push(name);
  }
  return { dataset: { ...dataset, columns, rows: dataset.rows.map((row, index) => [...row, ...definitions.map(definition => safe(definition.values[index]))]) }, indices };
}

// Lanczos log-gamma and a convergent incomplete-beta continued fraction provide
// Student-t quantiles, including small replicate counts (df=1,2,...).
function logGamma(z) {
  const coefficients = [676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406, 12.507343278686905, -.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7];
  if (z < .5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
  z -= 1;
  let value = .99999999999980993;
  coefficients.forEach((coefficient, index) => { value += coefficient / (z + index + 1); });
  const t = z + coefficients.length - .5;
  return .5 * Math.log(2 * Math.PI) + (z + .5) * Math.log(t) - t + Math.log(value);
}
function betaFraction(a, b, x) {
  const tiny = 1e-300, sum = a + b;
  let c = 1, d = 1 - sum * x / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let result = d;
  for (let m = 1; m <= 300; m++) {
    const twice = 2 * m;
    let term = m * (b - m) * x / ((a + twice - 1) * (a + twice));
    d = 1 + term * d; if (Math.abs(d) < tiny) d = tiny;
    c = 1 + term / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d; result *= d * c;
    term = -(a + m) * (sum + m) * x / ((a + twice) * (a + twice + 1));
    d = 1 + term * d; if (Math.abs(d) < tiny) d = tiny;
    c = 1 + term / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const multiplier = d * c; result *= multiplier;
    if (Math.abs(multiplier - 1) < 2e-14) return result;
  }
  throw new Error('统计分布计算未收敛，请检查样本数。');
}
function regularizedBeta(x, a, b) {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const factor = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x));
  return x < (a + 1) / (a + b + 2) ? factor * betaFraction(a, b, x) / a : 1 - factor * betaFraction(b, a, 1 - x) / b;
}
const tCriticalCache = new Map();
export function studentTCritical95(df) {
  if (!Number.isInteger(df) || df < 1 || df > 50000) throw new Error('置信区间至少需要 1 个有效自由度。');
  if (tCriticalCache.has(df)) return tCriticalCache.get(df);
  const cdf = t => 1 - .5 * regularizedBeta(df / (df + t * t), df / 2, .5);
  let lower = 0, upper = 2;
  while (cdf(upper) < .975) upper *= 2;
  for (let index = 0; index < 80; index++) { const middle = (lower + upper) / 2; if (cdf(middle) < .975) lower = middle; else upper = middle; }
  const value = (lower + upper) / 2; tCriticalCache.set(df, value); return value;
}

/** Modified Gram-Schmidt with a second orthogonalization pass. */
function qrFit(xs, ys, degree) {
  let minimum = Infinity, maximum = -Infinity;
  for (const x of xs) { minimum = Math.min(minimum, x); maximum = Math.max(maximum, x); }
  const center = minimum / 2 + maximum / 2, scale = Math.max(Math.abs(minimum - center), Math.abs(maximum - center));
  if (!finite(scale) || scale === 0) throw new Error('拟合要求 X 至少包含两个不同数值，且数值跨度可计算。');
  const z = xs.map(x => (x - center) / scale), anchor = mean(ys);
  const centeredY = ys.map(y => y - anchor);
  let responseScale = 0; for (const y of centeredY) responseScale = Math.max(responseScale, Math.abs(y));
  if (!finite(responseScale)) throw new Error('Y 数值跨度过大，请先缩放数据。');
  if (!responseScale) responseScale = 1;
  const target = centeredY.map(y => y / responseScale), p = degree + 1;
  const q = [], r = Array.from({ length: p }, () => Array(p).fill(0));
  for (let power = 0; power < p; power++) {
    const vector = z.map(value => value ** power);
    for (let pass = 0; pass < 2; pass++) {
      for (let previous = 0; previous < power; previous++) {
        let dot = 0; for (let i = 0; i < vector.length; i++) dot += vector[i] * q[previous][i];
        r[previous][power] += dot;
        for (let i = 0; i < vector.length; i++) vector[i] -= dot * q[previous][i];
      }
    }
    const norm = Math.sqrt(squaredNorm(vector));
    if (!finite(norm) || norm < Math.sqrt(xs.length) * 1e-11) throw new Error('拟合矩阵秩不足或接近奇异，请降低阶数并检查不同 X 值的数量。');
    r[power][power] = norm; q.push(vector.map(value => value / norm));
  }
  const solve = rhs => {
    const coefficients = Array(p).fill(0);
    for (let row = p - 1; row >= 0; row--) {
      let value = rhs[row]; for (let j = row + 1; j < p; j++) value -= r[row][j] * coefficients[j];
      coefficients[row] = value / r[row][row];
    }
    return coefficients;
  };
  const normalized = solve(q.map(column => column.reduce((sum, value, index) => sum + value * target[index], 0)));
  const coefficients = normalized.map(value => value * responseScale); coefficients[0] += anchor;
  const inverseR = Array.from({ length: p }, () => Array(p).fill(0));
  for (let column = 0; column < p; column++) {
    const unit = Array(p).fill(0); unit[column] = 1;
    solve(unit).forEach((value, row) => { inverseR[row][column] = value; });
  }
  const covarianceBase = Array.from({ length: p }, (_, i) => Array.from({ length: p }, (_, j) => inverseR[i].reduce((sum, value, k) => sum + value * inverseR[j][k], 0)));
  const predict = x => { const value = (x - center) / scale; let sum = coefficients.at(-1); for (let i = p - 2; i >= 0; i--) sum = sum * value + coefficients[i]; return sum; };
  return { coefficients, center, scale, covarianceBase, predict };
}

function comparisonMetrics(observed, predicted) {
  const count = observed.length;
  if (!count) throw new Error('没有成对的有效观测与预测数值。');
  const errors = predicted.map((value, index) => value - observed[index]);
  if (errors.some(value => !finite(value))) throw new Error('误差数值溢出，请先缩放观测与预测数据。');
  const observedMean = mean(observed), predictedMean = mean(predicted);
  const centeredObserved = observed.map(value => value - observedMean), centeredPredicted = predicted.map(value => value - predictedMean);
  let observedScale = 0, predictedScale = 0, errorScale = 0;
  for (let i = 0; i < count; i++) { observedScale = Math.max(observedScale, Math.abs(centeredObserved[i])); predictedScale = Math.max(predictedScale, Math.abs(centeredPredicted[i])); errorScale = Math.max(errorScale, Math.abs(errors[i])); }
  const observedNorm = observedScale ? squaredNorm(centeredObserved.map(value => value / observedScale)) : 0;
  const predictedNorm = predictedScale ? squaredNorm(centeredPredicted.map(value => value / predictedScale)) : 0;
  const errorNorm = errorScale ? squaredNorm(errors.map(value => value / errorScale)) : 0;
  const r2 = observedNorm ? 1 - (errorScale / observedScale) ** 2 * errorNorm / observedNorm : null;
  const pearson = observedNorm && predictedNorm ? centeredObserved.reduce((sum, value, index) => sum + value / observedScale * (centeredPredicted[index] / predictedScale), 0) / Math.sqrt(observedNorm * predictedNorm) : null;
  return { count, mae: safe(mean(errors.map(Math.abs))), rmse: safe(rootMeanSquare(errors)), bias: safe(mean(errors)), r2: safe(r2), pearson: pearson === null ? null : Math.max(-1, Math.min(1, pearson)) };
}

export function fitDataset(dataset, options = {}) {
  validate(dataset);
  const xColumn = requireColumn(dataset, options.xColumn ?? 0), column = requireColumn(dataset, options.column ?? 1);
  const model = requireChoice(options.fitModel, 'linear', ['linear', 'polynomial', 'exponential', 'power'], '拟合模型');
  const degree = model === 'polynomial' ? requireNumber(options.degree, 2, '多项式阶数（2–6）', value => Number.isInteger(value) && value >= 2 && value <= 6) : 1;
  const pairs = dataset.rows.filter(row => finite(row[xColumn]) && finite(row[column]));
  if (pairs.length < degree + 1) throw new Error(`拟合至少需要 ${degree + 1} 对有效 X/Y 数据。`);
  if ((model === 'exponential' || model === 'power') && pairs.some(row => row[column] <= 0 || model === 'power' && row[xColumn] <= 0)) throw new Error(model === 'power' ? '幂律对数域拟合要求所有有效 X 和 Y 都大于 0。' : '指数对数域拟合要求所有有效 Y 都大于 0。');
  const transformX = x => model === 'power' ? Math.log(x) : x;
  const logarithmic = model === 'exponential' || model === 'power';
  const xs = pairs.map(row => transformX(row[xColumn])), ys = pairs.map(row => logarithmic ? Math.log(row[column]) : row[column]);
  const fit = qrFit(xs, ys, degree), n = pairs.length, p = degree + 1, df = n - p;
  const domainErrors = xs.map((x, index) => ys[index] - fit.predict(x));
  const domainRMSE = rootMeanSquare(domainErrors), residualVariance = df > 0 ? domainRMSE ** 2 * n / df : null;
  if (residualVariance !== null && !finite(residualVariance)) throw new Error('拟合残差量级过大，无法计算参数不确定度，请先缩放数据。');
  const covariance = fit.covarianceBase.map(row => row.map(value => residualVariance === null ? null : value * residualVariance));
  const predict = x => {
    if (!finite(x) || model === 'power' && x <= 0) return null;
    const value = fit.predict(transformX(x)); return safe(logarithmic ? Math.exp(value) : value);
  };
  const trainingPredictions = pairs.map(row => predict(row[xColumn]));
  if (trainingPredictions.some(value => !finite(value))) throw new Error('拟合预测超出有限数值范围，请缩放数据或更换模型。');
  const metrics = comparisonMetrics(pairs.map(row => row[column]), trainingPredictions);
  const labels = { linear: '线性拟合', polynomial: `${degree} 阶多项式拟合`, exponential: '指数拟合', power: '幂律拟合' };
  const label = labels[model], values = dataset.rows.map(row => predict(row[xColumn]));
  const residuals = dataset.rows.map((row, index) => finite(row[column]) && finite(values[index]) ? safe(row[column] - values[index]) : null);
  const definitions = [{ name: `${dataset.columns[column]} · ${label}`, values }, { name: `${dataset.columns[column]} · 拟合残差`, values: residuals }];
  let parameters, equation;
  const format = value => finite(value) ? Number(value.toPrecision(8)).toString() : '超出范围';
  if (degree === 1) {
    const slope = fit.coefficients[1] / fit.scale, intercept = fit.coefficients[0] - slope * fit.center;
    const interceptVariance = df > 0 ? covariance[0][0] - 2 * fit.center / fit.scale * covariance[0][1] + (fit.center / fit.scale) ** 2 * covariance[1][1] : null;
    const slopeSE = df > 0 ? Math.sqrt(Math.max(0, covariance[1][1])) / fit.scale : null;
    const interceptSE = df > 0 ? Math.sqrt(Math.max(0, interceptVariance)) : null;
    parameters = logarithmic ? [{ name: 'A', value: safe(Math.exp(intercept)), stderr: df > 0 ? safe(Math.exp(intercept) * interceptSE) : null }, { name: 'B', value: slope, stderr: safe(slopeSE) }] : [{ name: '截距 a', value: safe(intercept), stderr: safe(interceptSE) }, { name: '斜率 b', value: safe(slope), stderr: safe(slopeSE) }];
    equation = model === 'linear' ? `y = ${format(intercept)} + (${format(slope)}) × x` : model === 'power' ? `y = ${format(Math.exp(intercept))} × x^(${format(slope)})` : `y = ${format(Math.exp(intercept))} × exp((${format(slope)}) × x)`;
  } else {
    parameters = fit.coefficients.map((value, index) => ({ name: `c${index}`, value, stderr: df > 0 ? safe(Math.sqrt(Math.max(0, covariance[index][index]))) : null }));
    equation = `z = (x − ${format(fit.center)}) / ${format(fit.scale)}；y = ` + fit.coefficients.map((value, index) => `(${format(value)})${index ? ` × z${index > 1 ? '^' + index : ''}` : ''}`).join(' + ');
  }
  let confidenceIndex = null;
  if (model === 'linear') {
    const critical = df > 0 ? studentTCritical95(df) : null;
    const confidence = dataset.rows.map(row => {
      if (!finite(row[xColumn]) || critical === null) return null;
      const z = (row[xColumn] - fit.center) / fit.scale;
      return safe(critical * Math.sqrt(Math.max(0, covariance[0][0] + 2 * z * covariance[0][1] + z * z * covariance[1][1])));
    });
    confidenceIndex = dataset.columns.length + definitions.length;
    definitions.push({ name: `${dataset.columns[column]} · 均值95%CI半宽`, values: confidence });
  }
  const appended = appendColumns(dataset, definitions);
  const details = [`使用 ${n} 对有效 X/Y，剔除 ${dataset.rows.length - n} 行缺失配对；无权重最小二乘。`, '拟合残差 = 观测 − 拟合；RMSE = √(SSE/n)，R² = 1−SSE/SST。'];
  if (degree > 1) details.push('参数及标准误对应所示标准化坐标 z 的多项式基底，避免大坐标偏置引起病态。');
  if (model === 'linear') details.push('阴影为回归均值的双侧 95% Student-t 置信带，不是单个新观测的预测区间；假设独立、同方差且正态残差。');
  if (logarithmic) details.push('在对数 Y 域最小二乘：指数模型拟合 ln(Y) 对 X，幂律模型拟合 ln(Y) 对 ln(X)；误差优化目标与原始 Y 域不同。', '展示的 R²/RMSE 在原始 Y 域计算；A 标准误由 delta method 近似，不对指数反变换作偏差修正。');
  if (!df) details.push('有效样本数等于参数数目，没有剩余自由度；参数标准误、调整 R² 与置信带不计算。');
  const reportMetrics = [{ label: '有效配对 n', value: n }, { label: 'R²', value: metrics.r2 }, { label: '调整 R²', value: df > 0 && metrics.r2 !== null ? 1 - (1 - metrics.r2) * (n - 1) / df : null }, { label: 'RMSE', value: metrics.rmse }, { label: '残差自由度', value: df }];
  return { dataset: appended.dataset, series: [series(label, xColumn, appended.indices[0], 0, confidenceIndex === null ? {} : { yErrorColumn: confidenceIndex, errorStyle: 'band' })], axes: { xLabel: dataset.columns[xColumn], yLabel: dataset.columns[column] }, report: { title: label, equation, parameters, metrics: reportMetrics, details }, replaceDataset: false };
}

export function compareModels(dataset, options = {}) {
  validate(dataset);
  const xColumn = requireColumn(dataset, options.xColumn ?? 0), column = requireColumn(dataset, options.column ?? 1);
  const selected = options.predictionColumns ?? [options.otherColumn ?? 2];
  if (!Array.isArray(selected) || !selected.length || selected.length > 12) throw new Error('请选择 1–12 列预测数据。');
  const predictions = [...new Set(selected.map(index => requireColumn(dataset, index)))];
  if (predictions.includes(column)) throw new Error('观测列与预测列不能相同。');
  const output = requireChoice(options.output, 'residual', ['residual', 'absolute', 'prediction'], '对比曲线');
  const definitions = [], models = [], outputSeries = [];
  predictions.forEach((predictionColumn, index) => {
    const valid = dataset.rows.filter(row => finite(row[column]) && finite(row[predictionColumn]));
    const metrics = comparisonMetrics(valid.map(row => row[column]), valid.map(row => row[predictionColumn]));
    const name = dataset.columns[predictionColumn]; models.push({ name, ...metrics });
    const residuals = dataset.rows.map(row => finite(row[column]) && finite(row[predictionColumn]) ? safe(row[predictionColumn] - row[column]) : null);
    const offset = dataset.columns.length + definitions.length;
    definitions.push({ name: `${name} · 预测残差`, values: residuals }, { name: `${name} · 绝对误差`, values: residuals.map(value => finite(value) ? Math.abs(value) : null) });
    outputSeries.push(series(`${name}${output === 'prediction' ? '' : output === 'residual' ? ' 残差' : ' 绝对误差'}`, xColumn, output === 'prediction' ? predictionColumn : offset + (output === 'absolute' ? 1 : 0), index));
  });
  const appended = appendColumns(dataset, definitions);
  return { dataset: appended.dataset, series: outputSeries, axes: { xLabel: dataset.columns[xColumn], yLabel: output === 'prediction' ? dataset.columns[column] : output === 'absolute' ? '绝对误差' : '残差（预测 − 观测）' }, report: { title: '模型预测对比', models, metrics: [{ label: '模型数量', value: models.length }], details: ['按同一行配对观测与预测；各模型独立剔除缺失配对，比较指标时请核对各自 n。', 'bias = 平均(预测−观测)；MAE 为平均绝对误差；RMSE = √平均平方误差；R² = 1−SSE/SST，可为负值，常量观测时不定义。', 'Pearson 反映线性相关，不代表预测无偏或一致；常量列时不定义。每个模型追加残差与绝对误差两列，原始数据保留。'] }, replaceDataset: false, replaceView: output !== 'prediction' };
}

function uniformSampling(dataset, options, columns) {
  const xColumn = requireColumn(dataset, options.xColumn ?? 0);
  if (dataset.rows.length < 4) throw new Error('频域或相关分析至少需要 4 个样本。');
  if (dataset.rows.some(row => !finite(row[xColumn]) || columns.some(column => !finite(row[column])))) throw new Error('频域和相关分析需要连续有效的 X/Y 数据，不能直接跳过缺失样本；请先补齐缺失值或选取完整片段。');
  const step = dataset.rows[1][xColumn] - dataset.rows[0][xColumn];
  if (!finite(step) || step <= 0) throw new Error('X 必须严格递增且等间距。');
  for (let i = 2; i < dataset.rows.length; i++) { const delta = dataset.rows[i][xColumn] - dataset.rows[i - 1][xColumn]; if (delta <= 0 || Math.abs(delta - step) > step * 1e-4) throw new Error('频域和相关分析要求等间距 X（步长相对误差不超过 0.01%），请先重采样。'); }
  const sampleRate = requireNumber(options.sampleRate, 1 / step, '采样率（大于 0）', value => value > 0);
  return { sampleRate, step, xColumn };
}
function nextPowerTwo(n) { let value = 1; while (value < n) value *= 2; return value; }
/** In-place iterative radix-2 FFT; inverse includes its 1/N normalization. */
export function fftRadix2(real, imaginary, inverse = false) {
  const n = real.length;
  if (n < 1 || n & n - 1 || imaginary.length !== n) throw new Error('FFT 长度必须为 2 的整数次幂。');
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { [real[i], real[j]] = [real[j], real[i]]; [imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]]; }
  }
  for (let length = 2; length <= n; length *= 2) {
    const angle = (inverse ? 2 : -2) * Math.PI / length, rootReal = Math.cos(angle), rootImaginary = Math.sin(angle);
    for (let start = 0; start < n; start += length) {
      let wr = 1, wi = 0;
      for (let k = 0; k < length / 2; k++) {
        const even = start + k, odd = even + length / 2;
        const vr = real[odd] * wr - imaginary[odd] * wi, vi = real[odd] * wi + imaginary[odd] * wr;
        real[odd] = real[even] - vr; imaginary[odd] = imaginary[even] - vi; real[even] += vr; imaginary[even] += vi;
        const nextReal = wr * rootReal - wi * rootImaginary; wi = wr * rootImaginary + wi * rootReal; wr = nextReal;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { real[i] /= n; imaginary[i] /= n; }
}

export function spectrumDataset(dataset, options = {}) {
  validate(dataset); const column = requireColumn(dataset, options.column ?? 1);
  const { sampleRate } = uniformSampling(dataset, options, [column]);
  const window = requireChoice(options.window, 'hann', ['hann', 'rectangular'], '窗函数');
  const spectrum = requireChoice(options.spectrum, 'amplitude', ['amplitude', 'psd'], '频谱类型');
  if (options.detrend !== undefined && typeof options.detrend !== 'boolean') throw new Error('去均值选项格式不正确。');
  const detrend = options.detrend !== false, n = dataset.rows.length, nfft = nextPowerTwo(n);
  const values = dataset.rows.map(row => row[column]), average = detrend ? mean(values) : 0;
  const real = new Float64Array(nfft), imaginary = new Float64Array(nfft); let windowSum = 0, windowSquares = 0;
  for (let i = 0; i < n; i++) { const weight = window === 'hann' ? .5 - .5 * Math.cos(2 * Math.PI * i / n) : 1; real[i] = (values[i] - average) * weight; windowSum += weight; windowSquares += weight * weight; }
  fftRadix2(real, imaginary);
  const rows = []; let dominant = 0, highest = -1, power = 0;
  for (let k = 0; k <= nfft / 2; k++) {
    const magnitude = Math.hypot(real[k], imaginary[k]), factor = k === 0 || k === nfft / 2 ? 1 : 2;
    const amplitude = factor * magnitude / windowSum, psd = factor * (magnitude / Math.sqrt(sampleRate * windowSquares)) ** 2;
    if (!finite(amplitude) || !finite(psd)) throw new Error('频谱结果数值溢出，请先缩放输入幅值。');
    const frequency = k * sampleRate / nfft; rows.push([frequency, amplitude, psd]); power += psd * sampleRate / nfft;
    if (k > 0 && amplitude > highest) { highest = amplitude; dominant = frequency; }
  }
  const name = dataset.columns[column], output = { name: `${dataset.name} · 频谱`, columns: ['频率 (Hz)', '单边幅值', '单边功率谱密度'], rows };
  return { dataset: output, series: [series(`${name} ${spectrum === 'psd' ? 'PSD' : '幅值谱'}`, 0, spectrum === 'psd' ? 2 : 1)], axes: { xLabel: '频率 f (Hz)', yLabel: spectrum === 'psd' ? 'PSD (Y²/Hz)' : '幅值 (Y)' }, report: { title: spectrum === 'psd' ? '单边功率谱密度' : '单边幅值谱', metrics: [{ label: '输入样本数', value: n }, { label: 'FFT 长度', value: nfft }, { label: '主峰频率（不含 DC）', value: highest > 1e-14 ? dominant : null }, { label: 'PSD 积分', value: safe(power) }, { label: '频率网格间隔', value: sampleRate / nfft }], details: [`采样率 ${sampleRate} Hz；${window === 'hann' ? '周期 Hann 窗' : '矩形窗'}；${detrend ? '先去均值' : '保留直流分量'}。幅值按窗相干增益校正，PSD 按 fs × Σw² 归一化。`, '实信号单边谱只对内部正频率加倍，DC 与奈奎斯特频率不加倍。PSD 单位为 Y²/Hz，前提是采样率单位为 Hz。', nfft === n ? '输入长度为 2 的整数次幂，无需补零。' : `零填充到 ${nfft} 点；零填充只加密频率网格，不提升 ${sampleRate / n} Hz 量级的原始频率分辨能力。`, '将创建频率坐标的新数据集并替换当前视图；可撤销回到原始数据，请保存项目保留两次工作。'] }, replaceDataset: true };
}

export function correlateDataset(dataset, options = {}) {
  validate(dataset); const column = requireColumn(dataset, options.column ?? 1);
  const type = requireChoice(options.correlationType, 'auto', ['auto', 'cross'], '相关类型');
  const other = type === 'auto' ? column : requireColumn(dataset, options.otherColumn ?? 2);
  const { sampleRate } = uniformSampling(dataset, options, [column, other]);
  const n = dataset.rows.length, maxLag = requireNumber(options.maxLag, Math.min(100, n - 1), '最大滞后（0 至样本数−1，最多 24,999）', value => Number.isInteger(value) && value >= 0 && value < n && value <= 24999);
  const first = dataset.rows.map(row => row[column]), second = dataset.rows.map(row => row[other]);
  const m1 = mean(first), m2 = mean(second);
  let scale1 = 0, scale2 = 0; for (let i = 0; i < n; i++) { scale1 = Math.max(scale1, Math.abs(first[i] - m1)); scale2 = Math.max(scale2, Math.abs(second[i] - m2)); }
  if (!scale1 || !scale2 || !finite(scale1) || !finite(scale2)) throw new Error('常量或数值跨度过大的信号无法定义归一化相关。');
  const size = nextPowerTwo(2 * n - 1), a = new Float64Array(size), ai = new Float64Array(size), b = new Float64Array(size), bi = new Float64Array(size);
  let energyA = 0, energyB = 0;
  for (let i = 0; i < n; i++) { a[i] = (first[i] - m1) / scale1; b[i] = (second[i] - m2) / scale2; energyA += a[i] ** 2; energyB += b[i] ** 2; }
  fftRadix2(a, ai); fftRadix2(b, bi);
  for (let i = 0; i < size; i++) { const real = a[i] * b[i] + ai[i] * bi[i], imaginary = a[i] * bi[i] - ai[i] * b[i]; a[i] = real; ai[i] = imaginary; }
  fftRadix2(a, ai, true);
  const normalization = Math.sqrt(energyA * energyB), rows = []; let peakLag = 0, peak = -1;
  for (let lag = type === 'auto' ? 0 : -maxLag; lag <= maxLag; lag++) {
    const value = Math.max(-1, Math.min(1, a[lag < 0 ? size + lag : lag] / normalization));
    rows.push([lag, lag / sampleRate, value, n - Math.abs(lag)]);
    if ((type !== 'auto' || lag !== 0) && Math.abs(value) > peak) { peak = Math.abs(value); peakLag = lag; }
  }
  return { dataset: { name: `${dataset.name} · ${type === 'auto' ? '自相关' : '互相关'}`, columns: ['滞后 (样本)', '滞后 (s)', '归一化相关', '重叠样本数'], rows }, series: [series(type === 'auto' ? '自相关 ACF' : '互相关 CCF', 1, 2)], axes: { xLabel: '滞后 τ (s)', yLabel: '归一化相关' }, report: { title: type === 'auto' ? '自相关分析' : '互相关分析', metrics: [{ label: '输入样本数', value: n }, { label: '最大相关绝对值', value: peak < 0 ? null : peak }, { label: '对应滞后（样本）', value: peak < 0 ? null : peakLag }, { label: '对应滞后（s）', value: peak < 0 ? null : peakLag / sampleRate }], details: ['各信号先减去全段均值，分母使用两条完整信号的能量平方根；不按每个滞后的重叠点数重新归一化。自相关零滞后为 1。', '定义 C(k)=Σ A[i]B[i+k] / √(ΣA²ΣB²)。正滞后峰表示第二条信号 B 相对第一条 A 延后；与 SciPy correlate(B,A) 的符号一致。', '缺失样本不能直接删除；结果含各滞后的重叠样本数，边缘滞后的依据较少。相关不代表因果关系。', '将创建滞后坐标的新数据集并替换当前视图；可以撤销恢复。'] }, replaceDataset: true };
}

export function summarizeReplicates(dataset, options = {}) {
  validate(dataset); const xColumn = requireColumn(dataset, options.xColumn ?? 0);
  if (!Array.isArray(options.replicateColumns)) throw new Error('请选择至少两列重复测量。');
  const columns = [...new Set(options.replicateColumns.map(index => requireColumn(dataset, index)))];
  if (columns.length < 2) throw new Error('请选择至少两列不同的重复测量。');
  if (columns.includes(xColumn)) throw new Error('X 坐标列不能同时作为重复测量列。');
  const error = requireChoice(options.error, 'sd', ['sd', 'sem', 'ci95'], '误差表示');
  const errorStyle = requireChoice(options.errorStyle, 'bars', ['bars', 'band'], '误差样式');
  const records = dataset.rows.map(row => {
    const values = columns.map(column => row[column]).filter(finite), n = values.length;
    if (!n) return [null, null, null, null, 0];
    const average = mean(values), sd = n > 1 ? rootMeanSquare(values.map(value => value - average)) * Math.sqrt(n / (n - 1)) : null;
    const sem = n > 1 ? sd / Math.sqrt(n) : null, ci = n > 1 ? studentTCritical95(n - 1) * sem : null;
    return [safe(average), safe(sd), safe(sem), safe(ci), n];
  });
  const definitions = ['重复测量均值', '重复测量 SD', '重复测量 SEM', '均值95%CI半宽', '有效重复数 n'].map((name, index) => ({ name, values: records.map(row => row[index]) }));
  const appended = appendColumns(dataset, definitions), errors = { sd: 1, sem: 2, ci95: 3 };
  const insufficient = records.filter(row => row[4] < 2).length;
  return { dataset: appended.dataset, series: [series(`均值 ± ${error === 'ci95' ? '95% CI' : error.toUpperCase()}`, xColumn, appended.indices[0], 0, { marker: 'circle', markerSize: 4, yErrorColumn: appended.indices[errors[error]], errorStyle })], axes: { xLabel: dataset.columns[xColumn], yLabel: '重复测量均值' }, report: { title: '重复测量汇总', metrics: [{ label: '选择的重复列', value: columns.length }, { label: '总行数', value: records.length }, { label: 'n < 2 的行数', value: insufficient }], details: ['逐行汇总所选列，忽略该行的缺失重复值；每行的有效 n 单独保存，不假定各行样本数相同。', 'SD 使用 n−1 分母；SEM = SD/√n；双侧均值95%CI = 均值 ± t(0.975,n−1) × SEM。n<2 时不计算 SD/SEM/CI。', '95% t 区间假设重复测量独立、近似正态；技术重复和生物学重复的含义需由实验设计决定。误差条应在论文中明确标注所用类型与 n。'] }, replaceDataset: false };
}

export function runAnalysis(dataset, options = {}) {
  const implementations = { fit: fitDataset, compare: compareModels, fft: spectrumDataset, correlation: correlateDataset, replicates: summarizeReplicates };
  if (!Object.hasOwn(implementations, options.method)) throw new Error('请选择有效的分析方法。');
  return implementations[options.method](dataset, options);
}
