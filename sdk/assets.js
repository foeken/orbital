'use strict';
// Image bytes for a tana:image: uri, the way the web client's Ok()/Dk() helpers do it: GET
// <POLARIS_SERVICE_API_URL>/images/by-uri/<uri>[?w=&h=&format=&quality=&fit=] with the bearer token answers 302 to a
// signed imgproxy URL on images.tana.inc plus a Cloud-CDN-Cookie; the signed URL is 403 without that cookie.
// (/images/<cid> and /files/<cid>/download exist too; by-uri saves reading the image document for its cid.)
const { IMAGE_URI } = require('./ids');
// The most an image may be, read as it arrives: Tana takes uploads of up to 50 MB (UPLOAD_LIMIT below), so a picture
// past this is no picture of Tana's, and a collaborator's huge one cannot fill memory before anything looks at it.
const IMAGE_LIMIT = 64 * 1024 * 1024;

async function fetchImage(uri, { getAccessToken, baseUrl = 'https://home.tana.inc/api/general', fetch = globalThis.fetch, maxBytes = IMAGE_LIMIT }) {
  if (!IMAGE_URI.test(uri)) throw new Error('not a tana:image uri: ' + uri);
  const url = baseUrl + '/images/by-uri/' + encodeURIComponent(uri);
  const locate = async (refresh) => fetch(url, { headers: { authorization: 'Bearer ' + await getAccessToken({ refresh }) }, redirect: 'manual' });
  let r = await locate(false);
  if (r.status === 401) r = await locate(true);
  if (r.status !== 302) throw new Error('image ' + uri + ': HTTP ' + r.status);
  const cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const res = await fetch(r.headers.get('location'), { headers: cookie ? { cookie } : {} });
  if (!res.ok) throw new Error('image ' + uri + ': CDN HTTP ' + res.status);
  const tooBig = () => new Error('image ' + uri + ': larger than ' + Math.round(maxBytes / 1048576) + ' MB');
  if (Number(res.headers.get('content-length')) > maxBytes) { await res.body?.cancel().catch(() => {}); throw tooBig(); }
  const parts = []; let size = 0;
  for await (const chunk of res.body) { // leaving the loop early cancels the rest of the download
    size += chunk.length;
    if (size > maxBytes) throw tooBig();
    parts.push(chunk);
  }
  return { mime: res.headers.get('content-type') || 'application/octet-stream', bytes: Buffer.concat(parts) };
}

// Upload, the way the web client's uploadFile does it (CNt/uK): POST <POLARIS_SERVICE_API_URL>/files/upload with the
// bytes as multipart field `file` and the bearer token, answered with { cid, size, width?, height?, blurhash? }. The
// client refuses anything over 50 MB before sending (LK) and says the same on a 413 (IK).
const UPLOAD_LIMIT = 52428800;
const TOO_LARGE = 'File is too large (max 50 MB)';
const SIGNED_OUT = "You're signed out — sign in and try again"; // Tana's own wording for a refused token

async function uploadFile(bytes, { filename = 'file', mimeType = 'application/octet-stream', getAccessToken, baseUrl = 'https://home.tana.inc/api/general', fetch = globalThis.fetch, signal }) {
  if (bytes.length > UPLOAD_LIMIT) throw new Error(TOO_LARGE);
  const post = async (refresh) => {
    const body = new FormData();
    body.append('file', new Blob([bytes], { type: mimeType }), filename);
    return fetch(baseUrl + '/files/upload', { method: 'POST', body, signal, headers: { authorization: 'Bearer ' + await getAccessToken({ refresh }) } });
  };
  let r = await post(false);
  if (r.status === 401) r = await post(true);
  if (r.status === 401) throw new Error(SIGNED_OUT);
  if (r.status === 413) throw new Error(TOO_LARGE);
  if (!r.ok) {
    const t = await r.text(), j = (() => { try { return JSON.parse(t); } catch { return null; } })();
    throw new Error('upload ' + filename + ': ' + (j?.message || j?.error || 'HTTP ' + r.status));
  }
  return r.json();
}

// The data map of a new tana:image: document as LoroImage.create writes it: repo.create('image') seeds nothing, then
// type, createdAt and ownerUri, and only the fields it has. ownerUri is required — Tana refuses to mint an ownerless
// (org-visible) image — and is the document the image is pasted into, which is also createdInUri. Run inside
// Document.transact, or as the init of sync.subscribe.
function initImage(loro, { ownerUri, cid, width, height, blurhash, filename, mimeType, fileSize, now = Date.now() }) {
  if (typeof ownerUri !== 'string' || !ownerUri.startsWith('tana:')) throw new Error('an image needs the document it belongs to');
  const data = loro.getMap('data');
  data.set('type', 'image');
  data.set('createdAt', now);
  data.set('ownerUri', ownerUri);
  if (width && height) { data.set('width', width); data.set('height', height); }
  for (const [k, v] of Object.entries({ cid, filename, mimeType, blurhash })) if (v) data.set(k, v);
  if (fileSize !== undefined) data.set('fileSize', fileSize);
  data.set('createdInUri', ownerUri);
}

module.exports = { fetchImage, uploadFile, initImage, UPLOAD_LIMIT, IMAGE_LIMIT, SIGNED_OUT };
