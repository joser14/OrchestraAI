// Markdown -> nicely formatted PDF (headless Edge), so agents deliver real documents instead of raw .md files.
// Usage: node md2pdf.js <input.md|.txt|.html> [output.pdf] [--title "Title"]
// Handles headings, paragraphs, bullet/numbered lists, bold/italic, inline code, code blocks, tables, links,
// quotes, rules and local images. Zero dependencies.
require('./hide-windows.cjs');   // Edge runs without a window
const fs = require('fs'), path = require('path'), os = require('os');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
let title = '';
const ti = args.indexOf('--title'); if (ti >= 0) { title = args[ti + 1] || ''; args.splice(ti, 2); }
const [input, outArg] = args;
if (!input || !fs.existsSync(input)) { console.error('usage: node md2pdf.js <input.md> [output.pdf] [--title "Title"]  (input not found: ' + input + ')'); process.exit(1); }
const out = path.resolve(outArg || input.replace(/\.(md|markdown|txt|html?)$/i, '') + '.pdf');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function inline(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => `<img alt="${alt}" src="${/^[a-z]:\\|^\//i.test(src) ? 'file:///' + src.replace(/\\/g, '/') : src}">`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => `<strong>${a || b}</strong>`)
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(https?:\/\/[^\s<"]+)(?![^<]*<\/a>)/g, (m, u, off, str) => (str.slice(Math.max(0, off - 6), off).includes('href=') ? m : `<a href="${u}">${u}</a>`));
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
}
function mdToHtml(md) {
  const lines = md.replace(/\r\n?/g, '\n').replace(/\\n/g, '\n').split('\n');
  const html = []; let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*```/.test(l)) { const buf = []; i++; while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]); i++; html.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`); continue; }
    const h = l.match(/^(#{1,6})\s+(.*)$/); if (h) { html.push(`<h${h[1].length}>${inline(h[2].replace(/\s#+$/, ''))}</h${h[1].length}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { html.push('<hr>'); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const row = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = row(l); i += 2; const body = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) body.push(row(lines[i++]));
      html.push('<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
        body.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }
    if (/^\s*>/.test(l)) { const buf = []; while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, '')); html.push(`<blockquote>${mdToHtml(buf.join('\n'))}</blockquote>`); continue; }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
      const ordered = /^\s*\d/.test(l); const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        let item = lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, '');
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) item += ' ' + lines[i++].trim();
        const box = item.match(/^\[( |x)\]\s+(.*)$/i);
        items.push(box ? `<li class="task">${box[1].trim() ? '☑' : '☐'} ${inline(box[2])}</li>` : `<li>${inline(item)}</li>`);
      }
      html.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`); continue;
    }
    if (!l.trim()) { i++; continue; }
    const buf = [l]; i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*```|\s*>|\s*([-*+]|\d+[.)])\s+|\s*\|)/.test(lines[i])) buf.push(lines[i++]);
    html.push(`<p>${buf.map(inline).join('<br>')}</p>`);
  }
  return html.join('\n');
}

const src = fs.readFileSync(input, 'utf8').replace(/^\uFEFF/, '');
const isHtml = /\.html?$/i.test(input);
const body = isHtml ? src : mdToHtml(src);
if (!title) { const m = isHtml ? null : src.match(/^#\s+(.+)$/m); title = m ? m[1].trim() : path.basename(out, '.pdf'); }
const doc = isHtml && /<html/i.test(src) ? src : `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
  @page { size: A4; margin: 18mm 16mm 20mm; }
  body { font: 10.5pt/1.55 "Segoe UI", system-ui, sans-serif; color: #1d2330; }
  h1 { font-size: 20pt; margin: 0 0 4pt; color: #17264d; border-bottom: 2px solid #3b6fe0; padding-bottom: 4pt; }
  h2 { font-size: 14pt; margin: 16pt 0 4pt; color: #17264d; } h3 { font-size: 12pt; margin: 12pt 0 3pt; }
  h4, h5, h6 { font-size: 10.5pt; margin: 10pt 0 2pt; }
  p { margin: 0 0 7pt; } ul, ol { margin: 0 0 7pt; padding-left: 18pt; } li { margin: 2pt 0; } li.task { list-style: none; margin-left: -14pt; }
  table { border-collapse: collapse; width: 100%; margin: 6pt 0 10pt; font-size: 9.5pt; page-break-inside: auto; }
  th, td { border: 1px solid #d5dae3; padding: 4pt 6pt; text-align: left; vertical-align: top; } th { background: #eef2fa; }
  tr { page-break-inside: avoid; } tbody tr:nth-child(even) td { background: #f8f9fb; }
  code { font: 9pt Consolas, monospace; background: #f1f3f6; padding: 0 3pt; border-radius: 3px; }
  pre { background: #f1f3f6; padding: 8pt; border-radius: 4px; white-space: pre-wrap; } pre code { background: none; padding: 0; }
  blockquote { margin: 6pt 0; padding: 2pt 10pt; border-left: 3px solid #3b6fe0; color: #4a5368; }
  a { color: #2a56c6; text-decoration: none; } img { max-width: 100%; } hr { border: 0; border-top: 1px solid #d5dae3; margin: 12pt 0; }
  .foot { margin-top: 18pt; font-size: 8pt; color: #8a91a2; border-top: 1px solid #e2e5ec; padding-top: 4pt; }
</style></head><body>${body}<div class="foot">Made by the agent team · ${new Date().toLocaleString()}</div></body></html>`;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2pdf-'));
const htmlFile = path.join(tmpDir, 'doc.html');
// No scripts, no network while printing: an .html input (e.g. a downloaded page) opened with local file access must
// not run code or send anything anywhere. Local images and inline styles still work.
const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file: data:; style-src 'unsafe-inline' file:; font-src file: data:">`;
fs.writeFileSync(htmlFile, /<head[^>]*>/i.test(doc) ? doc.replace(/<head[^>]*>/i, (h) => h + CSP) : CSP + doc);
const edge = require('./browser.cjs').findBrowser();   // Edge, Chrome or Chromium (Linux / DGX Spark: Chromium)
if (!edge) { console.error('No Chromium-based browser found (install Microsoft Edge, Google Chrome or Chromium)'); process.exit(1); }
try { fs.unlinkSync(out); } catch {}
try {
  execFileSync(edge, ['--headless', '--disable-gpu', '--no-pdf-header-footer', '--allow-file-access-from-files',
    `--user-data-dir=${path.join(tmpDir, 'profile')}`, `--print-to-pdf=${out}`, 'file:///' + htmlFile.replace(/\\/g, '/')], { stdio: 'ignore', timeout: 90000 });
} catch {}
fs.rmSync(tmpDir, { recursive: true, force: true });
if (!fs.existsSync(out) || fs.statSync(out).size < 500) { console.error('PDF was not created: ' + out); process.exit(1); }
console.log(`PDF created: ${out} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
