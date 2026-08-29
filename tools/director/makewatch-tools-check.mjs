import assert from 'node:assert/strict';

import {
  handleMakeWatchToolCall,
  makeWatchDynamicToolSpecs,
  makeWatchToolLimits,
} from './makewatch-tools.mjs';

const calls = [];
const snapshot = {
  schemaVersion: 1,
  projectRevision: 7,
  nodes: [
    { id: 'series.demo', kind: 'series', title: 'Demo', metadata: {}, revision: 1, approval: 'draft', locked: false, stale: false },
    { id: 'scene.one', kind: 'scene', title: 'Opening cafe', metadata: {}, revision: 2, approval: 'review', locked: false, stale: false },
    { id: 'shot.one', kind: 'shot', title: 'Close up', metadata: {}, revision: 1, approval: 'draft', locked: false, stale: false },
  ],
  dependencies: [
    { dependent: 'scene.one', dependency: 'series.demo' },
    { dependent: 'shot.one', dependency: 'scene.one' },
  ],
};

const runtime = {
  snapshot: async () => snapshot,
  history: async (limit) => ({ transactions: [], limit }),
  impact: async (source) => ({ source, affected: [], locked: [], alreadyStale: [] }),
  apply: async (input) => { calls.push(['apply', input]); return { projectRevision: 8, snapshot: { ...snapshot, projectRevision: 8 }, events: [] }; },
  newWorkflow: async (input) => { calls.push(['new', input]); return { projectRevision: 8 }; },
  saveWorkflow: async (input) => { calls.push(['save', input]); return { id: 'wf-test-12345678', ...input }; },
  listWorkflows: async (input) => ({ workflows: [], issues: [], ...input }),
  loadWorkflow: async (input) => { calls.push(['load', input]); return { projectRevision: 8 }; },
  deleteWorkflow: async (input) => { calls.push(['delete', input]); return { id: input.workflowId }; },
};

const specs = makeWatchDynamicToolSpecs();
assert.equal(specs.length, 1);
assert.equal(specs[0].type, 'namespace');
assert.equal(specs[0].name, 'makewatch');
const names = new Set(specs[0].tools.map((tool) => tool.name));
for (const required of [
  'project_snapshot', 'project_query', 'project_history', 'project_impact', 'project_apply',
  'workflow_new', 'workflow_save', 'workflow_list', 'workflow_load', 'workflow_delete',
]) {
  assert.equal(names.has(required), true, `missing tool ${required}`);
}
assert.equal(makeWatchToolLimits.maxCommands, 64);

const queryText = await handleMakeWatchToolCall({
  namespace: 'makewatch',
  tool: 'project_query',
  callId: 'query-1',
  arguments: { kinds: ['scene'], text: 'cafe', limit: 10 },
}, runtime);
const query = JSON.parse(queryText);
assert.equal(query.projectRevision, 7);
assert.equal(query.matchedNodeCount, 1);
assert.equal(query.nodes[0].id, 'scene.one');
assert.equal(query.dependencies.length, 0, 'dependencies should only be returned when both endpoints are included');

const applyText = await handleMakeWatchToolCall({
  namespace: 'makewatch',
  tool: 'project_apply',
  callId: 'tool-call-7',
  arguments: {
    expectedProjectRevision: 7,
    reason: 'rename opening scene',
    commands: [{ type: 'node.patch', id: 'scene.one', expectedRevision: 2, title: 'New opening' }],
  },
}, runtime);
assert.equal(JSON.parse(applyText).projectRevision, 8);
assert.deepEqual(calls[0], ['apply', {
  expectedProjectRevision: 7,
  reason: 'rename opening scene',
  commands: [{ type: 'node.patch', id: 'scene.one', expectedRevision: 2, title: 'New opening' }],
  callId: 'tool-call-7',
}]);

await assert.rejects(
  handleMakeWatchToolCall({
    namespace: 'makewatch',
    tool: 'project_apply',
    callId: 'too-many',
    arguments: {
      expectedProjectRevision: 7,
      reason: 'oversized batch',
      commands: Array.from({ length: 65 }, () => ({ type: 'node.markFresh', id: 'scene.one' })),
    },
  }, runtime),
  /between 1 and 64/,
);

await assert.rejects(
  handleMakeWatchToolCall({
    namespace: 'makewatch',
    tool: 'workflow_delete',
    callId: 'delete-1',
    arguments: { workflowId: 'wf-test-12345678', confirm: false },
  }, runtime),
  /confirm=true/,
);

const saved = JSON.parse(await handleMakeWatchToolCall({
  namespace: 'makewatch',
  tool: 'workflow_save',
  callId: 'save-1',
  arguments: { name: 'Draft A', description: 'checkpoint' },
}, runtime));
assert.equal(saved.name, 'Draft A');
assert.equal(calls.at(-1)[0], 'save');

await assert.rejects(
  handleMakeWatchToolCall({ namespace: 'other', tool: 'project_snapshot', arguments: {} }, runtime),
  /unknown dynamic tool namespace/,
);

console.log('makewatch dynamic tools check: passed');
