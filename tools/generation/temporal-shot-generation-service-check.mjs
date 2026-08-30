import assert from 'node:assert/strict';

import { TemporalShotGenerationService } from './temporal-shot-generation-service.mjs';

function node(id, kind, metadata = {}, revision = 1) {
  return { id, kind, title: id, revision, approval: 'approved', locked: false, stale: false, metadata };
}

function fixtureSnapshot(shotRevision = 3) {
  return {
    projectRevision: 9,
    nodes: [
      node('scene.1', 'scene'),
      node('character.1', 'character', { canonicalImageAssetIds: '["asset.face"]' }),
      node('shot.1', 'shot', {
        durationSeconds: '5',
        generationStrategy: 'I2V',
        qualityTier: 'preview',
        subjectAction: 'walks forward',
      }, shotRevision),
      node('generation.hero', 'generation', { status: 'ready', mediaType: 'image' }, 4),
      node('asset.hero', 'asset', { mediaType: 'image', relativePath: 'artifacts/hero.png', sha256: 'hero' }),
      node('asset.face', 'asset', { mediaType: 'image', relativePath: 'artifacts/face.png', sha256: 'face' }),
    ],
    dependencies: [
      { dependent: 'shot.1', dependency: 'scene.1' },
      { dependent: 'shot.1', dependency: 'character.1' },
      { dependent: 'generation.hero', dependency: 'shot.1' },
      { dependent: 'asset.hero', dependency: 'generation.hero' },
    ],
  };
}

async function waitFor(service, jobId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = service.get(jobId);
    if (job.status === 'completed' || job.status === 'failed') return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('temporal service fixture timed out');
}

const applies = [];
const stable = fixtureSnapshot();
const bridge = {
  snapshot: async () => structuredClone(stable),
  apply: async (commands, context, expectedProjectRevision) => {
    applies.push({ commands, context, expectedProjectRevision });
    return { projectRevision: expectedProjectRevision + 1 };
  },
};
const registry = {
  statuses: async () => [{ id: 'fixture', installed: true, ready: true }],
  generate: async (providerId, request) => {
    assert.equal(providerId, 'fixture');
    assert.equal(request.inputs.startFrame.id, 'asset.hero');
    assert.equal(request.shotAnim, shotAnim);
    return {
      provider: 'fixture',
      artifact: {
        mediaType: 'video',
        relativePath: 'artifacts/video/shot-1.mp4',
        sha256: 'b'.repeat(64),
        mimeType: 'video/mp4',
        durationSeconds: 5,
        width: 960,
        height: 540,
        fps: 24,
        providerMetadata: { engine: 'fixture', deterministic: true },
      },
    };
  },
};
const scheduler = {
  run: async (lease, operation) => {
    assert.equal(lease.kind, 'temporal-video');
    return operation();
  },
};
const shotAnim = { schema: 'makewatch.shotAnim/1', shotId: 'shot.1' };
const providerRequestBuilders = {
  fixture: async ({ snapshot, request }) => {
    assert.equal(snapshot.projectRevision, 9);
    return {
      request: { ...request, shotAnim },
      inputAssetIds: ['asset.rig', 'asset.environment', 'asset.alignment'],
    };
  },
};

const service = new TemporalShotGenerationService({
  bridge,
  registry,
  scheduler,
  hardware: async () => ({ totalVramMb: 8192 }),
  providerRequestBuilders,
});
const started = await service.startShot({ shotId: 'shot.1', providerId: 'fixture' });
const completed = await waitFor(service, started.id);
assert.equal(completed.status, 'completed');
assert.equal(completed.artifact.assetNodeId, `asset.${'b'.repeat(24)}`);
assert.equal(applies.length, 1);
assert.equal(applies[0].context.source, 'temporal-shot-generation');
assert.ok(applies[0].commands.some((command) => command.type === 'node.create' && command.node.kind === 'generation'));
assert.ok(applies[0].commands.some((command) => command.type === 'node.create' && command.node.kind === 'asset'));
assert.ok(applies[0].commands.some((command) => command.type === 'dependency.add' && command.dependency === 'asset.face'));
for (const dependency of ['asset.rig', 'asset.environment', 'asset.alignment']) {
  assert.ok(applies[0].commands.some((command) => command.type === 'dependency.add' && command.dependency === dependency));
}
const generationCreate = applies[0].commands.find((command) => command.type === 'node.create' && command.node.kind === 'generation');
const assetCreate = applies[0].commands.find((command) => command.type === 'node.create' && command.node.kind === 'asset');
assert.equal(generationCreate.node.metadata.providerMetadata, JSON.stringify({ engine: 'fixture', deterministic: true }));
assert.equal(assetCreate.node.metadata.fps, '24');

