import { runAnalysis } from './analysis-core.js';
import { renderPlot } from './plot-engine.js';
import { downloadBlob } from './export-utils.js';

const $ = (selector, root = document) => root.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const number = value => typeof value === 'number' && Number.isFinite(value) ? Number(value.toPrecision(7)).toLocaleString('en-US', { maximumSignificantDigits: 7 }) : '—';
const categories = [
  ['fit', '曲线拟合', 'ƒ', '模型、参数与置信带'],
  ['compare', '模型对比', '≋', '预测误差与残差'],
  ['fft', '频谱分析', '∿', '幅值谱与功率谱'],
  ['correlation', '相关与滞后', 'τ', '自相关与互相关'],
  ['replicates', '重复测量', '±', '均值与不确定度'],
];
let context = null, config = null, result = null, error = '', dirty = false;

function inferSampleRate(dataset, xColumn) {
  for (let index = 1; index < dataset.rows.length; index++) {
    const a = dataset.rows[index - 1][xColumn], b = dataset.rows[index][xColumn];
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) return Number((1 / (b - a)).toPrecision(8));
  }
  return 100;
}
function select(label, key, choices) {
  return `<label class="control-label">${label}</label><select class="form-control" data-analysis-option="${key}" aria-label="${label}">${choices.map(([value, name]) => `<option value="${esc(value)}" ${String(config[key]) === String(value) ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select>`;
}
function input(label, key, attributes = '') {
  return `<label class="control-label">${label}</label><input class="form-control" type="number" data-analysis-option="${key}" aria-label="${label}" value="${esc(config[key])}" ${attributes}>`;
}
function columns() { return context.getState().dataset.columns.map((name, index) => [index, name]); }
function checkColumns(label, key, excluded) {
  return `<label class="control-label">${label}</label><div class="y-choices analysis-column-choices">${columns().filter(([index]) => !excluded.includes(index)).map(([index, name]) => `<label class="y-choice"><input type="checkbox" data-analysis-column="${key}" value="${index}" ${config[key].includes(index) ? 'checked' : ''}>${esc(name)}</label>`).join('')}</div>`;
}
function parameters() {
  let html = '';
  if (config.method === 'fit') {
    html += `<div class="span-two">${select('拟合模型', 'fitModel', [['linear', '线性 · y = a + bx'], ['polynomial', '多项式 · 2–6 阶'], ['exponential', '指数 · y = A exp(Bx)'], ['power', '幂律 · y = A xᴮ']])}</div>`;
    if (config.fitModel === 'polynomial') html += `<div>${select('多项式阶数', 'degree', [2, 3, 4, 5, 6].map(value => [value, `${value} 阶`]))}</div>`;
    html += `<p class="parameter-note span-two">${['exponential', 'power'].includes(config.fitModel) ? '指数/幂律使用对数域最小二乘；Y 必须为正，幂律还要求 X 为正。参数误差基于对数域残差。' : '使用全部有效 X/Y 配对，无权重最小二乘。线性模型可显示均值 95% 置信带；多项式用标准化坐标提高数值稳定性。'}</p>`;
  }
  if (config.method === 'compare') {
    html += `<div class="span-two">${checkColumns('选择预测列（最多 12 列）', 'predictionColumns', [config.column])}</div>`;
    html += `<div class="span-two">${select('绘制内容', 'output', [['residual', '预测残差 · 预测 − 观测'], ['absolute', '绝对误差 · |预测 − 观测|'], ['prediction', '预测曲线 · 叠加到原图']])}</div>`;
    html += '<p class="parameter-note span-two">按同一行配对。每个模型都生成残差和绝对误差列；指标使用各自有效配对，n 可能不同。</p>';
  }
  if (config.method === 'fft') {
    html += `<div>${select('输出频谱', 'spectrum', [['amplitude', '单边幅值谱'], ['psd', '单边功率谱密度 PSD']])}</div>`;
    html += `<div>${select('窗函数', 'window', [['hann', 'Hann · 降低频谱泄漏'], ['rectangular', '矩形 · 不加窗']])}</div>`;
    html += `<div>${input('采样率 fs（Hz）', 'sampleRate', 'min="0" step="any"')}</div><label class="processing-plot-choice"><input type="checkbox" data-analysis-flag="detrend" ${config.detrend ? 'checked' : ''}>计算前去除均值</label>`;
    html += '<p class="parameter-note span-two">要求等间距、无缺失数据。fs 按 X 为秒估算；其他单位需手动换算。补零只加密频率网格。</p>';
  }
  if (config.method === 'correlation') {
    html += `<div>${select('相关类型', 'correlationType', [['auto', '自相关 ACF'], ['cross', '互相关 CCF']])}</div>`;
    if (config.correlationType === 'cross') html += `<div>${select('第二条信号 B', 'otherColumn', columns())}</div>`;
    html += `<div>${input('最大滞后（样本）', 'maxLag', `min="0" max="${Math.min(24999, context.getState().dataset.rows.length - 1)}" step="1"`)}</div>`;
    html += `<div>${input('采样率 fs（Hz）', 'sampleRate', 'min="0" step="any"')}</div>`;
    html += '<p class="parameter-note span-two">先去均值，按完整信号能量归一化。正滞后峰表示 B 相对 A 延后；要求等间距、无缺失数据。</p>';
  }
  if (config.method === 'replicates') {
    html += `<div class="span-two">${checkColumns('选择重复测量列（至少 2 列）', 'replicateColumns', [config.xColumn])}</div>`;
    html += `<div>${select('误差含义', 'error', [['sd', '样本标准差 SD'], ['sem', '均值标准误 SEM'], ['ci95', '均值 95% t 置信区间']])}</div>`;
    html += `<div>${select('绘图样式', 'errorStyle', [['bars', '误差条'], ['band', '连续阴影带']])}</div>`;
    html += '<p class="parameter-note span-two">逐行忽略缺失重复值并保存有效 n。SD、SEM 和 95% CI 含义不同；置信区间假设独立且近似正态的重复测量。</p>';
  }
  return `<div class="processing-parameters">${html}</div>`;
}
function calculate() {
  result = null; error = ''; dirty = false;
  try { result = runAnalysis(context.getState().dataset, config); }
  catch (failure) { error = failure.message || '分析失败，请检查数据和参数。'; }
}
function preview() {
  const state = context.getState(), dataset = result?.dataset || state.dataset;
  let plotted = result ? result.series.map((item, index) => ({ ...item, id: `analysis-preview-${index}` })) : [];
  const showOriginal = config.method === 'fit' || config.method === 'compare' && config.output === 'prediction';
  if (showOriginal || !result) plotted.unshift({ id: 'analysis-observed', name: config.method === 'compare' ? '观测值' : '原始数据', xColumn: config.xColumn, yColumn: config.column, color: '#acb7b1', width: 1.2, marker: 'circle', markerSize: 3, dash: 'solid', visible: true });
  return renderPlot({ dataset, series: plotted, axes: { xLabel: dataset.columns[config.xColumn] || 'X', yLabel: dataset.columns[config.column] || 'Y', ...result?.axes, fontFamily: 'Arial', fontSize: 14, grid: true, minorTicks: false, frame: false }, chartType: 'line-scatter', legend: { show: true, position: 'top-left', border: false }, inset: { enabled: false }, axisBreak: { enabled: false }, title: '' }, { width: 760, height: 310 });
}
function reportTables() {
  if (!result) return '';
  const report = result.report;
  let html = report.equation ? `<div class="analysis-equation">${esc(report.equation)}</div>` : '';
  if (report.parameters) html += `<div class="stats-table-wrap"><table class="stats-table"><thead><tr><th>参数</th><th>估计值</th><th>标准误</th></tr></thead><tbody>${report.parameters.map(parameter => `<tr><th>${esc(parameter.name)}</th><td>${number(parameter.value)}</td><td>${number(parameter.stderr)}</td></tr>`).join('')}</tbody></table></div>`;
  if (report.models) html += `<div class="stats-table-wrap analysis-model-table"><table class="stats-table"><thead><tr><th>模型</th><th>n</th><th>MAE</th><th>RMSE</th><th>bias</th><th>R²</th><th>Pearson r</th></tr></thead><tbody>${report.models.map(model => `<tr><th>${esc(model.name)}</th>${['count', 'mae', 'rmse', 'bias', 'r2', 'pearson'].map(key => `<td>${number(model[key])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  return html;
}
function render() {
  if (!context) return;
  calculate();
  const state = context.getState(), sourceLabel = config.method === 'compare' ? '观测数据列' : config.method === 'correlation' ? '第一条信号 A' : '分析数据列 Y';
  const replacement = result?.replaceDataset || ['fft', 'correlation'].includes(config.method);
  context.openModal(`<div data-analysis-root class="analysis-root"><div class="modal-header"><div><h2>科研分析 <span class="processing-beta">RESEARCH LAB</span></h2><p>从实验数据到模型、误差和信号特征。</p></div><button class="icon-button" data-action="close-modal" aria-label="关闭">✕</button></div><div class="processing-layout"><nav class="processing-nav">${categories.map(([id, name, symbol, note]) => `<button data-analysis-category="${id}" class="${config.method === id ? 'active' : ''}"><span class="processing-symbol">${symbol}</span><span><strong>${name}</strong><small>${note}</small></span></button>`).join('')}<div class="processing-safety">原始列不会被改写<br>所有计算在本地完成</div></nav><div class="processing-main"><div class="processing-source"><div>${select('对应 X 数据列', 'xColumn', columns())}</div>${config.method === 'replicates' ? '<div class="settings-note">选择同一条件下的重复测量列，逐行汇总。</div>' : `<div>${select(sourceLabel, 'column', columns())}</div>`}</div>${parameters()}${error ? `<div class="inline-error">${esc(error)}</div>` : ''}${result?.report.metrics?.length ? `<div class="stat-cards">${result.report.metrics.map(entry => `<div><span>${esc(entry.label)}</span><strong>${number(entry.value)}</strong></div>`).join('')}</div>` : ''}<div class="processing-preview"><div class="processing-preview-heading"><strong>${result ? '分析预览' : '原始数据'}</strong><span>${replacement ? '生成新的坐标数据集 · 可撤销恢复原始视图' : '先检查预览和计算说明，再生成结果'}</span></div>${preview()}</div>${reportTables()}${result ? `<div class="processing-report"><strong>${esc(result.report.title)}</strong>${result.report.details.map(detail => `<p>${esc(detail)}</p>`).join('')}</div>` : ''}${replacement ? '<div class="inline-warning">应用后会用频率或滞后坐标的新数据集替换当前视图。原视图可通过「撤销」恢复；需要长期保留时，请分别保存项目。</div>' : '<div class="settings-note">结果追加为新列，原始列保留。拟合残差或模型误差可在数据列中再次选择绘图。</div>'}</div></div><div class="modal-footer"><small>${state.dataset.rows.length.toLocaleString()} 行原始数据 · 可下载分析报告</small><div><button class="button ghost" data-analysis-export ${!result ? 'disabled' : ''}>导出分析报告</button><button class="button soft" data-analysis-preview>更新预览</button><button class="button primary" data-analysis-apply ${!result || error ? 'disabled' : ''}>${replacement ? '生成新数据集并绘图' : '生成结果并绘图'}</button></div></div></div>`, { wide: true });
  $('#modal')?.classList.add('modal-processing', 'modal-analysis');
}

export function openAnalysis(callbacks) {
  context = callbacks;
  const state = context.getState(), selected = context.getSelectedSeries?.() || state.series.find(item => item.visible !== false) || state.series[0];
  const column = selected?.yColumn ?? 1, xColumn = selected?.xColumn ?? 0;
  const candidates = state.dataset.columns.map((_, index) => index).filter(index => index !== xColumn && index !== column && state.dataset.rows.some(row => Number.isFinite(row[index])));
  config = { method: 'fit', xColumn, column, fitModel: 'linear', degree: 2, predictionColumns: candidates.slice(0, 3), output: 'residual', spectrum: 'amplitude', window: 'hann', detrend: true, sampleRate: inferSampleRate(state.dataset, xColumn), correlationType: 'auto', otherColumn: candidates[0] ?? column, maxLag: Math.min(100, state.dataset.rows.length - 1), replicateColumns: [column, ...candidates].slice(0, 6), error: 'sd', errorStyle: 'bars' };
  render();
}
function active() { return context && $('[data-analysis-root]'); }
function invalidate() {
  dirty = true; result = null;
  const apply = $('[data-analysis-apply]'), exportButton = $('[data-analysis-export]');
  if (apply) apply.disabled = true; if (exportButton) exportButton.disabled = true;
  const label = $('[data-analysis-root] .processing-preview-heading span'); if (label) label.textContent = '参数已修改，点击「更新预览」重新计算';
}
function exportReport() {
  if (!result || dirty) return;
  const report = result.report, rows = [['分析', report.title], ['数据文件', context.getState().dataset.name]];
  if (report.equation) rows.push(['方程', report.equation]);
  if (report.metrics) rows.push([], ['指标', '数值'], ...report.metrics.map(entry => [entry.label, entry.value ?? '']));
  if (report.parameters) rows.push([], ['参数', '估计值', '标准误'], ...report.parameters.map(entry => [entry.name, entry.value ?? '', entry.stderr ?? '']));
  if (report.models) rows.push([], ['模型', 'n', 'MAE', 'RMSE', 'bias', 'R²', 'Pearson r'], ...report.models.map(entry => [entry.name, ...['count', 'mae', 'rmse', 'bias', 'r2', 'pearson'].map(key => entry[key] ?? '')]));
  rows.push([], ['计算说明'], ...report.details.map(detail => [detail]));
  const field = value => {
    const text = typeof value === 'string' && /^[=+\-@]/.test(value.trimStart()) ? "'" + value : String(value ?? '');
    return `"${text.replaceAll('"', '""')}"`;
  };
  const csv = '\ufeff' + rows.map(row => row.map(field).join(',')).join('\r\n');
  downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `${report.title}-分析报告.csv`);
  context.notify('分析报告已导出为 CSV');
}

document.addEventListener('click', event => {
  if (!active()) return;
  const button = event.target.closest('button'); if (!button) return;
  if (button.dataset.analysisCategory) { config.method = button.dataset.analysisCategory; render(); return; }
  if (button.hasAttribute('data-analysis-preview')) { render(); return; }
  if (button.hasAttribute('data-analysis-export')) { exportReport(); return; }
  if (button.hasAttribute('data-analysis-apply')) {
    calculate();
    if (!result || error) { context.notify(error || '请先检查分析参数。', true); render(); return; }
    try {
      context.onApply(result);
      const message = result.replaceDataset ? '已生成新的分析数据集，可通过撤销恢复原始数据' : '分析结果已追加为新数据列，原始数据已保留';
      context.closeModal(); context.notify(message); context = null;
    } catch (failure) { context.notify(failure.message || '无法应用分析结果。', true); }
  }
});
document.addEventListener('change', event => {
  if (!active()) return;
  const element = event.target;
  if (element.dataset.analysisColumn) {
    const key = element.dataset.analysisColumn, value = Number(element.value);
    if (element.checked && key === 'predictionColumns' && config[key].length >= 12) { element.checked = false; context.notify('一次最多比较 12 个模型。', true); return; }
    config[key] = element.checked ? [...new Set([...config[key], value])] : config[key].filter(index => index !== value);
    render(); return;
  }
  if (element.dataset.analysisFlag) { config[element.dataset.analysisFlag] = element.checked; render(); return; }
  const key = element.dataset.analysisOption; if (!key) return;
  config[key] = ['column', 'xColumn', 'degree', 'sampleRate', 'otherColumn', 'maxLag'].includes(key) ? (element.value === '' ? NaN : Number(element.value)) : element.value;
  if (key === 'column') config.predictionColumns = config.predictionColumns.filter(index => index !== config.column);
  if (key === 'xColumn') { config.sampleRate = inferSampleRate(context.getState().dataset, config.xColumn); config.replicateColumns = config.replicateColumns.filter(index => index !== config.xColumn); }
  render();
});
document.addEventListener('input', event => {
  if (!active()) return;
  const element = event.target;
  if (element.type === 'number' && element.dataset.analysisOption) { config[element.dataset.analysisOption] = element.value === '' ? NaN : Number(element.value); invalidate(); }
});
