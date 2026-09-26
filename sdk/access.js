'use strict';
const { LoroMap } = require('loro-crdt');
const { createHash } = require('node:crypto');
const { readNode } = require('./node');
const USER = /^tana:user-profile:[0-9a-z]{26}$/;
const SPACE = /^tana:space:[0-9a-z]{26}$/;
// 'search' is a document kind like text or chat (Tana's own client groups it there): a saved search is owned,
// renamed and deleted through the same ACL, so leaving it out made every search report unknown write permission.
const KINDS = new Set(['text', 'event', 'space', 'chat', 'canvas', 'agent', 'skill', 'type', 'artifact', 'image', 'video', 'audio', 'workflow', 'search']);
const ORGANIZED = new Set(['agent', 'skill', 'type', 'space']);
// What Tana's own client offers soft delete for (useSoftDelete's kind set, read 2026-09-22); a type is archived
// instead, and images, audio, video and workflows are not deleted on their own.
const DELETABLE = new Set(['text', 'canvas', 'skill', 'chat', 'event', 'space', 'artifact', 'agent', 'search', 'widget-source', 'widget']);
// What Tana's own client offers archive for (TypeRoute's archive set, read 2026-09-23): types only, with no other
// client-side gate; the server decides the rest, so this asks the same write access delete does.
const ARCHIVABLE = new Set(['type']);
const LINK_SHAREABLE = new Set(['text', 'artifact']);
const WRITERS = new Set(['admin', 'editor', 'attendee']);
// The Library is Tana's name for a document with no owner, so it is a move target without a document of its own.
const LIBRARY = { id: null, title: 'Library' };
const isLibrary = target => !target || target.id === null;
const supported = n => KINDS.has(n.type) && n.id?.split(':')[1] === n.type && !(n.deletedAt > 0);
const version = doc => Buffer.from(doc.loro.oplogVersion().encode()).toString('hex');
function observe(ctx, doc) { if (ctx.observed && !ctx.observed.has(doc)) ctx.observed.set(doc, version(doc)); return readNode(doc); }
const load = async (ctx, id) => observe(ctx, await ctx.sync.subscribe(id));
const stable = ctx => [...ctx.observed].every(([doc, before]) => version(doc) === before);

// Native participant grants + inherited owner boundary; ownership itself is never a grant.
async function canWrite(n, user, ctx = {}, seen = new Set()) {
  if (!USER.test(user) || n.deletedAt > 0 || seen.has(n.id)) return false;
  seen.add(n.id);
  const p = n.participants?.[user];
  if (p?.type === 'user' && WRITERS.has(p.role)) return true;
  if (p || n.restricted === true) return false;
  try {
    if (n.ownerUri) return canWrite(await load(ctx, n.ownerUri), user, ctx, seen);
    const org = await load(ctx, ctx.orgDocUri);
    return Object.values(org.memberUserProfileDocUris || {}).includes(user);
  } catch { return false; }
}

