'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { fetchImage, uploadFile, initImage, SIGNED_OUT } = require('../sdk/assets');
const content = require('../sdk/content');
const { ulid } = require('../sdk/node');
const { mut, refusedWrite, subscribe } = require('./documents');
const { S } = require('./state');

// ---- images: tana:image: uri -> data URL, cached under userData/images/<sha1(uri)> (the data URL as text)
// Only a load in flight is kept here, so two rows asking at once share one fetch; once it settles the file answers.
// A map of every image ever shown held each one in memory for the session (issue #271), beside the file and the
// renderer's own cache of 200 (renderer/render.js), which counts on this file cache and not on main's memory.
// What collaborators' images may cost (security review finding 7): a few fetches at once, each within the SDK's
// IMAGE_LIMIT, and a file cache of at most LIMITS.cache bytes, the least recently shown going first once it is past that.
const LIMITS = { parallel: 4, cache: 512 * 1024 * 1024 };
const loading = new Map(); // uri -> Promise<data URL>
function image(uri) {
  if (!S.session) return Promise.reject(new Error('not logged in to Tana'));
  if (!loading.has(uri)) loading.set(uri, loadImage(uri).finally(() => loading.delete(uri)));
  return loading.get(uri);
}
// at most LIMITS.parallel fetches at once: the rest wait their turn, handed the slot one by one
let fetching = 0;
const queued = [];
async function inTurn(fn) {
  if (fetching < LIMITS.parallel) fetching++; else await new Promise((resolve) => queued.push(resolve));
  try { return await fn(); } finally { const next = queued.shift(); if (next) next(); else fetching--; }
}
// What the cache holds, counted the first time a file is written, then kept as files come and go. Past LIMITS.cache it
// is cut to three quarters, oldest shown first (a read touches its file).
let cached = null, cachedIn = null;
async function prune(dir) {
  const files = (await Promise.all((await fs.readdir(dir)).map(async (f) => { const file = path.join(dir, f), s = await fs.stat(file).catch(() => null); return s && s.isFile() && { file, size: s.size, at: s.mtimeMs }; }))).filter(Boolean);
  cached = files.reduce((n, f) => n + f.size, 0);
  if (cached <= LIMITS.cache) return;
  for (const f of files.sort((a, b) => a.at - b.at)) {
    if (cached <= LIMITS.cache * 0.75) break;
    await fs.rm(f.file, { force: true }); cached -= f.size;
  }
}
async function loadImage(uri) {
  const dir = path.join(S.userData, 'images'), file = path.join(dir, createHash('sha1').update(uri).digest('hex'));
  const kept = await fs.readFile(file, 'utf8').catch(() => null);
  if (kept) { const now = new Date(); fs.utimes(file, now, now).catch(() => {}); return kept; }
  const { mime, bytes } = await inTurn(() => fetchImage(uri, { getAccessToken: (o) => S.session.getAccessToken(o) }));
  const url = 'data:' + mime + ';base64,' + bytes.toString('base64');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, url);
  if (cachedIn !== dir) { cached = null; cachedIn = dir; } // another account's folder (userData) counts afresh
  if (cached === null || (cached += Buffer.byteLength(url)) > LIMITS.cache) await prune(dir);
  return url;
}

// An added image, in Tana's own order (useImageUpload): the bytes to its file store, a tana:image: document owned by
// the page, then the block naming it — so no block points at an image that does not exist. docId may be a field's
// outline ("<doc>|<type>?attribute=<key>"); the image still belongs to the document. Returns the new block id.
// uploadId names it for cancelUpload: Esc on its placeholder aborts the upload, and nothing is written after that.
// ponytail: Tana also asks its AI service to title and describe the image (describeAndUpdateImage); add it if wanted
const uploading = new Map(); // uploadId -> AbortController
async function insertImage(docId, nodeId, { bytes, filename, mimeType }, uploadId) {
  if (!S.session) throw new Error(SIGNED_OUT);
  const refused = refusedWrite(docId); // a meeting's notes shared since (main/meeting-notes.js): no image is made under them either
  if (refused) throw new Error(refused);
  const ownerUri = String(docId).split('|')[0];
  const ctrl = new AbortController();
  if (uploadId) uploading.set(uploadId, ctrl);
  let up;
  try {
    up = await uploadFile(bytes, { filename, mimeType, signal: ctrl.signal, getAccessToken: (o) => S.session.getAccessToken(o) });
  } finally { uploading.delete(uploadId); }
  if (ctrl.signal.aborted) throw new Error('upload cancelled');
  const uri = 'tana:image:' + ulid();
  const made = await subscribe(uri, (loro) => initImage(loro, { ownerUri, cid: up.cid, width: up.width, height: up.height, blurhash: up.blurhash, filename, mimeType, fileSize: bytes.length }));
  if (!made) throw new Error(S.status.error || 'could not create ' + uri);
  return mut(docId, (doc) => content.insertImage(doc, nodeId, uri));
}

const cancelUpload = (uploadId) => { uploading.get(uploadId)?.abort(); };

// What the renderer asks this module (preload.js names each channel for the page; main.js registers the table).
const ipc = {
  'image': (_e, uri) => image(uri),
  'block:insertImage': (_e, id, nodeId, file, uploadId) => insertImage(id, nodeId, file, uploadId), // file { bytes, filename, mimeType }: upload, image document, block after nodeId
  'block:cancelUpload': (_e, uploadId) => cancelUpload(uploadId),
};

module.exports = { image, loadImage, insertImage, cancelUpload, ipc, LIMITS };
