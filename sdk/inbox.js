'use strict';
// The notifications inbox (issue #18): one `tana:user-inbox:<user-profile ULID>` document per user — what Tana's Work
// board lists as Notifications. Everything here follows Tana's own wrapper (shared bundle of 2026-09-22: the Ah
// document class, its VSe mutations, the npe schema, and gy() for the uri):
//
//   data          { type: 'user-inbox', updatedAt }
//   notifications { [id]: { id, notificationType, sourceUri, createdAt, actorUri?, title?, body?, readAt?, threadUri? } }
//
// Each notification is a LoroMap under the root map "notifications". A write sets or deletes one item's readAt and
// bumps data.updatedAt, and only when something changed — exactly what Tana's markAsRead and friends do. Tana creates
// the inbox the first time its client finds none; this never does, so a user without one simply has no notifications.
// Live: subscribe the document and listen for its 'change' events; every write lands there, from anywhere.
const { LoroMap } = require('loro-crdt');

// gy(): Ui('user-inbox', <the user-profile's ULID>)
const inboxUri = (userUri) => 'tana:user-inbox:' + String(userUri).split(':').pop();
const open = (sync, userUri) => sync.subscribe(inboxUri(userUri));

const maps = (doc) => {
  const root = doc.loro.getMap('notifications');
  return root.keys().map((id) => root.get(id)).filter((item) => item instanceof LoroMap);
};
// Newest first, the order Tana's list shows (its items getter sorts oldest first and the list reverses it).
const items = (doc) => maps(doc).map((item) => item.toJSON()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
const unreadCount = (doc) => maps(doc).filter((item) => !item.get('readAt')).length;

// One transaction per write, and data.updatedAt only when an item moved; returns whether one did.
function write(doc, fn) {
  let changed = false;
  doc.transact((loro) => {
    const at = Date.now();
    changed = fn(at);
    if (changed) loro.getMap('data').set('updatedAt', at);
  });
  return changed;
}
const one = (doc, id) => { const item = doc.loro.getMap('notifications').get(id); return item instanceof LoroMap ? item : null; };
const read = (item, at) => { if (!item || item.get('readAt')) return false; item.set('readAt', at); return true; };
const markAsRead = (doc, id) => write(doc, (at) => read(one(doc, id), at));
const markAsUnread = (doc, id) => write(doc, () => { const item = one(doc, id); if (!item || !item.get('readAt')) return false; item.delete('readAt'); return true; });
// Every unread notification about one document, the way Tana's meeting page clears its own when it opens.
const markAsReadBySourceUri = (doc, uri) => write(doc, (at) => maps(doc).filter((item) => item.get('sourceUri') === uri).map((item) => read(item, at)).includes(true));
const markAllAsRead = (doc) => write(doc, (at) => maps(doc).map((item) => read(item, at)).includes(true));

// ---- how a notification reads (Tana's Wqt and Gqt) ----
// The sentence, as parts: { text, emphasis?, title? }. actor is the actor's name, if known; title overrides the stored one,
// which is what Tana does for type-archived/unarchived (the type's current title, so a rename shows through).
function phrase(n, actor, title) {
  const em = (text) => ({ text, emphasis: true }), t = (text) => ({ text }), o = title || n.title;
  // title: the notification's own words (a document, meeting or message title), told apart from Tana's fixed sentence
  const ti = (text) => ({ text, emphasis: true, title: true }), own = (text, fallback) => (text ? { text, title: true } : t(fallback));
  switch (n.notificationType) {
    case 'document-access':
    case 'event-access': {
      const what = n.notificationType === 'event-access' ? 'a meeting' : 'a doc';
      return actor ? (o ? [em(actor), t(' added you to '), ti(o)] : [em(actor), t(' added you to ' + what)]) : o ? [t('You were added to '), ti(o)] : [t('You were added to ' + what)];
    }
    case 'task-assignment': return actor ? [em(actor), t(' assigned you to a task')] : [t('You were assigned to a task')];
    case 'comment-mention': return actor ? (o ? [em(actor), t(' mentioned you in '), ti(o)] : [em(actor), t(' mentioned you in a comment')]) : o ? [t('You were mentioned in '), ti(o)] : [t('You were mentioned in a comment')];
    case 'comment-reply': return actor ? (o ? [em(actor), t(' replied in '), ti(o)] : [em(actor), t(' replied to a comment')]) : o ? [t('New reply in '), ti(o)] : [t('New reply to a comment')];
    case 'incoming-call': return actor ? [em(actor), t(' is waiting for you in a meeting')] : [own(o, 'Someone is waiting for you in a meeting')];
    case 'type-archived': return actor ? (o ? [em(actor), t(' archived '), ti(o)] : [em(actor), t(' archived a type')]) : o ? [ti(o), t(' was archived')] : [t('A type was archived')];
    case 'type-unarchived': return actor ? (o ? [em(actor), t(' unarchived '), ti(o)] : [em(actor), t(' unarchived a type')]) : o ? [ti(o), t(' was unarchived')] : [t('A type was unarchived')];
    default: return actor ? [em(actor), t(' sent you a message')] : [own(o, 'New message')]; // chat-message, ai-usage-warning and anything newer
  }
}
// The line Tana writes after it (as ". <detail>."): markdown flattened, trailing punctuation dropped; '' for none.
const retitled = (type) => type === 'type-archived' || type === 'type-unarchived';
function detail(n) {
  if (n.notificationType === 'incoming-call' || retitled(n.notificationType)) return '';
  const raw = n.notificationType === 'task-assignment' ? n.title || n.body : n.body;
  if (!raw) return '';
  return String(raw).replace(/^#{1,6}\s+/gm, '').replace(/!?\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/^\s*[-*+]\s+/gm, '').replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/_(.+?)_/g, '$1').replace(/`(.+?)`/g, '$1')
    .replace(/~~(.+?)~~/g, '$1').replace(/\+\+(?=\S)(.+?)(?<=\S)\+\+/g, '$1').replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '');
}

module.exports = { inboxUri, open, items, unreadCount, markAsRead, markAsUnread, markAsReadBySourceUri, markAllAsRead, phrase, detail, retitled };
