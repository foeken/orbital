'use strict';
// Every list the phone asks for, as the desktop's (main/views.js listFilter): no deleted nodes, not the Orbital settings
// document, nothing your hidden titles name ("Block*", "Lunch", synced from the Mac), no MCP chats when Hide MCP is on,
// and meeting chats in any list of chats (sdk/query.js addMeetingChats). A lookup by id answers as it is: hiding is about
// lists, not about access. listNodesUnhidden is the graph untouched, for the reads main/timeline.js and main/settings.js
// make past those rules, as on the Mac. Without the hidden titles the phone's Upcoming meetings showed Block and Lunch.
const { addMeetingChats, hideRules, isHidden } = require('../../sdk/query');
const { isMcp, memberTitle, visibleGraphNodes } = require('../../main/state');

function listFilter(graph, settings) {
  const list = graph.listNodes.bind(graph);
  graph.listNodesUnhidden = list;
  graph.listNodes = addMeetingChats(async (params) => {
    const result = await list(params), nodes = visibleGraphNodes(result.nodes);
    if (params && params.nodeIds) return { ...result, nodes };
    const app = new Set(settings.appDocIds()), rules = hideRules(settings.get('hiddenTitles')), hideMcp = settings.get('hideMcp') === true;
    return { ...result, nodes: nodes.filter((n) => !app.has(n.id) && !isHidden(memberTitle(n), rules) && !(hideMcp && isMcp(n))) };
  });
}

module.exports = { listFilter };