// Snapshot of authenticated audience, separate from public link sharing. Includes grants along the chain.
async function audienceOf(n, user, ctx = {}) {
  const grants = {}, seen = new Set();
  try {
    for (;;) {
      if (seen.has(n.id) || n.deletedAt > 0) return { scope: 'unknown' };
      seen.add(n.id);
      Object.assign(grants, n.participants || {});
      if (n.restricted === true) {
        if (Object.entries(grants).some(([uri, p]) => !USER.test(uri) || p.type !== 'user')) return { scope: 'unknown' };
        const participants = Object.keys(grants).sort();
        if (!participants.length) return { scope: 'unknown' };
        return { scope: participants.length === 1 && participants[0] === user ? 'only-me' : n.type === 'space' ? 'space' : 'people', boundaryUri: n.id, title: n.title || '', participants };
      }
      if (!n.ownerUri) {
        const org = await load(ctx, ctx.orgDocUri);
        if (!Object.values(org.memberUserProfileDocUris || {}).includes(user)) return { scope: 'unknown' };
        return { scope: 'everyone', boundaryUri: org.id, title: org.name || org.title || '', participants: Object.keys(grants).sort() };
      }
      n = await load(ctx, n.ownerUri);
    }
  } catch { return { scope: 'unknown' }; }
}
async function orgWideAllowed(n, user, ctx) {
  if (!ORGANIZED.has(n.type) || n.ownerUri || n.restricted !== true || ctx.orgAdmin === true) return true;
  try {
    const org = await ctx.sync.subscribe(ctx.orgDocUri);
    observe(ctx, org);
    // Native organization root featurePolicy, defaultEnabled:true.
    return org.loro.toJSON().featurePolicy?.memberOrgWideCreation !== false;
  } catch { return false; }
}
async function orgLinkSharingAllowed(ctx) {
  try {
    const org = await ctx.sync.subscribe(ctx.orgDocUri);
    observe(ctx, org);
    return readNode(org).type === 'org' && org.loro.toJSON().featurePolicy?.linkSharing !== false;
  } catch { return false; }
}
function eventSharing(n, user) {
  // Native wYe: calendar-connected events require organizer (admin/editor), except
  // imported events with no organizer. Unrestricted events without a viewer role are open.
  if (n.type !== 'event' || !(n.externalId || n.calendarSubscriptionUri)) return true;
  const role = n.participants?.[user]?.role;
  const organizers = Object.values(n.participants || {}).some(p => ['admin', 'editor'].includes(p.role));
  return n.importedFrom !== undefined && !organizers || (role === undefined ? n.restricted !== true : ['admin', 'editor'].includes(role));
}
async function canDelete(doc, user, ctx = {}, restoring = false) {
  const n = readNode(doc);
  if (restoring) delete n.deletedAt; // permission check only; never modify the CRDT
  return DELETABLE.has(n.type) && supported(n) && await canWrite(n, user, ctx) && eventSharing(n, user);
}
async function canArchive(doc, user, ctx = {}) {
  const n = readNode(doc);
  return ARCHIVABLE.has(n.type) && supported(n) && await canWrite(n, user, ctx);
}
// Changing a meeting's time, place or people: Tana's Dk gate (every event edit in its web client goes through it) is
// "not restricted, or I am an organizer (admin/editor)", on top of being allowed to write it at all. Its updateEvent
// tool (Rwt) adds the calendar rule: a synced event whose calendar in Tana is not the organizer's (origin 'provider'
// without ownerIsOrganizer) cannot take the change back, so the two copies would diverge.
async function canEditEvent(doc, user, ctx = {}) {
  const n = readNode(doc);
  if (n.externalId && n.origin !== 'tana' && n.ownerIsOrganizer !== true) return false;
  return n.type === 'event' && supported(n) && (n.restricted !== true || ['admin', 'editor'].includes(n.participants?.[user]?.role)) && await canWrite(n, user, ctx);
}
async function capabilities(doc, user, ctx = {}) {
  const n = readNode(doc), write = supported(n) && await canWrite(n, user, ctx);
  const sharing = write && eventSharing(n, user);
  const linkSharing = write && LINK_SHAREABLE.has(n.type) && await orgLinkSharingAllowed(ctx);
  const inheritAudience = await audienceOf({ ...n, restricted: undefined }, user, ctx);
  const inherit = sharing && inheritAudience.scope !== 'unknown' && await orgWideAllowed(n, user, ctx);
  const currentAudience = await audienceOf(n, user, ctx);
  const sharingToken = createHash('sha256').update(JSON.stringify({ id: n.id, owner: n.ownerUri, participants: n.participants, restricted: n.restricted, currentAudience, inheritAudience, inherit })).digest('hex');
  return { sharing, linkSharing, move: write, deletable: write && DELETABLE.has(n.type) && eventSharing(n, user), archivable: write && ARCHIVABLE.has(n.type), ownerUri: n.ownerUri || null, sharingToken,
    rules: sharing ? ['me', 'people', ...(inherit ? ['inherit'] : [])] : [], roles: ['editor', 'admin', ...(n.type === 'event' ? ['attendee'] : [])],
    audience: currentAudience, inheritAudience,
    reason: write ? sharing ? null : 'Only the event organizer can change access' : 'Write permission is unknown or unavailable' };
}
async function setLinkSharing(doc, user, enabled, ctx = {}) {
  if (typeof enabled !== 'boolean') throw new Error('Select whether to enable public link sharing');
  ctx = { ...ctx, observed: new Map() }; observe(ctx, doc);
  const options = await capabilities(doc, user, ctx);
  if (!options.linkSharing) throw new Error('Public link sharing is unavailable');
  if (!stable(ctx)) throw new Error('Access changed while checking; reload link-sharing options');
  doc.transact(loro => {
    const linkSharing = loro.getMap('linkSharing');
    if (enabled) {
      linkSharing.set('mode', 'view');
      loro.getMap('data').set('hasBeenPublic', true);
    } else linkSharing.delete('mode');
  });
}
async function setSharing(doc, user, selection, ctx = {}) {
  ctx = { ...ctx, observed: new Map() }; observe(ctx, doc);
  const options = await capabilities(doc, user, ctx);
  if (!options.sharing) throw new Error(options.reason);
  if (!selection || !options.rules.includes(selection.rule)) throw new Error('Select an available audience rule');
  if (selection.rule === 'inherit' && selection.token !== options.sharingToken) throw new Error('Reload the audience disclosure and explicitly select inherit');
  const people = selection.participants, n = readNode(doc);
  if (selection.rule === 'people' && (!Array.isArray(people) || !people.length || people.some(p => !p || !USER.test(p.uri) || !(options.roles.includes(p.role) || p.role === 'viewer' && n.participants?.[p.uri]?.role === 'viewer')) || new Set(people.map(p => p.uri)).size !== people.length)) throw new Error('Select unique user profiles with supported roles');
  if (selection.rule !== 'people' && people !== undefined) throw new Error('Participants only apply to people selection');
  const selected = new Map((people || []).map(p => [p.uri, p.role]));
  selected.set(user, selection.rule === 'me' ? 'admin' : n.participants?.[user]?.role || 'admin');
  // Native _Se keeps at least one event organizer (admin/editor) when changing participants.
  if (selection.rule !== 'inherit' && n.type === 'event' && Object.values(n.participants || {}).some(p => ['admin', 'editor'].includes(p.role)) && ![...selected.values()].some(role => ['admin', 'editor'].includes(role))) throw new Error('An event must keep at least one organizer (admin or editor)');
  if (!stable(ctx)) throw new Error('Access changed while checking; reload sharing options');
  doc.transact(loro => {
    const data = loro.getMap('data');
    if (selection.rule === 'inherit') { data.delete('restricted'); return; }
    data.set('restricted', true);
    const map = data.get('participants') || data.setContainer('participants', new LoroMap());
    for (const key of map.keys()) if (!selected.has(key)) map.delete(key);
    for (const [uri, role] of selected) {
      let entry = map.get(uri);
      // Native addParticipant(uri, grant, actor) stamps who invited somebody else; your own entry never carries it.
      if (!entry) { entry = map.setContainer(uri, new LoroMap()); if (uri !== user) entry.set('changedBy', user); }
      entry.set('type', 'user'); entry.set('role', role);
    }
  });
}
async function previewMove(doc, target, user, ctx = {}) {
  ctx = { ...ctx, observed: new Map() };
  const library = isLibrary(target);
  const n = observe(ctx, doc), destination = library ? LIBRARY : observe(ctx, target);
  const targetId = library ? null : target.id;
  let reason = null;
  if (!supported(n) || !await canWrite(n, user, ctx)) reason = 'Source write permission is unknown or unavailable';
  else if (!library && (!SPACE.test(target.id) || destination.type !== 'space' || !await canWrite(destination, user, ctx))) reason = 'Target space write permission is unknown or unavailable';
  const scope = [];
  try {
    // Guard parent cycles even when moving spaces under spaces.
    let parent = destination; const seen = new Set();
    for (;!library;) {
      if (parent.id === n.id || seen.has(parent.id)) { reason = 'A node cannot move into itself or its descendants'; break; }
      seen.add(parent.id); scope.push([parent.id, parent.ownerUri || null]);
      if (!parent.ownerUri) break;
      parent = await load(ctx, parent.ownerUri);
    }
    if (n.entityTypeUri) {
      const type = await load(ctx, n.entityTypeUri); scope.push([type.id, type.ownerUri || null]);
      if (type.type !== 'type' || type.deletedAt > 0) reason = 'Type scope is unavailable';
      else if (type.ownerUri && type.ownerUri !== targetId) reason = 'The node must remain in its type’s home space';
    }
    // A type owns its instances' scope, so counting them needs a space to count in; the Library has no owner id to query.
    if (n.type === 'type' && library) reason = 'Move a type to a space, not the Library';
    else if (n.type === 'type' && n.ownerUri !== targetId) {
      // Count both sets rather than truncate instances at an arbitrary list limit.
      const params = { entityTypes: [n.id], limit: 1, mode: 'LIST_NODES_MODE_WITH_COUNT' };
      const [all, atTarget] = await Promise.all([ctx.graph.listNodes(params), ctx.graph.listNodes({ ...params, ownerIds: [targetId] })]);
      const counts = [all.totalCount, atTarget.totalCount];
      if (counts.some(count => !Number.isSafeInteger(count) || count < 0)) reason = 'Cannot verify all existing type instances';
      else if (counts[0] !== counts[1]) reason = 'Move existing type instances to the target space first';
      scope.push(counts);
    }
  } catch { reason = 'Ownership or type scope is unavailable'; }
  const before = await audienceOf(n, user, ctx), after = await audienceOf({ ...n, ownerUri: targetId }, user, ctx);
  const audienceChanged = JSON.stringify(before) !== JSON.stringify(after);
  if (before.scope === 'unknown' || after.scope === 'unknown') reason ||= 'Cannot verify the move’s audience';
  if (!stable(ctx)) reason = 'Access changed while checking; preview again';
  const evidence = [...ctx.observed.keys()].map(d => { const r = readNode(d); return { id: r.id, ownerUri: r.ownerUri, restricted: r.restricted, participants: r.participants, entityTypeUri: r.entityTypeUri, deletedAt: r.deletedAt };}).sort((a, b) => a.id.localeCompare(b.id));
  const token = createHash('sha256').update(JSON.stringify({ id: n.id, owner: n.ownerUri, target: targetId, before, after, scope, evidence })).digest('hex');
  return { allowed: !reason, reason, target: { id: targetId, title: destination.title || '' }, before, after, audienceChanged, requiresConfirmation: audienceChanged, token };
}
async function moveToSpace(doc, target, user, ctx = {}, confirmation) {
  const preview = await previewMove(doc, target, user, ctx);
  if (!preview.allowed) throw new Error(preview.reason);
  if ((preview.requiresConfirmation || confirmation !== undefined) && confirmation !== preview.token) throw new Error('Preview the move again and explicitly confirm its audience');
  // out of every space: an unowned document is what Tana shows as the Library, so the key goes away rather than turning null
  doc.transact(loro => isLibrary(target) ? loro.getMap('data').delete('ownerUri'): loro.getMap('data').set('ownerUri', target.id));
  return preview;
}
// The graph nodes everyone in the org can see (#253): not restricted themselves, and nothing restricted above them.
// The org root is restricted to its members, so reaching it is everyone, as in node.js audienceMetadata; an owner
// this user cannot open is someone else's boundary. ListNodes' own `restricted: false` reads only the node's flag, which
// is Tana's "Open" (everyone in the org *or space*), so this asks one owner chain per distinct owner instead of per row.
async function everyoneOnly(graph, nodes) {
  const chains = new Map();
  const open = (uri) => {
    if (!uri) return true; // the Library: an unowned document inherits the org
    if (!chains.has(uri)) chains.set(uri, graph.getOwnerChain(uri).then(({ entries = [] }) =>
      !entries.some((e) => e.accessible === false || (e.restricted === true && !e.uri.startsWith('tana:org:'))), () => false));
    return chains.get(uri);
  };
  const keep = await Promise.all(nodes.map((n) => n.restricted !== true && open(n.ownerUri)));
  return nodes.filter((_, i) => keep[i]);
}

module.exports = { capabilities, setSharing, setLinkSharing, moveToSpace, previewMove, canWrite, canDelete, canArchive, canEditEvent, audienceOf, everyoneOnly, LIBRARY };
