'use strict';
// Image bytes for a tana:image: uri, the way the web client's Ok()/Dk() helpers do it: GET
// <POLARIS_SERVICE_API_URL>/images/by-uri/<uri>[?w=&h=&format=&quality=&fit=] with the bearer token answers 302 to a
// signed imgproxy URL on images.tana.inc plus a Cloud-CDN-Cookie; the signed URL is 403 without that cookie.
// (/images/<cid> and /files/<cid>/download exist too; by-uri saves reading the image document for its cid.)
const IMAGE_URI = /^tana:image:[0-9a-z]{26}$/;

async function fetchImage(uri, { getAccessToken, baseUrl = 'https://home.tana.inc/api/general', fetch = globalThis.fetch }) {
  if (!IMAGE_URI.test(uri)) throw new Error('not a tana:image uri: ' + uri);
  const url = baseUrl + '/images/by-uri/' + encodeURIComponent(uri);
  const locate = async (refresh) => fetch(url, { headers: { authorization: 'Bearer ' + await getAccessToken({ refresh }) }, redirect: 'manual' });
  let r = await locate(false);
  if (r.status === 401) r = await locate(true);
  if (r.status !== 302) throw new Error('image ' + uri + ': HTTP ' + r.status);
  const cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const res = await fetch(r.headers.get('location'), { headers: cookie ? { cookie } : {} });
  if (!res.ok) throw new Error('image ' + uri + ': CDN HTTP ' + res.status);
  return { mime: res.headers.get('content-type') || 'application/octet-stream', bytes: Buffer.from(await res.arrayBuffer()) };
}

module.exports = { fetchImage, IMAGE_URI };
