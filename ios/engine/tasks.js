'use strict';
// A task's box, its Assigned to and its Visible to on the phone, as the desktop's do them (renderer/edit.js toggleDone,
// main/documents.js doc:setDone, doc:setAssignees, doc:taskMeta, doc:accessOptions, renderer/access.js applySharing),
// over the documents index.js holds. Apart from index.js so scripts/ios-engine-check.js can run them on a document of
// its own: hold gives the document, access the write context (main/documents.js accessContext), members the people.
const { S } = require('../../main/state');
const { STATE_TYPES, audienceMetadata, editable, readNode, setAssignees, setState, taskMeta } = require('../../sdk/node');
const { capabilities, setSharing } = require('../../sdk/access');
const { demoName, demoTitle } = require('./demo');
const { agentOf } = require('./agents');

// A write only queues, and Tana says no later, as a write-denied event (sdk/sync.js): true when it does within 3 s.
// ponytail: 3 s for Tana's refusal; a slower one shows at the first read half a minute on (ios/Common/Ticks.swift settle).
const REFUSED_MS = 3000;
const refusedSoon = (id, ms) => new Promise((resolve) => {
  const on = (denied) => { if (denied === id) done(true); };
  const done = (answer) => { S.client.sync.off('write-denied', on); clearTimeout(timer); resolve(answer); };
  const timer = setTimeout(() => done(false), ms);
  S.client.sync.on('write-denied', on);
});

// patience: how long Tana is given to refuse (the check gives it less)
function createTasks({ hold, access, members, patience = REFUSED_MS }) {
  const denied = (id) => refusedSoon(id, patience);
  // who of the people assigned cannot open the task (sdk/node.js audienceMetadata hiddenFrom), as the desktop asks after Assign to
  const shutOut = async (doc) => (await audienceMetadata(doc, S.me.userUri, S.client.graph, (await access()).sync)).hiddenFrom || [];
  return {
    // An Inbox task is accepted first (In Progress), a finished one is reopened, anything else is completed. Answers the
    // state written; refuses what is not a task or is read-only to you, and waits for Tana's refusal a few seconds so a
    // refused box goes back rather than looking ticked until the next read. to: a state of its own instead (long press
    // Move to Inbox: 'proposed', a widget's box, a Status picked)
    async toggle(id, to) {
      const doc = await hold(id), n = readNode(doc);
      if (!STATE_TYPES.includes(n.stateType) || (to != null && !STATE_TYPES.includes(to))) throw new Error('Only a task can be ticked off');
      if (doc.writeDenied || editable(n, S.me.userUri) === false) throw new Error('This task is read-only to you');
      const next = to ?? (n.stateType === 'proposed' || n.stateType === 'closed' ? 'open' : 'closed');
      const refused = denied(id);
      setState(doc, next, S.me.userUri);
      if (await refused) throw new Error('Tana refused the change: this task is read-only to you');
      return JSON.stringify(next);
    },
    // Long press, Assign to …: the task given to the one picked ([] unassigns), as the desktop's Assign to … sets it
    // outright; answers who was just given work they cannot open, which the app asks about (renderer/access.js openShareAsk)
    async assign(id, uris) {
      const doc = await hold(id);
      if (doc.writeDenied || editable(readNode(doc), S.me.userUri) === false) throw new Error('This task is read-only to you');
      const refused = denied(id);
      const before = taskMeta(doc).assignees;
      setAssignees(doc, uris, S.me.userUri); // refuses what is not a task
      if (await refused) throw new Error('Tana refused the change: this task is read-only to you');
      return JSON.stringify((await shutOut(doc)).filter((uri) => !before.includes(uri)));
    },
    // A zoomed node's Assigned to and Visible to: who has it, who can see it, the assignees shut out, and the sharing rules
    // you may pick from (sdk/access.js capabilities)
    async access(id) {
      const doc = await hold(id), n = readNode(doc), direct = taskMeta(doc), ctx = await access();
      const [meta, options, people] = await Promise.all([audienceMetadata(doc, S.me.userUri, S.client.graph, ctx.sync), capabilities(doc, S.me.userUri, ctx), members().catch(() => [])]);
      const person = (uri) => ({ id: uri, name: demoName((people.find((m) => m.id === uri) || {}).title || 'Someone') });
      const space = (a) => a && a.title ? demoTitle(a.title, a.boundaryUri || a.uri || 'space') : null;
      return JSON.stringify({
        title: demoTitle(n.title || 'Untitled', id), me: S.me.userUri, task: STATE_TYPES.includes(n.stateType), assignees: direct.assignees.map(person),
        state: STATE_TYPES.includes(n.stateType) ? n.stateType : null, // the Status field's (Pages.swift NodeDetails)
        audience: meta.audience, space: space(meta.audienceSpace), people: meta.audience === 'everyone' ? [] : (meta.people || []).map(person), // everyone: the org, named by its word
        hidden: (meta.hiddenFrom || []).map(person), restricted: direct.restricted === true, participants: direct.participants.map((p) => p.uri).filter((uri) => uri !== S.me.userUri),
        rules: options.rules, reason: options.reason, inherit: { scope: options.inheritAudience.scope, space: space(options.inheritAudience) }, token: options.sharingToken,
        agent: agentOf(id, doc), // the agent linked through orbital.md it is handed to, and how that is going (agents.js)
      });
    },
    // Visibility: only you, the people named (each keeping the role they had, editors otherwise), or where it lives, with
    // the token access() disclosed; Grant access is the people named plus those shut out
    async share(id, rule, uris, token) {
      const doc = await hold(id), n = readNode(doc);
      const participants = rule === 'people' ? uris.map((uri) => ({ uri, role: (n.participants && n.participants[uri] && n.participants[uri].role) || 'editor' })) : undefined;
      const refused = denied(id);
      await setSharing(doc, S.me.userUri, { rule, participants, token: token || undefined }, await access());
      if (await refused) throw new Error('Tana refused the change: you cannot change who sees this');
      return JSON.stringify(true);
    },
  };
}

module.exports = { createTasks, REFUSED_MS };
