import http from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.dirname(fileURLToPath(import.meta.url));
const rootReal = await realpath(root);
const port = Number(process.env.PORT || 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('PORT 必须为 1 到 65535 之间的整数。');
  process.exit(1);
}
const url = `http://127.0.0.1:${port}`;
const shouldOpen = process.argv.includes('--open');
const rootFiles = new Set([
  'index.html', 'app.js', 'style.css', 'styles.css', 'data-core.js',
  'plot-engine.js', 'excel-import.js', 'export-utils.js', 'data-processing.js',
  'processing-ui.js', 'favicon.svg', 'icon.svg',
]);
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

function openBrowser() {
  const command = process.platform === 'win32' ? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/d', '/c', 'start', '', url] : [url];
  const child = spawn(command, args, { windowsHide: true, stdio: 'ignore' });
  child.on('error', () => console.log(`请手动打开 ${url}`));
  child.unref();
}

const server = http.createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-SciPlot-Server', '1');
  const send = (status, text) => {
    response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(request.method === 'HEAD' ? undefined : text);
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    return send(405, 'Method not allowed');
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, url).pathname);
  } catch {
    return send(400, 'Invalid path');
  }
  if (pathname === '/__sciplot_health') return send(200, 'SciPlot');
  if (pathname === '/') pathname = '/index.html';
  const relative = pathname.slice(1);
  const parts = relative.split('/');
  if (relative.includes('\\') || relative.includes('\0') ||
      parts.some(part => !part || part.startsWith('.')) ||
      !(rootFiles.has(relative) || (parts[0] === 'assets' && mime[path.extname(relative).toLowerCase()]))) {
    return send(404, 'Not found');
  }
  const target = path.resolve(root, ...parts);
  try {
    const targetReal = await realpath(target);
    const checkRelative = path.relative(rootReal, targetReal);
    if (checkRelative.startsWith('..') || path.isAbsolute(checkRelative)) return send(404, 'Not found');
    const body = await readFile(targetReal);
    response.writeHead(200, {
      'Content-Type': mime[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch (error) {
    send(error.code === 'ENOENT' || error.code === 'EISDIR' ? 404 : 500, error.code === 'ENOENT' || error.code === 'EISDIR' ? 'Not found' : 'Unable to read file');
  }
});

server.on('error', (error) => {
  if (error.code !== 'EADDRINUSE') {
    console.error(`启动失败：${error.message}`);
    process.exitCode = 1;
    return;
  }
  const request = http.get(`${url}/__sciplot_health`, { timeout: 1500 }, (response) => {
    response.resume();
    if (response.statusCode === 200 && response.headers['x-sciplot-server'] === '1') {
      console.log(`简图 SciPlot 已在运行：${url}`);
      if (shouldOpen) openBrowser();
    } else {
      console.error(`端口 ${port} 已被其他程序占用。请设置 PORT 后重试。`);
      process.exitCode = 1;
    }
  });
  request.on('timeout', () => request.destroy(new Error('timeout')));
  request.on('error', () => {
    console.error(`端口 ${port} 不可用，请设置 PORT 后重试。`);
    process.exitCode = 1;
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`简图 SciPlot  ${url}\n数据仅在当前浏览器中处理。按 Ctrl+C 结束服务。`);
  if (shouldOpen) openBrowser();
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
