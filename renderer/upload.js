'use strict';
// Adding images to an outline (#28): pasted, picked with "/" Image, or dropped from the Finder. All three end here,
// in one queue per call: a placeholder row for each file at once, then the files one at a time through
// api.insertImage, each placeholder swapped for its image row as it lands. Esc on a placeholder cancels that file
// only, and a refusal shows in the error line without stopping the files behind it.

// Tana's image extensions; a clipboard image may come without a name, so an image/* type counts too.
const IMAGE_EXT = /\.(heic|heif|jpe?g|png|gif|webp|avif|svg|bmp|ico|tiff?)$/i;
const UPLOAD_MAX = 52428800; // Tana refuses more than 50 MB before sending, and so does this, before reading the bytes
const imageFiles = (files) => [...(files || [])].filter((f) => IMAGE_EXT.test(f.name || '') || String(f.type || '').startsWith('image/'));
let uploads = []; // [{ id, docId, after, node }] every placeholder on screen, in the order the files were given
let uploadSeq = 0;

// A placeholder is not in Tana, so a reload would drop it: every row list of docId gets them put back behind the
// row each follows (after null: the end of the outline), several behind one row in the order they were given.
function syncUploads(docId, list = kids.get(docId)) {
  if (!Array.isArray(list)) return list;
  const strip = (l) => { for (let i = l.length - 1; i >= 0; i--) if (l[i].upload) l.splice(i, 1); else if (l[i].children) strip(l[i].children); };
  const find = (l, id) => { for (let i = 0; i < l.length; i++) { if (l[i].id === id) return { l, i }; const f = l[i].children && find(l[i].children, id); if (f) return f; } return null; };
  strip(list);
  for (const u of uploads) {
    if (u.docId !== docId) continue;
    const at = u.after == null ? { l: list, i: list.length - 1 } : find(list, u.after);
    if (!at) continue; // the row it follows is gone: the write will say so
    let i = at.i + 1;
    while (at.l[i]?.upload) i++;
    at.l.splice(i, 0, u.node);
  }
  return list;
}
function cancelUpload(item, el) {
  moveTo(el, -1, Infinity);
  uploads = uploads.filter((u) => u.node !== item.node);
  if (tana.cancelUpload) tana.cancelUpload(item.node.id);
  syncUploads(item.docId);
  render(true);
}
// Uploads files as image rows behind row `after` of docId (null: at the end). When the last one lands and the caret
// is still where it was when this started — or on a placeholder, or nowhere — it moves to the last new image, so
// Space previews it, ⌘⇧⌫ removes it and ⌘⇧↑/↓ moves it.
async function uploadImages(docId, after, files) {
  const active = document.activeElement, fromKey = active && inRows(active) ? keyOfEl(active) : null;
  // Still where this started: the caret has not gone off to another row. Only then is the outline redrawn under
  // it, and only then does the caret move to the new image.
  const here = () => { const a = document.activeElement, k = a && inRows(a) ? keyOfEl(a) : null; return !k || k === fromKey || k.includes('/upload:'); };
  const mine = [];
  for (const f of files) {
    if (f.size > UPLOAD_MAX) { showError(new Error('File is too large (max 50 MB)')); continue; }
    const id = 'upload:' + (++uploadSeq), name = f.name || 'image';
    mine.push({ id, docId, after, file: f, node: { id, kind: 'block', block: 'paragraph', text: name, upload: true, editable: false, hasChildren: false, children: [] } });
  }
  if (!mine.length) return;
  uploads.push(...mine);
  syncUploads(docId);
  render(true);
  let last = null;
  for (const [n, u] of mine.entries()) {
    if (!uploads.includes(u)) continue; // cancelled before its turn
    try {
      const bytes = new Uint8Array(await u.file.arrayBuffer());
      if (!uploads.includes(u)) continue; // cancelled while its bytes were read
      last = await tana.insertImage(docId, u.after, { bytes, filename: u.node.text, mimeType: u.file.type || 'application/octet-stream' }, u.id);
      for (const o of mine.slice(n + 1)) if (o.after === u.after) o.after = last; // the next one follows this image
    } catch (e) { if (uploads.includes(u)) showError(e); } // a cancelled upload says nothing
    uploads = uploads.filter((o) => o !== u);
    await reload(docId).catch(showError);
    render(here());
  }
  if (last && here()) placeCaret(keyFor(docId, { kind: 'block', id: last }));
}
// Process image (issue #507): an image becomes a task or a note, read by the model in main (ai:processImage), and
// opens here. The image is a File dropped on Create new (shell.js), or from Cmd+K { clipboard: true } or an image
// row's { uri } (renderer/palette.js). The corner button says "Processing image …" meanwhile (shell.js createAs).
async function processImage(source) {
  toShell({ orbital: 'processing' });
  try {
    if (source instanceof File) {
      if (!imageFiles([source]).length) throw new Error('Drop an image to process');
      if (source.size > UPLOAD_MAX) throw new Error('File is too large (max 50 MB)');
      source = { bytes: new Uint8Array(await source.arrayBuffer()), filename: source.name || 'image', mimeType: source.type };
    }
    const node = await tana.processImage(source);
    await goTo(node.id);
  } catch (e) { showError(e); }
  toShell({ orbital: 'processed' });
}
