import assert from 'node:assert/strict';

import {
  clearMakeWatchToolRuntime,
  configureMakeWatchToolRuntime,
  configuredMakeWatchDynamicToolSpecs,
  handleConfiguredMakeWatchToolCall,
  hasMakeWatchToolRuntime,
} from './makewatch-tool-runtime.mjs';

const baseRuntime = {
  snapshot: async () => ({ projectRevision: 1, nodes: [], dependencies: [] }),
  history: async () => ({}),
  impact: async () => ({}),
  apply: async () => ({}),
  newWorkflow: async () => ({}),
  saveWorkflow: async () => ({}),
  listWorkflows: async () => ({}),
  loadWorkflow: async () => ({}),
  deleteWorkflow: async () => ({}),
  generationProvider: async () => ({}),
  startSceneGeneration: async () => ({}),
  startAudioGeneration: async () => ({}),
  episodeComposition: async () => ({}),
  startEpisodeRender: async () => ({}),
  generationJob: async () => ({}),
  generationJobs: async () => ({}),
};
const temporalRuntime = {
  temporalProviders: async () => ({ providers: [{ id: 'framepack', ready: true }] }),
  temporalShotPlan: async ({ shotId }) => ({ plan: { shot: { id: shotId, strategy: 'I2V' } } }),
  startTemporalShotGeneration: async ({ shotId, providerId }) => ({ job: { id: 'temporal-job', shotId, providerId, status: 'queued' } }),
  temporalJob: async ({ jobId }) => ({ job: { id: jobId, status: 'running' } }),
  temporalJobs: async () => ({ jobs: [] }),
};

configureMakeWatchToolRuntime(baseRuntime, { temporalRuntime });
assert.equal(hasMakeWatchToolRuntime(), true);
const specs = configuredMakeWatchDynamicToolSpecs();
assert.deepEqual(specs.map((namespace) => namespace.name), ['makewatch', 'makewatch_media']);

const base = JSON.parse(await handleConfiguredMakeWatchToolCall({
  namespace: 'makewatch', tool: 'project_snapshot', arguments: {},
}));
assert.equal(base.projectRevision, 1);

const media = JSON.parse(await handleConfiguredMakeWatchToolCall({
  namespace: 'makewatch_media', tool: 'temporal_providers', arguments: {},
}));
assert.equal(media.providers[0].id, 'framepack');

const started = JSON.parse(await handleConfiguredMakeWatchToolCall({
  namespace: 'makewatch_media', tool: 'shot_generate_video', arguments: { shotId: 'shot.1', providerId: 'framepack' },
}));
assert.equal(started.job.status, 'queued');

clearMakeWatchToolRuntime();
assert.equal(hasMakeWatchToolRuntime(), false);
assert.deepEqual(configuredMakeWatchDynamicToolSpecs(), []);

console.log('makewatch tool runtime check passed');
