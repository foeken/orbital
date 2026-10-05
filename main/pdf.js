'use strict';
const fs = require('node:fs/promises');
const { readNode } = require('../sdk/node');
const { isId } = require('../sdk/ids');
const { readOutline } = require('../sdk/content');
const { op, resolveReferences } = require('./documents');
const { image } = require('./images');

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const link = (url, label) => /^https?:\/\//i.test(url || '') ? `<a href="${escape(url)}">${label}</a>` : label;
function inline(node) {
  return (node.segments?.length ? node.segments : [{ text: node.text }]).map(s => {
    if (s.mention) return `<span class="mention">${escape(s.mention.label || s.mention.uri)}</span>`;
    let text = escape(s.text);
    for (const [mark, tag] of Object.entries({ bold: 'strong', italic: 'em', strike: 's', code: 'code' })) if (s.marks?.[mark]) text = `<${tag}>${text}</${tag}>`;
    return link(s.marks?.link, text);
  }).join('');
}
async function renderPdfHtml(title, nodes, loadImage = image) {
  async function blocks(rows) {
    let html = '', list = '';
    for (const n of rows) {
      const kind = n.block === 'bullet' ? 'ul' : n.block === 'numbered' ? 'ol' : '';
      if (list !== kind) { if (list) html += `</${list}>`; if (kind) html += `<${kind}>`; list = kind; }
      let body = inline(n);
      if (n.type === 'reference') body = `<span class="mention">${escape(n.reference?.node?.text || n.reference?.node?.title || n.reference?.label || n.reference?.uri || 'Reference')}</span>`;
      if (n.type === 'image') {
        const src = await loadImage(n.image.uri);
        if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(src)) throw new Error('Cannot export this image');
        body = `<img src="${escape(src)}" alt="${escape(n.image.alt || '')}">`;
      }
      const tag = kind ? 'li' : n.heading ? 'h' + Math.min(6, Math.max(2, Number(n.heading) + 1)) : n.block === 'quote' ? 'blockquote' : n.block === 'code' ? 'pre' : 'p';
      if (n.block === 'divider') html += '<hr>';
      else html += `<${tag}${kind && n.done !== undefined ? ' class="checklist"' : ''}>${n.done === undefined ? '' : n.done ? '☑ ' : '☐ '}${body}${kind ? await blocks(n.children || []) : ''}</${tag}>`;
      if (!kind && n.children?.length) html += await blocks(n.children);
    }
    return html + (list ? `</${list}>` : '');
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>${escape(title)}</title><style>
@page { size: A4; margin: 20mm 21mm; }
* { box-sizing: border-box; }
body { margin: 0; color: #20242b; background: white; font: 11pt/1.65 -apple-system, BlinkMacSystemFont, sans-serif; overflow-wrap: anywhere; }
h1 { font-size: 27pt; line-height: 1.18; letter-spacing: -.7pt; margin: 0 0 10mm; padding-bottom: 6mm; border-bottom: 1px solid #dce0e5; }
h2,h3,h4,h5,h6 { line-height: 1.3; margin: 7mm 0 2.5mm; break-after: avoid; }
h2 { font-size: 18pt; } h3 { font-size: 14pt; } h4,h5,h6 { font-size: 12pt; }
p { margin: 0 0 3mm; white-space: pre-wrap; min-height: 1em; }
ul,ol { margin: 2mm 0 4mm; padding-left: 7mm; } li { margin: 1.5mm 0; white-space: pre-wrap; } li ul,li ol { white-space: normal; margin-bottom: 1mm; }
li.checklist { list-style: none; }
p,li { orphans: 3; widows: 3; }
a { color: #245a82; text-decoration: underline; } .mention { color: #35556c; }
blockquote { border-left: 3px solid #b6c7d4; margin: 4mm 0; padding: 1mm 0 1mm 5mm; color: #4b5661; white-space: pre-wrap; }
code,pre { font-family: Menlo, monospace; font-size: 9pt; background: #f3f5f7; } code { padding: .3mm 1mm; border-radius: 2px; } pre { padding: 4mm; white-space: pre-wrap; }
img { display: block; max-width: 100%; max-height: 235mm; object-fit: contain; margin: 4mm 0; break-inside: avoid; }
hr { border: 0; border-top: 1px solid #dce0e5; margin: 6mm 0; }
</style></head><body><h1>${escape(title)}</h1>${await blocks(nodes)}</body></html>`;
}
async function exportPdf(id, parent) {
  if (!isId(id, 'text')) throw new Error('Choose a document to export');
  const { BrowserWindow, dialog } = require('electron');
  const title = await op(id, doc => readNode(doc).title || 'Untitled');
  const { canceled, filePath } = await dialog.showSaveDialog(parent, { title: 'Export to PDF', defaultPath: title.replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').slice(0, 160) + '.pdf', filters: [{ name: 'PDF document', extensions: ['pdf'] }] });
  if (canceled || !filePath) return;
  const html = await op(id, async doc => renderPdfHtml(readNode(doc).title || 'Untitled', await resolveReferences(readOutline(doc))));
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await win.webContents.executeJavaScript('Promise.all([document.fonts.ready, ...Array.from(document.images, img => img.decode())]).then(() => true)');
    const pdf = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, generateTaggedPDF: true });
    await fs.writeFile(filePath, pdf);
    return filePath;
  } finally { win.destroy(); }
}
module.exports = { exportPdf, renderPdfHtml };
