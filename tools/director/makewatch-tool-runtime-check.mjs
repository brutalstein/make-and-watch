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
  audioProvider: async () => ({ provider: 'chatterbox', ready: true, languages: ['ja'] }),
  referenceProvider: async () => ({ provider: 'comfyui', ready: true, modes: ['T2I_REFERENCE', 'IMG2IMG_REFERENCE'] }),
  startReferenceGeneration: async (input) => ({ job: { id: 'reference-job', ...input, status: 'queued' } }),
  referenceJob: async ({ jobId }) => ({ job: { id: jobId, status: 'running' } }),
  referenceJobs: async () => ({ jobs: [] }),
  temporalProviders: async () => ({ providers: [{ id: 'framepack', ready: true }] }),
  temporalShotPlan: async ({ shotId }) => ({ plan: { shot: { id: shotId, strategy: 'I2V' } } }),
  startTemporalShotGeneration: async ({ shotId, providerId }) => ({ job: { id: 'temporal-job', shotId, providerId, status: 'queued' } }),
  temporalJob: async ({ jobId }) => ({ job: { id: jobId, status: 'running' } }),
  temporalJobs: async () => ({ jobs: [] }),
  cancelMediaJob: async ({ kind, jobId }) => ({ job: { id: jobId, kind, status: 'cancelled' } }),
};
const animeRuntime = {
  productionStatus: async () => ({ ready: true, compiler: { ready: true } }),
  shotAnimPlan: async ({ shotId }) => ({ ready: true, shotId }),
  shotAnimCompile: async ({ shotId }) => ({ shotId, assetNodeId: 'asset.shot-anim' }),
};

configureMakeWatchToolRuntime(baseRuntime, { temporalRuntime, animeRuntime });
assert.equal(hasMakeWatchToolRuntime(), true);
const specs = configuredMakeWatchDynamicToolSpecs();
assert.deepEqual(specs.map((namespace) => namespace.name), ['makewatch', 'makewatch_media', 'makewatch_anime']);

const base = JSON.parse(await handleConfiguredMakeWatchToolCall({
  namespace: 'makewatch', tool: 'project_snapshot', arguments: {},
}));
assert.equal(base.projectRevision, 1);

const referenceProvider = JSON.parse(await handleConfiguredMakeWatchToolCall({
  namespace: 'makewatch_media', tool: 'reference_provider', arguments: {},
}));
assert.equal(referenceProvider.ready, true);

const audioProvider = JSON.parse(await handleConfiguredMakeWatchToolCall({
  namespace: 'makewatch_media', tool: 'audio_provider', arguments: {},
}));
assert.equal(audioProvider.languages[0], 'ja');

const referenceStarted = JSON.parse(await handleConfiguredMakeWatchToolCall({
  namespace: 'makewatch_media',
  tool: 'reference_generate',
  arguments: {
    targetId: 'character.mira',
    sourceAssetId: 'asset.source',
    stylePreset: 'anime-cinematic',
    direction: 'preserve identity',
    denoise: 0.6,
  },
}));
assert.equal(referenceStarted.job.status, 'queued');
assert.equal(referenceStarted.job.targetId, 'character.mira');
assert.equal(referenceStarted.job.stylePreset, 'anime-cinematic');
assert.equal(referenceStarted.job.denoise, 0.6);

const referenceJob = JSON.parse(await handleConfiguredMakeWatchToolCall({
  namespace: 'makewatch_media', tool: 'reference_job', arguments: { jobId: 'reference-job' },
}));
assert.equal(referenceJob.job.status, 'running');

const media = JSON.parse(await handleConfiguredMakeWatchToolCall({
  namespace: 'makewatch_media', tool: 'temporal_providers', arguments: {},
}));
assert.equal(media.providers[0].id, 'framepack');

const started = JSON.parse(await handleConfiguredMakeWatchToolCall({
  namespace: 'makewatch_media', tool: 'shot_generate_video', arguments: { shotId: 'shot.1', providerId: 'framepack' },
}));
assert.equal(started.job.status, 'queued');

const cancelledMedia = JSON.parse(await handleConfiguredMakeWatchToolCall({
  namespace: 'makewatch_media', tool: 'media_job_cancel', arguments: { kind: 'temporal', jobId: 'job-1' },
}));
assert.equal(cancelledMedia.job.status, 'cancelled');

const animeStatus = JSON.parse(await handleConfiguredMakeWatchToolCall({
  namespace: 'makewatch_anime', tool: 'production_status', arguments: {},
}));
assert.equal(animeStatus.compiler.ready, true);

const animePlan = JSON.parse(await handleConfiguredMakeWatchToolCall({
  namespace: 'makewatch_anime', tool: 'shot_anim_plan', arguments: { shotId: 'shot.1' },
}));
assert.equal(animePlan.shotId, 'shot.1');

const animeCompile = JSON.parse(await handleConfiguredMakeWatchToolCall({
  namespace: 'makewatch_anime', tool: 'shot_anim_compile', arguments: { shotId: 'shot.1' },
}));
assert.equal(animeCompile.assetNodeId, 'asset.shot-anim');

clearMakeWatchToolRuntime();
assert.equal(hasMakeWatchToolRuntime(), false);
assert.deepEqual(configuredMakeWatchDynamicToolSpecs(), []);

console.log('makewatch tool runtime check passed');
