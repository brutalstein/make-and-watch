import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ShotAnimCompilationService } from './shot-anim-compilation-service.mjs';

function shot(revision = 9, extra = {}) {
  return {
    id: 'shot.1', kind: 'shot', title: 'Shot 1', revision,
    approval: 'approved', locked: false, stale: false, metadata: {}, ...extra,
  };
}

function snapshot(revision = 42, shotRevision = 9) {
  return {
    schemaVersion: 1,
    projectRevision: revision,
    nodes: [shot(shotRevision)],
    dependencies: [],
  };
}

const shotAnim = {
  schema: 'makewatch.shotAnim/1',
  shotId: 'shot.1',
  durationSeconds: 4,
  fps: 24,
  resolution: [1920, 1080],
  layers: [{ id: 'body', part: 'body', path: 'artifacts/anime/body.png', z: 1, parallax: 1, pivot: [0.5, 0.5] }],
  camera: { keyframes: [{ t: 0, x: 0, y: 0, zoom: 1 }] },
  dialogue: [],
  subtitles: [],
};

const compilerResult = {
  shotAnim,
  inputAssetIds: ['asset.rig', 'asset.environment', 'asset.alignment'],
  compileReport: { schema: 'makewatch.shotAnimCompileReport/1', resolvedRevisions: { shot: 9 } },
};

const plannerResult = {
  ready: true,
  shotId: 'shot.1',
  projectRevision: 42,
  issues: [],
  inputAssetIds: ['asset.rig', 'asset.environment', 'asset.audio', 'asset.alignment'],
  resolved: {
    shot: shot(),
    scene: { id: 'scene.1', revision: 4 },
    rigs: [{ characterId: 'character.1', characterRevision: 7, outfitState: 'school' }],
    rigAssets: [{ id: 'asset.rig', absolutePath: 'C:/private/rig.json', bytes: Buffer.from('secret') }],
    environment: { locationId: 'location.1', locationRevision: 3 },
    environmentAsset: { id: 'asset.environment', absolutePath: 'C:/private/environment.json' },
    dialogue: [{
      unit: { id: 'dialogue.1' },
      audioAsset: { id: 'asset.audio' },
      alignmentAsset: { id: 'asset.alignment' },
      audio: { absolutePath: 'C:/private/dialogue.wav', bytes: Buffer.from('secret') },
    }],
    correctiveKeyIds: ['asset.corrective'],
  },
};

function bridge(snapshots, { applyError } = {}) {
  const applies = [];
  let index = 0;
  return {
    applies,
    async snapshot() { return structuredClone(snapshots[Math.min(index++, snapshots.length - 1)]); },
    async apply(commands, context, expectedProjectRevision) {
      applies.push({ commands, context, expectedProjectRevision });
      if (applyError) throw applyError;
      return { projectRevision: expectedProjectRevision + 1 };
    },
  };
}

const root = await mkdtemp(join(tmpdir(), 'makewatch-shot-compile-'));
try {
  const stableBridge = bridge([snapshot(), snapshot()]);
  const service = new ShotAnimCompilationService({
    projectRoot: root,
    bridge: stableBridge,
    compiler: async () => structuredClone(compilerResult),
    planner: async () => structuredClone(plannerResult),
  });
  const publicPlan = await service.plan('shot.1');
  assert.deepEqual(publicPlan.resolved, {
    shotRevision: 9,
    scene: { id: 'scene.1', revision: 4 },
    characterRigs: [{ assetId: 'asset.rig', characterId: 'character.1', characterRevision: 7, outfitState: 'school' }],
    environmentPackage: { assetId: 'asset.environment', locationId: 'location.1', locationRevision: 3 },
    dialogue: [{ dialogueUnitId: 'dialogue.1', audioAssetId: 'asset.audio', alignmentAssetId: 'asset.alignment' }],
    correctiveKeyAssetIds: ['asset.corrective'],
  });
  assert.doesNotMatch(JSON.stringify(publicPlan), /absolutePath|bytes|private|secret/);
  const result = await service.compile('shot.1');
  assert.match(result.assetNodeId, /^asset\.[a-f0-9]{24}$/);
  assert.match(result.generationNodeId, /^generation\.anime-compile\.shot\.1\.[a-f0-9]{12}$/);
  assert.equal(result.shotAnim.schema, 'makewatch.shotAnim/1');
  assert.equal(stableBridge.applies.length, 1);
  const [{ commands, context, expectedProjectRevision }] = stableBridge.applies;
  assert.equal(context.source, 'native-anime-compile');
  assert.equal(expectedProjectRevision, 42);
  assert.ok(commands.some((command) => command.node?.metadata?.schema === 'makewatch.shotAnim/1'));
  for (const dependency of compilerResult.inputAssetIds) {
    assert.ok(commands.some((command) => command.type === 'dependency.add' && command.dependent === result.generationNodeId && command.dependency === dependency));
  }
  assert.ok(commands.some((command) => command.type === 'dependency.add' && command.dependent === result.assetNodeId && command.dependency === result.generationNodeId));
  assert.ok(commands.some((command) => command.type === 'dependency.add' && command.dependent === 'shot.1' && command.dependency === result.assetNodeId));
  const persisted = await readFile(join(root, '.makewatch', ...result.relativePath.split('/')), 'utf8');
  assert.equal(persisted, JSON.stringify(shotAnim, null, 2));

  const staleRoot = await mkdtemp(join(tmpdir(), 'makewatch-shot-compile-stale-'));
  try {
    const staleBridge = bridge([snapshot(), snapshot(43, 10)]);
    const staleService = new ShotAnimCompilationService({
      projectRoot: staleRoot,
      bridge: staleBridge,
      compiler: async () => structuredClone(compilerResult),
    });
    await assert.rejects(() => staleService.compile('shot.1'), (error) => error.code === 'stale_request');
    assert.equal(staleBridge.applies.length, 0);
    const expectedPath = join(staleRoot, '.makewatch', 'artifacts', 'anime', 'shot-anim', 'shot.1');
    await assert.rejects(() => access(expectedPath), (error) => error.code === 'ENOENT');
  } finally {
    await rm(staleRoot, { recursive: true, force: true });
  }

  const failedRoot = await mkdtemp(join(tmpdir(), 'makewatch-shot-compile-failed-'));
  try {
    const failedBridge = bridge([snapshot(), snapshot()], { applyError: new Error('bridge rejected') });
    const failedService = new ShotAnimCompilationService({
      projectRoot: failedRoot,
      bridge: failedBridge,
      compiler: async () => structuredClone(compilerResult),
    });
    await assert.rejects(() => failedService.compile('shot.1'), /bridge rejected/);
    await assert.rejects(() => access(join(failedRoot, '.makewatch', 'artifacts', 'anime', 'shot-anim', 'shot.1')), (error) => error.code === 'ENOENT');
  } finally {
    await rm(failedRoot, { recursive: true, force: true });
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('shot anim compilation service checks passed');
