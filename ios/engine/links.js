'use strict';
// What a tap on a segment opens on the phone, the node page every link goes to: a link to a Tana page (its address, as
// Copy link makes it, an orbital: link as Echo writes it, or a bare id) as the node it names (renderer/segments.js
// tanaNodeUri, the desktop's paste rule), so it opens where you are rather than as a link from outside;
// a date, or any tana: target that is no document, plain words, since the phones have no page for it.
const { isId } = require('../../sdk/ids');
const { isDateUri, dateLabel } = require('../../sdk/dates');
const { tanaNodeUri } = require('../../renderer/segments.js');

function openable(s) {
  if (s.mention && !isId(s.mention.uri)) return { text: s.mention.label || (isDateUri(s.mention.uri) ? dateLabel(s.mention.uri) : ''), ...(s.marks ? { marks: s.marks } : {}) };
  const link = s.marks && s.marks.link;
  if (!link) return s;
  const uri = tanaNodeUri(link.replace(/^orbital:/, '')), rest = { ...s.marks };
  delete rest.link;
  if (uri) return { ...s, marks: { ...rest, link: uri } };
  return /^tana:/.test(link) ? { ...s, marks: rest } : s;
}

module.exports = { openable };
