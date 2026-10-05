'use strict';
// Notifications (issue #18; main/inbox.js): Tana's inbox as a page of read-only rows, newest first, each one sentence as
// Tana phrases it with the time beside it. The page is not a Tana document, so it has an id of its own and is known
// here from the start: goTo, Back and a recent entry find it in extra without asking main for a node it does not have.
// A row's bullet is its read state — blue while unread — and the row action: clicking it marks the row read or unread.
// Opening a row (Enter, Space, a click on its words) marks it read and goes to what it is about, which is what a click
// does in Tana. Cmd+K carries the same: Notifications among the Views with the unread count, Mark as read / Mark as
// unread for the rows you are on, and Mark all as read.
const INBOX_PAGE = 'orbital:notifications';
let inboxUnread = 0;
// appPage: no Tana location, no pins, nothing to delete — the rows that read those facts leave it out
extra.set(INBOX_PAGE, { id: INBOX_PAGE, text: 'Notifications', title: 'Notifications', kind: 'document', icon: 'notify', editable: false, hasChildren: true, appPage: true });

function loadNotifications() { if (tana.inboxUnread) tana.inboxUnread().then((n) => { inboxUnread = Number(n) || 0; if (!palette.hidden) renderPalette(); }, () => {}); }
// The count is read when the connection comes up (before it, main has no inbox to read), and once now for a window
// that loads onto a connection that is already there.
let inboxConnected = false;
if (tana.onStatus) tana.onStatus((s) => { const up = !!(s && s.connected); if (up && !inboxConnected) loadNotifications(); inboxConnected = up; });
loadNotifications();
// Every change to the inbox, from here or anywhere else: the count, and the page's rows when they have been read.
if (tana.onInbox) tana.onInbox((n) => {
  inboxUnread = Number(n) || 0;
  if (kids.get(INBOX_PAGE)) reload(INBOX_PAGE).then(() => renderSoon(true), showError);
  if (!palette.hidden) renderPalette();
});
// Drawn at once, written after: the live change that follows re-reads the page and the count.
function setNotificationRead(node, read) {
  if (!tana.inboxSetRead || !node.unread === read) return;
  node.unread = !read;
  inboxUnread = Math.max(0, inboxUnread + (read ? -1 : 1));
  renderSoon(true);
  if (read) popRead([node.id]);
  run(async () => { inboxUnread = await tana.inboxSetRead(node.id, read); });
}
function markAllNotificationsRead() {
  if (!tana.inboxMarkAll) return;
  const read = (kids.get(INBOX_PAGE) || []).filter((n) => n.unread).map((n) => n.id);
  for (const n of kids.get(INBOX_PAGE) || []) n.unread = false;
  inboxUnread = 0;
  renderSoon(true);
  popRead(read); // each dot in turn, down the page — queued after the redraw, so it plays on the rows that redraw draws
  run(async () => { inboxUnread = await tana.inboxMarkAll(); });
}
// Tana marks the one notification read and navigates to its source. A source Orbital has no page for — a type, a
// person — opens in Tana instead, the way "Show in Tana" does. A comment's thread has nowhere to go here, so a
// comment notification opens its document.
function openNotification(node) {
  const uri = node.notification && node.notification.sourceUri;
  if (node.unread) setNotificationRead(node, true);
  if (!uri) return;
  if (zoomable({ id: uri })) goTo(uri);
  else if (tana.nodeLink && tana.openExternal) openInTana(uri);
}
// Cmd+K: the place, among the Views, with how much is waiting there
function notificationsViewRow() {
  return { id: 'notifications', group: 'Views', icon: 'notify', label: 'Notifications', hint: inboxUnread ? inboxUnread + ' unread' : '', run: () => goTo(INBOX_PAGE) };
}
// Cmd+K: the notifications selected, or the one the caret was on when the palette opened (or is on now, for a key
// pressed with the palette closed). Two rows with a fixed meaning each rather than one whose label flips, so either
// can be given a key.
function notificationRows() {
  const selected = selKeys(), at = palReturn || focused(), keys = selected.length ? selected : at && at.key ? [at.key] : [];
  const nodes = keys.map((key) => items.get(key)?.node).filter((n) => n && n.notification);
  if (!nodes.length || !tana.inboxSetRead) return [];
  const group = selected.length ? 'Selection' : 'Current node', unread = nodes.filter((n) => n.unread), read = nodes.filter((n) => !n.unread);
  const rows = [];
  if (unread.length) rows.push({ id: 'markRead', group, icon: 'apply', label: 'Mark as read', run: () => unread.forEach((n) => setNotificationRead(n, true)) });
  if (read.length) rows.push({ id: 'markUnread', group, icon: 'notify', label: 'Mark as unread', run: () => read.forEach((n) => setNotificationRead(n, false)) });
  return rows;
}
const markAllRow = () => ({ id: 'markAllRead', group: 'Actions', icon: 'apply', label: 'Mark all as read', hint: inboxUnread ? inboxUnread + ' unread' : 'Nothing unread', disabled: !inboxUnread, run: markAllNotificationsRead });
