'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { renderPdfHtml } = require('../main/pdf');
const p = text => ({ text });
const h = text => ({ text, heading: 1 });
const bullet = (text, children = []) => ({ text, block: 'bullet', children });
const samples = [
  ['meeting-notes', 'Product review · September', [
    p('22 September 2026 · Example meeting notes'),
    h('A calmer start to the day'),
    p('We reviewed the first version of the daily overview. The aim is simple: make the next useful action easy to find, without turning the page into another dashboard.'),
    { segments: [{ text: 'Decision. ', marks: { bold: true } }, { text: 'Ship the focused overview to a small pilot group before expanding its scope.' }] },
    h('What we learned'),
    bullet('People start with a question, not a list of features.', [bullet('What needs my attention today?'), bullet('What changed since I last looked?')]),
    bullet('Context matters more than the number of items shown.'),
    { text: '“If I can understand my morning in a minute, this has done its job.”', block: 'quote' },
    h('Next steps'),
    { ...bullet('Confirm the pilot group'), done: 1 },
    { ...bullet('Test the overview with five colleagues'), done: 0 },
    { ...bullet('Review feedback at the next product meeting'), done: 0 },
    { segments: [{ text: 'Related: ' }, { mention: { label: 'Daily overview brief', uri: 'tana:text:example' } }] }
  ]],
  ['project-brief', 'Make room for focused work', [
    p('Project brief · Example content'),
    h('The opportunity'),
    p('Useful information is scattered across notes, tasks and conversations. People spend time reconstructing the context before they can make a decision. We want that context to travel with the work.'),
    h('A small, useful first release'),
    { text: 'Show the document and its main content clearly.', block: 'numbered' },
    { text: 'Keep references readable and links available.', block: 'numbered' },
    { text: 'Make it easy to share a polished, portable copy.', block: 'numbered' },
    h('How we will judge it'),
    bullet('A reader can identify the purpose and decision without opening another app.'),
    bullet('The export preserves the author’s structure: headings, lists and emphasis.'),
    bullet('Longer documents remain comfortable to read on paper.'),
    { block: 'divider' },
    { segments: [{ text: 'Scope: ', marks: { bold: true } }, { text: 'the main document content. ', marks: { italic: true } }, { text: 'App navigation and editing controls stay out of the PDF.' }] },
    { segments: [{ text: 'Background reading', marks: { link: 'https://example.com/project' } }] }
  ]],
  ['long-document', 'Implementation notes & field guide', [
    p('Example content · Long-form layout and pagination'),
    h('A document that travels well'),
    p('This sample exercises the same renderer used by Export to PDF. It includes an illustration, formatted text, code and nested lists, followed by enough material to show the page boundaries.'),
    { type: 'image', image: { uri: 'sample', alt: 'Plan, build and review' } },
    h('A repeatable workflow'),
    bullet('Plan', [bullet('Write down the outcome.'), bullet('Name the constraint that matters most.')]),
    bullet('Build', [bullet('Use the smallest working implementation.'), bullet('Keep the document structure intact.')]),
    bullet('Review', [bullet('Read the PDF at normal size.'), bullet('Check the page boundaries and links.')]),
    { text: 'const outcome = await exportPdf(documentId);\nconsole.log(outcome);', block: 'code' },
    ...Array.from({ length: 7 }, (_, i) => [h(`${i + 1}. ${['Start with the reader', 'Keep the hierarchy clear', 'Let the text breathe', 'Keep references in context', 'Make long pages readable', 'Check the details', 'Share the result'][i]}`),
      p('A useful document makes its reasoning easy to follow. Start each section with the point the reader needs, then add the evidence and the practical consequence. Short paragraphs help, but the structure should follow the idea rather than an arbitrary word count.'),
      p('Keep related information together. A heading belongs with the paragraph that follows it, a list should retain its order, and an illustration should remain inside the page. The exported copy should feel like a document prepared for reading.'),
      bullet('Check the main idea at a glance.'), bullet('Read the detail at a comfortable pace.')]).flat()
  ]]
];
async function check() {
  const html = await renderPdfHtml('<Title & test>', [{ text: '<script>alert(1)</script>' }, { segments: [{ text: 'unsafe', marks: { link: 'javascript:alert(1)' } }] }, bullet('parent', [bullet('folded child')]), { text: 'one', block: 'numbered' }, { text: 'two', block: 'numbered' }, { text: 'done', done: 1 }]);
  assert(html.includes('&lt;Title &amp; test&gt;'));
  assert(!html.includes('<script>'));
  assert(!html.includes('javascript:'));
  assert(html.includes('<ul><li>parent<ul><li>folded child</li></ul></li></ul>'));
  assert(html.includes('<ol><li>one</li><li>two</li></ol>'));
  assert(html.includes('☑ done'));
  await assert.rejects(renderPdfHtml('Image', [{ type: 'image', image: { uri: 'x' } }], async () => 'https://example.com/image'));
  console.log('PDF HTML checks passed');
}
async function renderSamples() {
  const { app, BrowserWindow } = require('electron');
  await app.whenReady();
  const dir = '/tmp/orbital-pdf-examples';
  await fs.mkdir(dir, { recursive: true });
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    // Raster illustration keeps the sample self-contained, just like real cached Tana images.
    await win.loadURL('data:text/html,<html></html>');
    const illustration = await win.webContents.executeJavaScript(`(() => { const c = document.createElement('canvas'); c.width = 1200; c.height = 240; const x = c.getContext('2d'); x.fillStyle = '#eef3f7'; x.fillRect(0,0,1200,240); ['Plan','Build','Review'].forEach((s,i) => { x.fillStyle = ['#d2e3ed','#b3cfdc','#86aebb'][i]; x.fillRect(45+i*390,40,330,160); x.fillStyle='#243d4b'; x.font='36px sans-serif'; x.fillText(s,80+i*390,135); }); return c.toDataURL(); })()`);
    for (const [name, title, nodes] of samples) {
      const html = await renderPdfHtml(title, nodes, async () => illustration);
      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      await win.webContents.executeJavaScript('Promise.all([document.fonts.ready, ...Array.from(document.images, img => img.decode())]).then(() => true)');
      const pdf = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, generateTaggedPDF: true });
      assert(pdf.subarray(0, 5).toString() === '%PDF-');
      await fs.writeFile(path.join(dir, name + '.pdf'), pdf);
      console.log(path.join(dir, name + '.pdf'));
    }
  } finally { win.destroy(); app.quit(); }
}
check().then(() => { if (process.argv.includes('--render')) return renderSamples(); }).catch(e => { console.error(e); process.exitCode = 1; if (process.versions.electron) require('electron').app.quit(); });
