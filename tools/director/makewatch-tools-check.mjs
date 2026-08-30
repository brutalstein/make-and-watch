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
  generationProvider: async () => ({ visual: { provider: 'comfyui', online: true }, voice: { provider: 'chatterbox', ready: false } }),
  startSceneGeneration: async (input) => { calls.push(['scene-generate', input]); return { job: { id: 'job-abcdefgh', sceneId: input.sceneId, status: 'queued' } }; },
  startAudioGeneration: async (input) => { calls.push(['audio-generate', input]); return { job: { id: 'job-audio01', audioId: input.audioId, status: 'queued' } }; },
  episodeComposition: async (input) => { calls.push(['episode-compose', input]); return { manifest: { episode: { id: input.episodeId }, ready: true } }; },
  startEpisodeRender: async (input) => { calls.push(['episode-render', input]); return { job: { id: 'job-render01', episodeId: input.episodeId, status: 'queued' } }; },
  generationJob: async (input) => { calls.push(['job', input]); return { job: { id: input.jobId, status: 'running', progress: 42 } }; },
  generationJobs: async (input) => { calls.push(['jobs', input]); return { jobs: [] }; },
};

const specs = makeWatchDynamicToolSpecs();
assert.equal(specs.length, 1);
assert.equal(specs[0].type, 'namespace');
assert.equal(specs[0].name, 'makewatch');
const names = new Set(specs[0].tools.map((tool) => tool.name));
for (const required of [
  'project_snapshot', 'project_query', 'project_history', 'project_impact', 'project_apply',
  'workflow_new', 'workflow_save', 'workflow_list', 'workflow_load', 'workflow_delete',
  'production_schema', 'generation_provider', 'scene_generate', 'audio_generate',
  'episode_compose', 'episode_render', 'generation_job', 'generation_jobs',
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

const schema = JSON.parse(await handleMakeWatchToolCall({
  namespace: 'makewatch',
  tool: 'production_schema',
  callId: 'schema-1',
  arguments: { kinds: ['shot', 'character'] },
}, runtime));
assert.deepEqual(schema.kinds.map((entry) => entry.kind), ['shot', 'character']);
const shotKeys = new Set(schema.kinds[0].fields.map((field) => field.key));
for (const required of ['durationSeconds', 'framing', 'generationStrategy', 'seed', 'index']) {
  assert.equal(shotKeys.has(required), true, `shot schema is missing ${required}`);
}
const strategy = schema.kinds[0].fields.find((field) => field.key === 'generationStrategy');
assert.deepEqual(strategy.options, ['I2V', 'FLF2V', 'VIDEO']);
assert.equal(strategy.defaultValue, 'I2V');
assert.equal(strategy.options.includes('STILL_MOTION'), false);
assert.equal(strategy.options.includes('T2I'), false);
const characterKeys = new Set(schema.kinds[1].fields.map((field) => field.key));
assert.equal(characterKeys.has('appearancePrompt'), true, 'character continuity anchor is missing');

const fullSchema = JSON.parse(await handleMakeWatchToolCall({
  namespace: 'makewatch', tool: 'production_schema', callId: 'schema-2', arguments: {},
}, runtime));
assert.equal(fullSchema.kinds.length, 9);
const generationSchema = fullSchema.kinds.find((entry) => entry.kind === 'generation');
assert.ok(generationSchema.consumes.includes('episode'), 'episode render generations must match the capability hierarchy');

const started = JSON.parse(await handleMakeWatchToolCall({
  namespace: 'makewatch',
  tool: 'scene_generate',
  callId: 'gen-1',
  arguments: { sceneId: 'scene.one' },
}, runtime));
assert.equal(started.job.status, 'queued');
assert.deepEqual(calls.at(-1), ['scene-generate', { sceneId: 'scene.one' }]);

const composition = JSON.parse(await handleMakeWatchToolCall({
  namespace: 'makewatch',
  tool: 'episode_compose',
  callId: 'compose-1',
  arguments: { episodeId: 'episode.one' },
}, runtime));
assert.equal(composition.manifest.ready, true);
assert.deepEqual(calls.at(-1), ['episode-compose', { episodeId: 'episode.one' }]);

const render = JSON.parse(await handleMakeWatchToolCall({
  namespace: 'makewatch',
  tool: 'episode_render',
  callId: 'render-1',
  arguments: { episodeId: 'episode.one' },
}, runtime));
assert.equal(render.job.status, 'queued');
assert.deepEqual(calls.at(-1), ['episode-render', { episodeId: 'episode.one' }]);

const polled = JSON.parse(await handleMakeWatchToolCall({
  namespace: 'makewatch',
  tool: 'generation_job',
  callId: 'gen-2',
  arguments: { jobId: 'job-abcdefgh' },
}, runtime));
assert.equal(polled.job.progress, 42);
assert.deepEqual(calls.at(-1), ['job', { jobId: 'job-abcdefgh', kind: 'visual' }]);

await handleMakeWatchToolCall({
  namespace: 'makewatch',
  tool: 'generation_jobs',
  callId: 'gen-3',
  arguments: { kind: 'audio' },
}, runtime);
assert.deepEqual(calls.at(-1), ['jobs', { kind: 'audio', limit: 20 }]);

await handleMakeWatchToolCall({
  namespace: 'makewatch',
  tool: 'generation_job',
  callId: 'render-2',
  arguments: { jobId: 'job-render01', kind: 'render' },
}, runtime);
assert.deepEqual(calls.at(-1), ['job', { jobId: 'job-render01', kind: 'render' }]);

await handleMakeWatchToolCall({
  namespace: 'makewatch',
  tool: 'generation_jobs',
  callId: 'render-3',
  arguments: { kind: 'render', limit: 5 },
}, runtime);
assert.deepEqual(calls.at(-1), ['jobs', { kind: 'render', limit: 5 }]);

await assert.rejects(
  handleMakeWatchToolCall({
    namespace: 'makewatch', tool: 'scene_generate', callId: 'gen-4', arguments: {},
  }, runtime),
  /sceneId is required/,
);

console.log('makewatch dynamic tools check: passed');