let snapshots = 0;
const staleBridge = {
  snapshot: async () => {
    snapshots += 1;
    return structuredClone(fixtureSnapshot(snapshots === 1 ? 3 : 4));
  },
  apply: async () => { throw new Error('must not commit stale job'); },
};
const staleService = new TemporalShotGenerationService({
  bridge: staleBridge,
  registry,
  scheduler,
  hardware: async () => ({ totalVramMb: 8192 }),
});
const staleStarted = await staleService.startShot({ shotId: 'shot.1', providerId: 'fixture' });
const staleJob = await waitFor(staleService, staleStarted.id);
assert.equal(staleJob.status, 'failed');
assert.match(staleJob.error, /changed from revision 3 to 4/);

let builderRegistryCalls = 0;
const builderErrorApplies = [];
const builderErrorService = new TemporalShotGenerationService({
  bridge: {
    snapshot: async () => structuredClone(stable),
    apply: async (...args) => { builderErrorApplies.push(args); },
  },
  registry: {
    statuses: registry.statuses,
    generate: async () => { builderRegistryCalls += 1; throw new Error('registry must not run'); },
  },
  scheduler,
  hardware: async () => ({ totalVramMb: 8192 }),
  providerRequestBuilders: {
    fixture: async () => { throw Object.assign(new Error('compiler blocked the Shot'), { code: 'not_ready' }); },
  },
});
const builderErrorStarted = await builderErrorService.startShot({ shotId: 'shot.1', providerId: 'fixture' });
const builderErrorJob = await waitFor(builderErrorService, builderErrorStarted.id);
assert.equal(builderErrorJob.status, 'failed');
assert.match(builderErrorJob.error, /compiler blocked/);
assert.equal(builderRegistryCalls, 0);
assert.equal(builderErrorApplies.length, 0);

const layeredSnapshot = fixtureSnapshot();
layeredSnapshot.nodes = layeredSnapshot.nodes.filter(({ id }) => !['generation.hero', 'asset.hero'].includes(id));
layeredSnapshot.dependencies = layeredSnapshot.dependencies.filter(({ dependent, dependency }) => !['generation.hero', 'asset.hero'].includes(dependent) && !['generation.hero', 'asset.hero'].includes(dependency));
let layeredRequest = null;
const layeredService = new TemporalShotGenerationService({
  bridge: {
    snapshot: async () => structuredClone(layeredSnapshot),
    apply: async () => ({ projectRevision: 10 }),
  },
  registry: {
    statuses: registry.statuses,
    generate: async (_providerId, request) => {
      layeredRequest = request;
      return registry.generate('fixture', { ...request, inputs: { ...request.inputs, startFrame: { id: 'asset.hero' } } });
    },
  },
  scheduler,
  hardware: async () => ({ totalVramMb: 8192 }),
  providerRequestBuilders,
});
const layeredStarted = await layeredService.startShot({ shotId: 'shot.1', providerId: 'fixture' });
const layeredJob = await waitFor(layeredService, layeredStarted.id);
assert.equal(layeredJob.status, 'completed');
assert.equal(layeredRequest.inputs.startFrame, null);
assert.equal(layeredRequest.shotAnim, shotAnim);

console.log('temporal shot generation service checks passed');
