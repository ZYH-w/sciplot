import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

const root = path.dirname(fileURLToPath(import.meta.url));
const outputName = '简图-SciPlot.html';
const moduleFiles = ['data-core.js', 'plot-engine.js', 'excel-import.js', 'export-utils.js', 'data-processing.js', 'processing-ui.js', 'publication-utils.js', 'analysis-core.js', 'analysis-ui.js', 'worksheet-ui.js', 'figure-editor.js', 'batch-core.js', 'batch-ui.js', 'app.js'];
const assetFiles = ['index.html', 'style.css', 'favicon.svg', 'assets/xlsx.full.min.js', 'assets/SHEETJS-LICENSE.txt'];
const sources = new Map(await Promise.all([...moduleFiles, ...assetFiles].map(async name => [name, await readFile(path.join(root, name), 'utf8')])));
const moduleInfo = new Map();
const identifier = /^[$A-Z_a-z][$\w]*$/;

function parseBindings(text, mode) {
  return text.split(',').map(value => value.trim()).filter(Boolean).map(value => {
    const parts = value.split(/\s+as\s+/).map(part => part.trim());
    if (parts.length > 2 || !parts.every(part => identifier.test(part))) throw new Error(`不支持的${mode}命名绑定：${value}`);
    const [original, alias = original] = parts;
    return { original, alias };
  });
}

function transformModule(filename, source) {
  const exported = new Map();
  const dependencies = [];
  let transformed = source.replace(/^\s*import\s*\{([^}]*)\}\s*from\s*(['"])([^'"\r\n]+)\2\s*;?/gm, (_match, bindings, _quote, specifier) => {
    if (!specifier.startsWith('./')) throw new Error(`${filename} 引用了非本地模块 ${specifier}。`);
    const dependency = specifier.slice(2);
    if (!moduleFiles.includes(dependency)) throw new Error(`${filename} 的依赖 ${dependency} 未包含在独立版中。`);
    dependencies.push(dependency);
    const destructuring = parseBindings(bindings, '导入').map(({ original, alias }) => original === alias ? original : `${original}: ${alias}`).join(', ');
    return `\nconst { ${destructuring} } = __modules[${JSON.stringify(dependency)}];\n`;
  });
  transformed = transformed.replace(/^([ \t]*)export[ \t]+((?:async[ \t]+)?function|class|const|let|var)[ \t]+([$A-Z_a-z][$\w]*)/gm, (_match, indent, kind, name) => {
    exported.set(name, name);
    return `${indent}${kind} ${name}`;
  });
  transformed = transformed.replace(/^\s*export\s*\{([^}]*)\}\s*;?/gm, (_match, bindings) => {
    for (const { original, alias } of parseBindings(bindings, '导出')) exported.set(alias, original);
    return '\n';
  });
  if (/^[ \t]*(?:import|export)\b/m.test(transformed)) throw new Error(`${filename} 含独立版尚不支持的模块语法，请使用静态具名导入与导出。`);
  const properties = [...exported].map(([name, local]) => `${JSON.stringify(name)}: ${local}`).join(', ');
  const wrapped = `__modules[${JSON.stringify(filename)}] = (() => {\n'use strict';\n${transformed}\nreturn Object.freeze({ ${properties} });\n})();`;
  // Compile but never run application code during the build. Missing braces,
  // unsupported top-level await and malformed rewrites fail before output changes.
  new vm.Script(wrapped, { filename });
  return { wrapped, dependencies };
}

for (const name of moduleFiles) moduleInfo.set(name, transformModule(name, sources.get(name)));
const ordered = [];
const completed = new Set();
const visiting = new Set();
function visit(name) {
  if (completed.has(name)) return;
  if (visiting.has(name)) throw new Error(`模块循环依赖：${name}`);
  visiting.add(name);
  for (const dependency of moduleInfo.get(name).dependencies) visit(dependency);
  visiting.delete(name);
  completed.add(name);
  ordered.push(name);
}
for (const name of moduleFiles) visit(name);

// HTML parses script end tags even inside JS string literals. Escape their
// slash; JavaScript still produces exactly the original string value.
const escapeScript = source => source.replace(/<\/script/gi, match => `<\\/${match.slice(2)}`);
const escapeStyle = source => source.replace(/<\/style/gi, match => `<\\/${match.slice(2)}`);
const vendor = escapeScript(sources.get('assets/xlsx.full.min.js'));
const bundle = escapeScript(`(() => {\n'use strict';\nconst __modules = Object.create(null);\n${ordered.map(name => `\n// ${name}\n${moduleInfo.get(name).wrapped}`).join('\n')}\n})();`);
new vm.Script(vendor, { filename: 'xlsx.full.min.js' });
new vm.Script(bundle, { filename: 'sciplot-standalone.js' });

let html = sources.get('index.html');
html = html.replace(/<script\b[^>]*\bsrc\s*=\s*(['"])[^'"]+\1[^>]*>[\s\S]*?<\/script\s*>\s*/gi, '');
html = html.replace(/<link\b[^>]*\brel\s*=\s*(['"])stylesheet\1[^>]*>\s*/gi, '');
const favicon = `data:image/svg+xml,${encodeURIComponent(sources.get('favicon.svg').trim())}`;
html = html.replace(/<link\b[^>]*\brel\s*=\s*(['"])icon\1[^>]*>/gi, () => `<link rel="icon" type="image/svg+xml" href="${favicon}">`);
// In file:// mode, the original home link points at a directory. Keep it on
// the current document so the logo cannot navigate out of the application.
html = html.replace(/href=(['"])\.\/\1/g, 'href="#"');
const signature = createHash('sha256').update([...sources].map(([name, source]) => `${name}\0${source}`).join('\0')).digest('hex').slice(0, 16);
html = html.replace('</head>', () => `<style>\n${escapeStyle(sources.get('style.css'))}\n</style>\n</head>`);
// Callback replacements preserve literal $&, $' and other replacement tokens
// that legitimately occur inside the bundled vendor and application source.
html = html.replace('</body>', () => `<!-- SciPlot standalone source ${signature}. Fully local; no installation or network required. -->\n<script type="text/plain" id="sheetjs-license">${escapeScript(sources.get('assets/SHEETJS-LICENSE.txt'))}</script>\n<script>\n${vendor}\n</script>\n<script>\n${bundle}\n</script>\n</body>`);
if (/<(?:script|link)\b[^>]*(?:src|href)\s*=\s*["'](?:https?:|\.\/)/i.test(html)) throw new Error('独立版仍存在外部脚本或样式依赖，已取消生成。');

await writeFile(path.join(root, outputName), html, 'utf8');
console.log(`已生成 ${path.join(root, outputName)}\n${Buffer.byteLength(html).toLocaleString('en-US')} 字节；${ordered.length} 个应用模块；SheetJS 与许可已内嵌。`);
