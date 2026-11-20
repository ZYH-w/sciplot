import { renderPlot } from './plot-engine.js';

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

function makeSvg(state, width, background) {
  const markup = renderPlot(state, { width: 900, height: 620, interactive: false });
  const documentSvg = new DOMParser().parseFromString(markup, 'image/svg+xml');
  if (documentSvg.querySelector('parsererror')) throw new Error('图形内容无法生成 SVG，请检查图表设置。');
  const root = documentSvg.documentElement;
  const height = Math.round(width * 620 / 900);
  root.setAttribute('width', String(width));
  root.setAttribute('height', String(height));
  root.setAttribute('viewBox', '0 0 900 620');
  const color = typeof background === 'string' && globalThis.CSS?.supports('color', background) ? background : '#fff';
  root.setAttribute('style', `background:${color}`);
  const backgroundRect = Array.from(root.children).find(child => child.localName === 'rect');
  if (backgroundRect) backgroundRect.setAttribute('fill', color);
  return { markup: new XMLSerializer().serializeToString(root), width, height };
}

async function rasterizeSvg(svg) {
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
    return await new Promise((resolve, reject) => canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error('PNG 生成失败，请降低导出尺寸后重试。'));
    }, 'image/png'));
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
  const printedSvg = surface.querySelector('svg');
  if (printedSvg) {
    // A full-width 900:620 chart is slightly taller than the A4 landscape
    // printable area with 12 mm margins. Bound its height to keep one page.
    printedSvg.style.maxHeight = '180mm';
    printedSvg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  }
  document.body.appendChild(surface);
  const previousTitle = document.title;
  document.title = filename;
  let fallbackTimer;
  const cleanup = () => {
    clearTimeout(fallbackTimer);
    surface.remove();
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

/** Export a figure. PDF opens the browser print dialog (choose Save as PDF). */
export async function exportFigure(state, options = {}) {
  const { format = 'svg', width = 2400, filename = '科研图表', background = '#fff' } = options;
  if (!['svg', 'png', 'pdf'].includes(format)) throw new Error('请选择 SVG、PNG 或 PDF 导出格式。');
  const outputWidth = Math.round(Number(width));
  if (!Number.isFinite(outputWidth) || outputWidth < 1 || outputWidth > 100000) throw new Error('请输入有效的导出宽度。');
  if (format === 'png' && (outputWidth < 600 || outputWidth > 8000)) throw new Error('PNG 导出宽度需在 600 到 8000 像素之间。');
  const name = safeFilename(filename).replace(/\.(?:svg|png|pdf)$/i, '').slice(0, 110);
  if (document.fonts?.ready) await document.fonts.ready;
  const svg = makeSvg(state, outputWidth, background);
  if (format === 'svg') {
    downloadBlob(new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n', svg.markup], { type: 'image/svg+xml;charset=utf-8' }), `${name}.svg`);
  } else if (format === 'png') {
    downloadBlob(await rasterizeSvg(svg), `${name}.png`);
  } else {
    await printFigure(svg, name);
  }
  return true;
}
