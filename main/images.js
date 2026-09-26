'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { fetchImage, uploadFile, initImage, SIGNED_OUT } = require('../sdk/assets');
const content = require('../sdk/content');
const { ulid } = require('../sdk/node');
const { mut, subscribe } = require('./documents');
const { S } = require('./state');

// ---- images: tana:image: uri -> data URL, cached under userData/images/<sha1(uri)> (the data URL as text)
// Only a load in flight is kept here, so two rows asking at once share one fetch; once it settles the file answers.
// A map of every image ever shown held each one in memory for the session (issue #271), beside the file and the
// renderer's own cache of 200 (renderer/render.js), which counts on this file cache and not on main's memory.
const loading = new Map(); // uri -> Promise<data URL>
function image(uri) {
  if (!S.session) return Promise.reject(new Error('not logged in to Tana'));
  if (!loading.has(uri)) loading.set(uri, loadImage(uri).finally(() => loading.delete(uri)));
  return loading.get(uri);
}
async function loadImage(uri) {
  const dir = path.join(S.userData, 'images'), file = path.join(dir, createHash('sha1').update(uri).digest('hex'));
  const cached = await fs.readFile(file, 'utf8').catch(() => null);
  if (cached) return cached;
  const { mime, bytes } = await fetchImage(uri, { getAccessToken: (o) => S.session.getAccessToken(o) });
  const url = 'data:' + mime + ';base64,' + bytes.toString('base64');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, url);
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

module.exports = { image, loadImage, insertImage, cancelUpload };
