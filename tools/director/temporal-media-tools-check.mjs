import assert from 'node:assert/strict';

import {
  handleTemporalMediaToolCall,
  temporalMediaDynamicToolSpecs,
  temporalMediaToolLimits,
} from './temporal-media-tools.mjs';

const calls = [];
const runtime = {
  referenceProvider: async () => ({ provider: 'comfyui', ready: true, modes: ['T2I_REFERENCE', 'IMG2IMG_REFERENCE'] }),
  startReferenceGeneration: async (input) => { calls.push(['reference-start', input]); return { job: { id: 'job-reference-1', status: 'queued', ...input } }; },
  referenceJob: async (input) => { calls.push(['reference-job', input]); return { job: { id: input.jobId, status: 'running', progress: 55 } }; },
  referenceJobs: async (input) => { calls.push(['reference-jobs', input]); return { jobs: [] }; },
  temporalProviders: async () => ({ providers: [{ id: 'framepack', ready: true }] }),
  temporalShotPlan: async (input) => { calls.push(['plan', input]); return { plan: { shot: { id: input.shotId, strategy: 'I2V' } } }; },
  startTemporalShotGeneration: async (input) => { calls.push(['start', input]); return { job: { id: 'job-temporal-1', status: 'queued' } }; },
  temporalJob: async (input) => { calls.push(['job', input]); return { job: { id: input.jobId, status: 'running', progress: 12 } }; },
  temporalJobs: async (input) => { calls.push(['jobs', input]); return { jobs: [] }; },
};

const specs = temporalMediaDynamicToolSpecs();
assert.equal(specs.length, 1);
assert.equal(specs[0].name, 'makewatch_media');
assert.equal(temporalMediaToolLimits.namespace, 'makewatch_media');
const names = new Set(specs[0].tools.map((tool) => tool.name));
for (const required of [
  'reference_provider', 'reference_generate', 'reference_job', 'reference_jobs',
  'temporal_providers', 'shot_temporal_plan', 'shot_generate_video', 'temporal_job', 'temporal_jobs',
]) {
  assert.equal(names.has(required), true, `missing media tool ${required}`);
}
assert.deepEqual(
  temporalMediaToolLimits.referenceStylePresets,
  ['live-action-cinematic', 'anime-cinematic', 'illustration', 'stylized-3d'],
);

const referenceProvider = JSON.parse(await handleTemporalMediaToolCall({
  namespace: 'makewatch_media', tool: 'reference_provider', arguments: {},
}, runtime));
assert.equal(referenceProvider.ready, true);

const referenceStarted = JSON.parse(await handleTemporalMediaToolCall({
  namespace: 'makewatch_media',
  tool: 'reference_generate',
  arguments: {
    targetId: 'character.mira',
    sourceAssetId: 'asset.source',
    stylePreset: 'anime-cinematic',
    direction: 'preserve face and silhouette',
    denoise: 0.6,
  },
}, runtime));
assert.equal(referenceStarted.job.status, 'queued');
assert.deepEqual(calls.at(-1), ['reference-start', {
  targetId: 'character.mira',
  sourceAssetId: 'asset.source',
  stylePreset: 'anime-cinematic',
  direction: 'preserve face and silhouette',
  denoise: 0.6,
}]);

const referenceJob = JSON.parse(await handleTemporalMediaToolCall({
  namespace: 'makewatch_media', tool: 'reference_job', arguments: { jobId: 'job-reference-1' },
}, runtime));
assert.equal(referenceJob.job.progress, 55);
await handleTemporalMediaToolCall({ namespace: 'makewatch_media', tool: 'reference_jobs', arguments: {} }, runtime);
assert.deepEqual(calls.at(-1), ['reference-jobs', { limit: 20 }]);

await assert.rejects(
  handleTemporalMediaToolCall({
    namespace: 'makewatch_media',
    tool: 'reference_generate',
    arguments: { targetId: 'character.mira', stylePreset: 'unsupported' },
  }, runtime),
  /stylePreset must be one of/,
);
await assert.rejects(
  handleTemporalMediaToolCall({
    namespace: 'makewatch_media',
    tool: 'reference_generate',
    arguments: { targetId: 'character.mira', denoise: 0.99 },
  }, runtime),
  /denoise must be between 0.15 and 0.9/,
);

const providers = JSON.parse(await handleTemporalMediaToolCall({
  namespace: 'makewatch_media', tool: 'temporal_providers', arguments: {},
}, runtime));
assert.equal(providers.providers[0].id, 'framepack');

const plan = JSON.parse(await handleTemporalMediaToolCall({
  namespace: 'makewatch_media', tool: 'shot_temporal_plan', arguments: { shotId: 'shot.1', maxSegmentSeconds: 5 },
}, runtime));
assert.equal(plan.plan.shot.strategy, 'I2V');
assert.deepEqual(calls.at(-1), ['plan', { shotId: 'shot.1', maxSegmentSeconds: 5 }]);

const started = JSON.parse(await handleTemporalMediaToolCall({
  namespace: 'makewatch_media', tool: 'shot_generate_video', arguments: { shotId: 'shot.1', providerId: 'framepack' },
}, runtime));
assert.equal(started.job.status, 'queued');
assert.deepEqual(calls.at(-1), ['start', { shotId: 'shot.1', providerId: 'framepack' }]);

const job = JSON.parse(await handleTemporalMediaToolCall({
  namespace: 'makewatch_media', tool: 'temporal_job', arguments: { jobId: 'job-temporal-1' },
}, runtime));
assert.equal(job.job.progress, 12);

await handleTemporalMediaToolCall({ namespace: 'makewatch_media', tool: 'temporal_jobs', arguments: {} }, runtime);
assert.deepEqual(calls.at(-1), ['jobs', { limit: 20 }]);

await assert.rejects(
  handleTemporalMediaToolCall({ namespace: 'makewatch_media', tool: 'shot_generate_video', arguments: { shotId: 'shot.1', providerId: '' } }, runtime),
  /providerId is required/,
);
await assert.rejects(
  handleTemporalMediaToolCall({ namespace: 'makewatch', tool: 'temporal_providers', arguments: {} }, runtime),
  /unknown media tool namespace/,
);

console.log('media tools check passed');