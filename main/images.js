'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { fetchImage } = require('../sdk/assets');
const { S, imageCache } = require('./state');

// ---- images: tana:image: uri -> data URL, cached in memory and under userData/images/<sha1(uri)> (the data URL as text)
function image(uri) {
  if (!S.session) return Promise.reject(new Error('not logged in to Tana'));
  if (!imageCache.has(uri)) imageCache.set(uri, loadImage(uri).catch((e) => { imageCache.delete(uri); throw e; }));
  return imageCache.get(uri);
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


module.exports = { image, loadImage };
