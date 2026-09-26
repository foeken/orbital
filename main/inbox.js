'use strict';
// The Notifications page (issue #18) over sdk/inbox.js: the user's tana:user-inbox document as read-only outline rows,
// its unread count, and the three writes Tana's own list makes (one read or unread, all read). The page is not a Tana
// document, so it has an id of its own that no Tana id can collide with; main.js answers outline:children for it here.
// Live: the inbox is subscribed once per connection, and every change to it — a new notification, a read on another
// device — reaches the renderer as inbox:changed with the new unread count (main/documents.js onChange leaves it alone).
// A comment reminder that comes due changes nothing in the document, so a timer tells the renderer then; it looks at
// least once a minute, as Tana's reminder-tick does, which also covers a Mac that slept through the moment.
const inbox = require('../sdk/inbox');
const { NOT_CONNECTED, S, iso, send, typeTitles } = require('./state');
const { members, resolveTypes } = require('./rows');

const PAGE = 'orbital:notifications';
const watched = new WeakSet();
let timer;
function wake(d) {
  clearTimeout(timer);
  const at = inbox.nextDue(d);
  if (at !== Infinity) timer = setTimeout(() => (at <= Date.now() ? tell(d) : wake(d)), Math.min(at - Date.now(), 60000));
}
function tell(d) { send('inbox:changed', inbox.unreadCount(d)); wake(d); }
async function doc() {
  if (!S.client || !S.me) throw new Error(NOT_CONNECTED);
  const client = S.client, uri = inbox.inboxUri(S.me.userUri);
  if (!watched.has(client)) {
    watched.add(client);
    client.sync.on('change', (id) => { if (id === uri) tell(client.sync.getDocument(id)); });
  }
  const d = await inbox.open(client.sync, S.me.userUri);
  wake(d);
  return d;
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
    // For demo mode (renderer/segments.js): Tana's fixed sentence is kept, the actor is a name, and the notification's
    // own title is masked like any content — except a type's, which is the workspace's vocabulary like a type chip.
    const typeTitle = inbox.retitled(n.notificationType);
    const demo = (p) => (p.title ? (typeTitle ? { keep: true } : {}) : p.emphasis ? { person: true } : { keep: true });
    const segments = [...words.map((p) => ({ text: p.text, ...(p.emphasis ? { marks: { bold: true } } : {}), ...demo(p) })), ...(more ? [{ text: '. ' + more + '.' }] : [])];
    return {
      id: n.id, text: segments.map((s) => s.text).join(''), kind: 'block', block: 'bullet', editable: false, segments, hasChildren: false, children: [],
      unread: !n.readAt, createdAt: iso(inbox.when(n)), // a reminder at the moment it came due
      notification: { type: n.notificationType, sourceUri: n.sourceUri || null, threadUri: n.threadUri || null },
    };
  });
}
// A write answers with the unread count after it, which is also what the live change will say a moment later.
async function setRead(id, read) { const d = await doc(); (read ? inbox.markAsRead : inbox.markAsUnread)(d, id); return inbox.unreadCount(d); }
async function markAll() { const d = await doc(); inbox.markAllAsRead(d); return inbox.unreadCount(d); }

// What the renderer asks this module (preload.js names each channel for the page; main.js registers the table).
const ipc = {
  // the page's rows come through outline:children (main.js); these are its count and writes
  'inbox:unread': () => unread(),
  'inbox:setRead': (_e, id, read) => setRead(id, !!read),
  'inbox:markAll': () => markAll(),
};

module.exports = { PAGE, rows, unread, setRead, markAll, ipc };
