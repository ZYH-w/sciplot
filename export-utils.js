import { renderPlot } from './plot-engine.js';
import { resolveFigureOptions, addPngDpi, encodeTiffRGB } from './publication-utils.js';

let activePrintCleanup = null;

function safeFilename(value, fallback = '科研图表') {
  let name = String(value || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '') || fallback;
  if (name.length > 120) {
    const extension = name.match(/\.[a-z0-9]{1,8}$/i)?.[0] || '';
    name = name.slice(0, 120 - extension.length) + extension;
  }
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? `图表_${name}` : name;
}

/** Download a browser Blob without exposing its data outside the browser. */
export function downloadBlob(blob, name) {
  if (!(blob instanceof Blob)) throw new Error('没有可下载的文件内容。');
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = safeFilename(name, '下载文件');
  link.hidden = true;
  try {
    document.body.appendChild(link);
    link.click();
  } catch {
    URL.revokeObjectURL(url);
    throw new Error('无法开始下载，请检查浏览器的下载权限后重试。');
  } finally {
    link.remove();
  }
  // Keep the URL alive while the browser picks up the download, including large PNGs.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return true;
}

function makeSvg(state, figure, raster = false) {
  const logicalWidth = 900, logicalHeight = logicalWidth * figure.heightMM / figure.widthMM;
  const markup = renderPlot({ ...state, figure: { ...(state.figure || {}), ...figure } }, { width: logicalWidth, height: logicalHeight, interactive: false });
  const documentSvg = new DOMParser().parseFromString(markup, 'image/svg+xml');
  if (documentSvg.querySelector('parsererror')) throw new Error('图形内容无法生成 SVG，请检查图表设置。');
  const root = documentSvg.documentElement;
  root.setAttribute('width', raster ? String(figure.widthPx) : `${figure.widthMM}mm`);
  root.setAttribute('height', raster ? String(figure.heightPx) : `${figure.heightMM}mm`);
  const color = figure.background;
  root.setAttribute('style', `background:${color}`);
  const backgroundRect = Array.from(root.children).find(child => child.localName === 'rect');
  if (backgroundRect) backgroundRect.setAttribute('fill', color);
  return { markup: new XMLSerializer().serializeToString(root), width: figure.widthPx, height: figure.heightPx, figure };
}

async function rasterizeSvg(svg, format) {
  const url = URL.createObjectURL(new Blob([svg.markup], { type: 'image/svg+xml;charset=utf-8' }));
  const canvas = document.createElement('canvas');
  canvas.width = svg.width;
  canvas.height = svg.height;
  try {
    const picture = await new Promise((resolve, reject) => {
      const image = new Image();
      const timeout = setTimeout(() => {
        image.onload = null;
        image.onerror = null;
        image.src = '';
        reject(new Error('图像生成超时，请降低导出尺寸后重试。'));
      }, 30000);
      image.onload = () => { clearTimeout(timeout); resolve(image); };
      image.onerror = () => { clearTimeout(timeout); reject(new Error('无法将 SVG 转换为图片，请尝试 SVG 格式。')); };
      image.src = url;
    });
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前浏览器不支持图片导出，请使用 SVG 格式。');
    context.drawImage(picture, 0, 0, svg.width, svg.height);
    if (format === 'tiff') {
      const data = context.getImageData(0, 0, svg.width, svg.height).data;
      const bytes = encodeTiffRGB({ width: svg.width, height: svg.height, data, dpi: svg.figure.dpi, background: svg.figure.background });
      return new Blob([bytes], { type: 'image/tiff' });
    }
    const png = await new Promise((resolve, reject) => canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error('PNG 生成失败，请降低导出尺寸后重试。'));
    }, 'image/png'));
    return new Blob([addPngDpi(await png.arrayBuffer(), svg.figure.dpi)], { type: 'image/png' });
  } catch (error) {
    if (error.name === 'SecurityError') throw new Error('浏览器阻止了图片导出，请使用 SVG 格式。');
    throw error;
  } finally {
    URL.revokeObjectURL(url);
    canvas.width = 0;
    canvas.height = 0;
  }
}

