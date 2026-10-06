'use strict';
// Proposals (issue #19; main/proposals.js): what Tana's AI proposed from a chat and is waiting on someone to accept,
// as a page of the proposed documents themselves, newest first. A row is the document as a view draws it, editable as
// the document is (Space opens it, its chevron shows what it holds), with a grey line saying where it was proposed and two
// buttons at its end: approve and reject. Cmd+K carries the same two for the rows you are on, and Proposals sits among
// the Views with how many are waiting. Orbital approves a proposed new document; a proposed change to an existing one
// is Tana's to merge, so its row offers reject only and says so.
const PROPOSALS_PAGE = 'orbital:proposals';
// appPage: no Tana location, no pins, nothing to delete — the rows that read those facts leave it out
extra.set(PROPOSALS_PAGE, { id: PROPOSALS_PAGE, text: 'Proposals', title: 'Proposals', kind: 'document', icon: 'proposals', editable: false, hasChildren: true, appPage: true });

const proposalCount = () => (kids.get(PROPOSALS_PAGE) || []).length;

// The page's two parts (issues #104, #107), each only when it has rows: yours at the top with no heading (meetings you
// were in, your own chats), then From others (meetings and chats you see through a space, other people's chats), a
// section that starts folded. main files each row (proposal.group). Opening it is remembered like a view's sections,
// under this page's own key, so it does not depend on which view is behind the page.
const PROPOSAL_GROUPS = [['mine', ''], ['others', 'From others']];
const PROPOSAL_FOLDED = new Set(['others']);
const proposalFoldKey = (id) => PROPOSALS_PAGE + '\n' + (PROPOSAL_FOLDED.has(id) ? 'open\n' : '') + id;
function proposalGroups(list) {
  return PROPOSAL_GROUPS.map(([id, title]) => ({ id, title, nodes: list.filter((n) => n.proposal && n.proposal.group === id) }))
    .filter((g) => g.nodes.length)
    .map((g) => ({ ...g, collapsed: PROPOSAL_FOLDED.has(g.id) !== collapsedGroups.has(proposalFoldKey(g.id)), toggle: () => toggleProposalGroup(g.id) }));
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
  let failed = false; // a refusal quicker than the exit animation: the reload brings the row back, and it must stay
  // it leaves green for a yes and red for a no, and is taken off the page once it has gone (renderer/motion.js)
  dismissRow(rowFor(node.id), approve ? 'in' : 'out', () => { if (failed) return; kids.set(PROPOSALS_PAGE, (kids.get(PROPOSALS_PAGE) || []).filter((n) => n !== node)); renderSoon(true); });
  run(async () => {
    try {
      const warnings = await tana.proposalAnswer(p.chatUri, p.proposedUri, approve);
      if (warnings && warnings.length) showError(new Error(warnings.join('; ')));
    } catch (e) {
      failed = true;
      await reload(PROPOSALS_PAGE).catch(() => {});
      renderSoon(true);
      throw e;
    }
  });
}

// The two buttons at the end of a proposal row. A proposal Orbital cannot approve keeps the button, disabled, with main's
// reason on it, so the row still says what it is waiting for. answer: what a press does (a chat's card answers in place).
function proposalButtonsEl(node, answer = answerProposal) {
  const el = document.createElement('span');
  el.className = 'pbuttons';
  for (const [approve, kind, label, icon] of [[true, 'approve', 'Approve', 'approve'], [false, 'reject', 'Reject', 'trash']]) { // reject is a plain trash can, as in Tana
    const disabled = approve && !node.proposal.approvable;
    // the caret stays where it is, as every other row control does; a disabled Approve says why in its tooltip
    const b = quietButton('pbutton ' + kind, label, (e) => { e.stopPropagation(); answer(node, approve); }, { tabIndex: -1, title: disabled ? node.proposal.reason || 'Approve it in Tana' : null });
    b.disabled = disabled;
    el.append(addIcon(b, icon));
  }
  // an action's approve runs it, so it says where, as Tana's own button does: "Send to Slite" (or Run)
  const p = node.proposal;
  if (p.action || (p.metadata && p.metadata.type === 'action')) {
    const go = el.querySelector('.pbutton.approve'), label = p.systems && p.systems.length ? 'Send to ' + p.systems.join(' & ') : 'Run';
    go.replaceChildren(label); go.classList.add('send'); go.setAttribute('aria-label', label);
    if (!go.disabled) go.title = label;
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
  const selected = selKeys(), at = palReturn || focused(), keys = selected.length ? selected : at && at.key ? [at.key] : [];
  const nodes = keys.map((key) => items.get(key)?.node).filter((n) => n && n.proposal);
  if (!nodes.length || !tana.proposalAnswer) return [];
  const group = selected.length ? 'Selection' : 'Current node', approvable = nodes.filter((n) => n.proposal.approvable);
  return [
    { id: 'approveProposal', group, icon: 'approve', label: 'Approve proposal', hint: approvable.length ? '' : 'In Tana', disabled: !approvable.length, run: () => approvable.forEach((n) => answerProposal(n, true)) },
    { id: 'rejectProposal', group, icon: 'trash', label: 'Reject proposal', run: () => nodes.forEach((n) => answerProposal(n, false)) },
  ];
}
