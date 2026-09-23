'use strict';
// The Notifications page (issue #18) over sdk/inbox.js: the user's tana:user-inbox document as read-only outline rows,
// its unread count, and the three writes Tana's own list makes (one read or unread, all read). The page is not a Tana
// document, so it has an id of its own that no Tana id can collide with; main.js answers outline:children for it here.
// Live: the inbox is subscribed once per connection, and every change to it — a new notification, a read on another
// device — reaches the renderer as inbox:changed with the new unread count (main/documents.js onChange leaves it alone).
const inbox = require('../sdk/inbox');
const { NOT_CONNECTED, S, iso, send, typeTitles } = require('./state');
const { members, resolveTypes } = require('./rows');

const PAGE = 'orbital:notifications';
const watched = new WeakSet();
async function doc() {
  if (!S.client || !S.me) throw new Error(NOT_CONNECTED);
  const client = S.client, uri = inbox.inboxUri(S.me.userUri);
  if (!watched.has(client)) {
    watched.add(client);
    client.sync.on('change', (id) => { if (id === uri) send('inbox:changed', inbox.unreadCount(client.sync.getDocument(id))); });
  }
  return inbox.open(client.sync, S.me.userUri);
}
const unread = async () => (S.client ? inbox.unreadCount(await doc()) : 0);

// One row per notification, newest first: Tana's sentence with its emphasis as bold, the detail after it, and what the
// renderer needs to open it (notification) and to mark it (unread). The actor is named from the member list; a type
// that was archived or restored is named by its current title, as Tana does, so a rename since shows through.
async function rows() {
  const list = inbox.items(await doc());
  const names = new Map((await members().catch(() => [])).map((m) => [m.id, m.title]));
  const types = list.filter((n) => inbox.retitled(n.notificationType) && n.sourceUri).map((n) => n.sourceUri);
  await resolveTypes(types).catch(() => {}); // unreadable: the title the notification was written with stays
  return list.map((n) => {
    const words = inbox.phrase(n, names.get(n.actorUri), inbox.retitled(n.notificationType) ? typeTitles.get(n.sourceUri) : undefined);
    const more = inbox.detail(n);
    const segments = [...words.map((p) => (p.emphasis ? { text: p.text, marks: { bold: true } } : { text: p.text })), ...(more ? [{ text: '. ' + more + '.' }] : [])];
    return {
      id: n.id, text: segments.map((s) => s.text).join(''), kind: 'block', block: 'bullet', editable: false, segments, hasChildren: false, children: [],
      unread: !n.readAt, createdAt: iso(n.createdAt),
      notification: { type: n.notificationType, sourceUri: n.sourceUri || null, threadUri: n.threadUri || null },
    };
  });
}
// A write answers with the unread count after it, which is also what the live change will say a moment later.
async function setRead(id, read) { const d = await doc(); (read ? inbox.markAsRead : inbox.markAsUnread)(d, id); return inbox.unreadCount(d); }
async function markAll() { const d = await doc(); inbox.markAllAsRead(d); return inbox.unreadCount(d); }

module.exports = { PAGE, rows, unread, setRead, markAll };