async function printFigure(svg, filename) {
  activePrintCleanup?.();
  // Explicitly remove dialogs from the top layer while printing. Hiding their
  // normal boxes with print CSS alone is not reliable for browser backdrops.
  const dialogs = Array.from(document.querySelectorAll('dialog[open]')).map(dialog => {
    let modal = true;
    try { modal = dialog.matches(':modal'); } catch { /* Older browsers support showModal but not :modal. */ }
    const content = dialog.innerHTML;
    dialog.close();
    return { dialog, modal, content };
  });
  const surface = document.createElement('div');
  surface.id = 'print-surface';
  surface.style.display = 'none';
  surface.innerHTML = svg.markup;
  const { widthMM, heightMM } = svg.figure;
  const printStyle = document.createElement('style');
  printStyle.media = 'print';
  printStyle.textContent = `@page{size:${widthMM}mm ${heightMM}mm;margin:0}html,body{margin:0!important;padding:0!important;width:${widthMM}mm!important;height:${heightMM}mm!important}#print-surface{display:block!important;width:${widthMM}mm!important;height:${heightMM}mm!important;overflow:hidden!important;break-inside:avoid}#print-surface svg{display:block!important;width:${widthMM}mm!important;height:${heightMM}mm!important;max-height:none!important;max-width:none!important}`;
  document.head.appendChild(printStyle);
  const printedSvg = surface.querySelector('svg');
  if (printedSvg) {
    printedSvg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  }
  document.body.appendChild(surface);
  const previousTitle = document.title;
  document.title = filename;
  let fallbackTimer;
  const cleanup = () => {
    clearTimeout(fallbackTimer);
    surface.remove();
    printStyle.remove();
    document.title = previousTitle;
    window.removeEventListener('afterprint', cleanup);
    for (const { dialog, modal, content } of dialogs) {
      if (dialog.isConnected && !dialog.open && dialog.innerHTML === content) {
        try { if (modal) dialog.showModal(); else dialog.show(); } catch { /* Do not interrupt print cleanup. */ }
      }
    }
    if (activePrintCleanup === cleanup) activePrintCleanup = null;
  };
  activePrintCleanup = cleanup;
  window.addEventListener('afterprint', cleanup, { once: true });
  try {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    // afterprint runs after either printing or cancelling. A fallback removes the
    // hidden surface in browsers that omit the event; nothing enters the canvas UI.
    fallbackTimer = setTimeout(cleanup, 300000);
    window.print();
  } catch {
    cleanup();
    throw new Error('无法打开打印窗口，请检查浏览器权限或改用 SVG 导出。');
  }
}

/** Build a downloadable vector/raster artifact without triggering a download. */
export async function createFigureBlob(state, options = {}) {
  const format = options.format === 'tif' ? 'tiff' : options.format || 'svg';
  if (!['svg', 'png', 'tiff'].includes(format)) throw new Error('批量文件支持 SVG、PNG、TIFF；PDF 请使用单图打印。');
  const figure = resolveFigureOptions(state, options);
  if (document.fonts?.ready) await document.fonts.ready;
  const svg = makeSvg(state, figure, format !== 'svg');
  if (format === 'svg') {
    return { blob: new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n', svg.markup], { type: 'image/svg+xml;charset=utf-8' }), extension: 'svg', figure };
  }
  return { blob: await rasterizeSvg(svg, format), extension: format === 'tiff' ? 'tif' : 'png', figure };
}

/** Export exact physical dimensions; PDF opens the system print dialog. */
export async function exportFigure(state, options = {}) {
  const format = options.format || 'svg';
  const name = safeFilename(options.filename || '科研图表').replace(/\.(?:svg|png|pdf|tiff?)$/i, '').slice(0, 110);
  if (format === 'pdf') {
    const figure = resolveFigureOptions(state, options);
    if (document.fonts?.ready) await document.fonts.ready;
    await printFigure(makeSvg(state, figure), name);
  } else {
    const result = await createFigureBlob(state, options);
    downloadBlob(result.blob, `${name}.${result.extension}`);
  }
  return true;
}
