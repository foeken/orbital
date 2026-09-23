'use strict';
// Proposals (issue #19; main/proposals.js): what Tana's AI proposed from a chat and is waiting on someone to accept,
// as a page of the proposed documents themselves, newest first. A row is the document as a view draws it, read-only
// here (Space opens it, its chevron shows what it holds), with a grey line saying where it was proposed and two
// buttons at its end: approve and reject. Cmd+K carries the same two for the rows you are on, and Proposals sits among
// the Views with how many are waiting. Orbital approves a proposed new document; a proposed change to an existing one
// is Tana's to merge, so its row offers reject only and says so.
const PROPOSALS_PAGE = 'orbital:proposals';
// appPage: no Tana location, no pins, nothing to delete — the rows that read those facts leave it out
extra.set(PROPOSALS_PAGE, { id: PROPOSALS_PAGE, text: 'Proposals', title: 'Proposals', kind: 'document', icon: 'proposals', editable: false, hasChildren: true, appPage: true });

const proposalCount = () => (kids.get(PROPOSALS_PAGE) || []).length;

// The page's sections (issue #104), in this order, each only when it has rows: proposals from meetings you were in,
// from meetings you see through a space you are in, and from chats that belong to no meeting. main files each row
// (proposal.group). Folding one is remembered like a view's sections, under this page's own key, so it does not
// depend on which view is behind the page.
const PROPOSAL_GROUPS = ['From meetings', 'From spaces', 'From chats'];
const proposalFoldKey = (id) => PROPOSALS_PAGE + '\n' + id;
function proposalGroups(list) {
  return PROPOSAL_GROUPS.map((title) => ({ id: title, title, nodes: list.filter((n) => n.proposal && n.proposal.group === title) }))
    .filter((g) => g.nodes.length)
    .map((g) => ({ ...g, collapsed: collapsedGroups.has(proposalFoldKey(g.id)), toggle: () => toggleProposalGroup(g.id) }));
}
function toggleProposalGroup(id) {
  if (!collapsedGroups.delete(proposalFoldKey(id))) collapsedGroups.add(proposalFoldKey(id));
  setPref('collapsedGroups', [...collapsedGroups]);
  render(true);
}
// Read once the connection is up, so Cmd+K can say how many are waiting before the page is opened, and again every time
// the page is arrived at (renderer/edit.js noteNavigation): Tana is where proposals come from, and nothing pushes them.
let proposalsConnected = false;
if (tana.proposalAnswer && tana.onStatus) tana.onStatus((s) => {
  const up = !!(s && s.connected);
  if (up && !proposalsConnected) reload(PROPOSALS_PAGE).then(() => renderSoon(true), () => {});
  proposalsConnected = up;
});

// Drawn at once: the row leaves the page, and comes back with the reason if Tana or Orbital refuses.
function answerProposal(node, approve) {
  const p = node.proposal;
  if (!p || !tana.proposalAnswer || (approve && !p.approvable)) return;
  kids.set(PROPOSALS_PAGE, (kids.get(PROPOSALS_PAGE) || []).filter((n) => n !== node));
  renderSoon(true);
  run(async () => {
    try {
      const warnings = await tana.proposalAnswer(p.chatUri, p.proposedUri, approve);
      if (warnings && warnings.length) showError(new Error(warnings.join('; ')));
    } catch (e) {
      await reload(PROPOSALS_PAGE).catch(() => {});
      renderSoon(true);
      throw e;
    }
  });
}

// The two buttons at the end of a proposal row. A proposal Orbital cannot approve keeps the button, disabled, with main's
// reason on it, so the row still says what it is waiting for.
function proposalButtonsEl(node) {
  const el = document.createElement('span');
  el.className = 'pbuttons';
  for (const [approve, icon, label] of [[true, 'approve', 'Approve'], [false, 'reject', 'Reject']]) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'pbutton ' + icon; b.tabIndex = -1;
    b.disabled = approve && !node.proposal.approvable;
    b.title = b.disabled ? node.proposal.reason || 'Approve it in Tana' : label;
    b.setAttribute('aria-label', label);
    b.onmousedown = (e) => e.preventDefault(); // the caret stays where it is, as every other row control does
    b.onclick = (e) => { e.stopPropagation(); answerProposal(node, approve); };
    const svg = iconNode(icon);
    if (svg) b.append(svg);
    el.append(b);
  }
  return el;
}

// Cmd+K: the place, among the Views, with how many are waiting there
function proposalsViewRow() {
  const n = proposalCount();
  return { id: 'proposals', group: 'Views', icon: 'proposals', label: 'Proposals', hint: n ? n + ' pending' : '', run: () => goTo(PROPOSALS_PAGE) };
}
// Cmd+K: the proposals selected, or the one the caret is on. Approve stays listed, disabled, when none of them can be
// approved here, so its key still has a row to be recorded against.
function proposalRows() {
  const selected = selKeys(), at = palReturn || focused(), keys = selected.length ? selected : at ? [at.key] : [];
  const nodes = keys.map((key) => items.get(key)?.node).filter((n) => n && n.proposal);
  if (!nodes.length || !tana.proposalAnswer) return [];
  const group = selected.length ? 'Selection' : 'Current node', approvable = nodes.filter((n) => n.proposal.approvable);
  return [
    { id: 'approveProposal', group, icon: 'approve', label: 'Approve proposal', hint: approvable.length ? '' : 'In Tana', disabled: !approvable.length, run: () => approvable.forEach((n) => answerProposal(n, true)) },
    { id: 'rejectProposal', group, icon: 'reject', label: 'Reject proposal', run: () => nodes.forEach((n) => answerProposal(n, false)) },
  ];
}
