import assert from 'node:assert/strict';

import {
  handleTemporalMediaToolCall,
  temporalMediaDynamicToolSpecs,
  temporalMediaToolLimits,
} from './temporal-media-tools.mjs';

const calls = [];
const runtime = {
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
for (const required of ['temporal_providers', 'shot_temporal_plan', 'shot_generate_video', 'temporal_job', 'temporal_jobs']) {
  assert.equal(names.has(required), true, `missing temporal tool ${required}`);
}

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
  /unknown temporal media tool namespace/,
);

console.log('temporal media tools check passed');
