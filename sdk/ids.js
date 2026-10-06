'use strict';
// Tana ids: tana:<kind>:<26-character lowercase ULID> (AGENTS.md, "How Tana works"). One pattern for any kind, one per
// kind the code checks, and isId(uri, kind?) for a check in place. A pattern that means something else stays beside its
// code: a field's id (sdk/fields.js), a user or a contact (sdk/events.js), a user or a guest (sdk/node.js), what an icon
// is set on (main/icons.js), a link in a chat message (sdk/chat.js), an orbital: link (main.js).
const idPattern = (kind) => new RegExp('^tana:' + kind + ':[0-9a-z]{26}$');
const DOC_URI = idPattern('[a-z-]+');
const [USER_URI, TYPE_URI, SPACE_URI, EVENT_URI, TEXT_URI, ORG_URI, WORKFLOW_URI, IMAGE_URI] = ['user-profile', 'type', 'space', 'event', 'text', 'org', 'workflow', 'image'].map(idPattern);
// a string that is a Tana id, and of that kind when one is named
const isId = (uri, kind) => typeof uri === 'string' && DOC_URI.test(uri) && (kind === undefined || uri.slice(5, -27) === kind);

module.exports = { DOC_URI, USER_URI, TYPE_URI, SPACE_URI, EVENT_URI, TEXT_URI, ORG_URI, WORKFLOW_URI, IMAGE_URI, isId };
