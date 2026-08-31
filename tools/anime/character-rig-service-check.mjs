import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CharacterRigService } from './character-rig-service.mjs';

const WORKER = join(process.cwd(), 'tools/anime/semantic-package-worker.py');
const EYE_STATES = ['OPEN', 'HALF', 'CLOSED'];
const MOUTH_STATES = ['CLOSED', 'SMALL', 'A', 'I', 'U', 'E', 'O', 'WIDE'];

function requiredStateIds() {
  return [
    'face_base.DEFAULT', 'body.DEFAULT', 'front_hair.DEFAULT', 'rear_hair.DEFAULT',
    ...['eyes_l', 'eyes_r'].flatMap((side) => EYE_STATES.map((s) => `${side}.${s}`)),
    ...MOUTH_STATES.map((s) => `mouth.${s}`),
  ];
}

function makeBridge(graph) {
  const state = structuredClone(graph);
  const applies = [];
  return {
    applies,
    peek: () => structuredClone(state),
    async snapshot() { return structuredClone(state); },
    async apply(commands, context, expectedProjectRevision) {
      applies.push({ commands, context, expectedProjectRevision });
      for (const command of commands) {
        if (command.type === 'node.create') {
          state.nodes.push({ revision: 0, ...structuredClone(command.node) });
        } else if (command.type === 'node.markFresh') {
          const node = state.nodes.find((n) => n.id === command.id);
          if (node) node.stale = false;
        } else if (command.type === 'node.patch') {
          const node = state.nodes.find((n) => n.id === command.id);
          if (!node) continue;
          if (command.approval) node.approval = command.approval;
          if (command.metadataUpdates) node.metadata = { ...node.metadata, ...command.metadataUpdates };
          node.revision += 1; // real bridge bumps the patched node
        } else if (command.type === 'dependency.add') {
          if (!state.dependencies.some((e) => e.dependent === command.dependent && e.dependency === command.dependency)) {
            state.dependencies.push({ dependent: command.dependent, dependency: command.dependency });
          }
        }
      }
      state.projectRevision += 1;
      return { projectRevision: state.projectRevision };
    },
  };
}

async function writeSourceAsset(root, id, semanticState) {
  const bytes = Buffer.from(`png-${id}`);
  const rel = `artifacts/references/${semanticState}.png`;
  const path = join(root, '.makewatch', 'artifacts', 'references', `${semanticState}.png`);
  await writeFile(path, bytes);
  return {
    id, kind: 'asset', revision: 1, approval: 'approved', locked: false, stale: false,
    metadata: { mediaType: 'image', relativePath: rel, sha256: createHash('sha256').update(bytes).digest('hex'), semanticState },
  };
}

async function baseGraph(root, { includeStates = requiredStateIds() } = {}) {
  await mkdir(join(root, '.makewatch', 'artifacts', 'references'), { recursive: true });
  const character = {
    id: 'character.aya', kind: 'character', title: 'Aya', revision: 7,
    approval: 'approved', locked: false, stale: false, metadata: { outfitState: 'school-uniform' },
  };
  const nodes = [character];
  const dependencies = [];
  for (const stateId of includeStates) {
    const asset = await writeSourceAsset(root, `asset.src.${stateId}`, stateId);
    nodes.push(asset);
    dependencies.push({ dependent: character.id, dependency: asset.id });
  }
  return { schemaVersion: 1, projectRevision: 100, nodes, dependencies };
}

function buildInput(overrides = {}) {
  const states = requiredStateIds().map((id, index) => ({
    id, sourceAssetId: `asset.src.${id}`, pivot: [0.5, 0.5], z: index,
  }));
  return {
    characterId: 'character.aya',
    expectedRevision: 7,
    outfitState: 'school-uniform',
    states,
    validDomains: { headAngleX: [-18, 18] },
    canvas: { width: 512, height: 512 },
    ...overrides,
  };
}

const passingQc = async (_py, _worker, request) => ({
  operation: 'character', passed: true,
  checks: [{ id: 'face_base_exclusion', passed: true, value: 0.01 }],
  findings: [], contactSheet: request.contactSheet,
});
const failingQc = async (_py, _worker, request) => ({
  operation: 'character', passed: false,
  checks: [{ id: 'face_base_exclusion', passed: false, value: 0.41 }],
  findings: ['face_base_exclusion: face_base paints the eye/mouth region'], contactSheet: request.contactSheet,
});

const root = await mkdtemp(join(tmpdir(), 'makewatch-rig-service-'));
try {
  {
    const partial = requiredStateIds().filter((s) => s !== 'mouth.A' && s !== 'mouth.CLOSED');
    const graph = await baseGraph(root, { includeStates: partial });
    const service = new CharacterRigService({ bridge: makeBridge(graph), projectRoot: root, workerPath: WORKER, qcRunner: passingQc });
    const plan = await service.plan({ characterId: 'character.aya', outfitState: 'school-uniform' });
    assert.deepEqual(plan.missingStates, ['mouth.A', 'mouth.CLOSED']);
    assert.equal(plan.reusableRigs.length, 0);
    assert.equal(plan.blockers.length, 0);
  }

  {
    const bridge = makeBridge(await baseGraph(root));
    const service = new CharacterRigService({ bridge, projectRoot: root, workerPath: WORKER, qcRunner: passingQc });
    const { job } = await service.build(buildInput());
    assert.equal(job.status, 'queued');
    await service.waitForIdle();
    const done = service.job(job.id);
    assert.equal(done.status, 'completed', done.error);
    assert.match(done.rigAssetId, /^asset\.[a-f0-9]{24}$/);

    let snap = bridge.peek();
    const rigNode = snap.nodes.find((n) => n.id === done.rigAssetId);
    assert.equal(rigNode.approval, 'draft');
    assert.equal(rigNode.metadata.schema, 'makewatch.characterRig/1');
    assert.ok(!snap.dependencies.some((e) => e.dependent === 'character.aya' && e.dependency === done.rigAssetId));

    const noPromote = await service.validate({ rigAssetId: done.rigAssetId, expectedCharacterRevision: 7, promote: false });
    assert.equal(noPromote.passed, true);
    assert.equal(noPromote.promoted, false);
    assert.equal(bridge.peek().nodes.find((n) => n.id === done.rigAssetId).approval, 'draft');

    const promoted = await service.validate({ rigAssetId: done.rigAssetId, expectedCharacterRevision: 7, promote: true });
    assert.equal(promoted.passed, true);
    assert.equal(promoted.promoted, true);
    snap = bridge.peek();
    assert.equal(snap.nodes.find((n) => n.id === done.rigAssetId).approval, 'approved');
    assert.ok(snap.dependencies.some((e) => e.dependent === 'character.aya' && e.dependency === done.rigAssetId));
    assert.deepEqual(JSON.parse(snap.nodes.find((n) => n.id === 'character.aya').metadata.characterRigAssetIds), [done.rigAssetId]);
  }

  {
    const bridge = makeBridge(await baseGraph(root));
    const service = new CharacterRigService({ bridge, projectRoot: root, workerPath: WORKER, qcRunner: failingQc });
    const { job } = await service.build(buildInput());
    await service.waitForIdle();
    const rigAssetId = service.job(job.id).rigAssetId;
    const result = await service.validate({ rigAssetId, expectedCharacterRevision: 7, promote: true });
    assert.equal(result.passed, false);
    assert.equal(result.promoted, false);
    assert.ok(result.findings.length > 0);
    assert.equal(bridge.peek().nodes.find((n) => n.id === rigAssetId).approval, 'draft');
  }

  {
    const service = new CharacterRigService({ bridge: makeBridge(await baseGraph(root)), projectRoot: root, workerPath: WORKER, qcRunner: passingQc });
    await assert.rejects(() => service.build(buildInput({ expectedRevision: 6 })), (e) => e.code === 'stale_request');
  }

  {
    const graph = await baseGraph(root);
    graph.nodes.find((n) => n.id === 'character.aya').locked = true;
    const service = new CharacterRigService({ bridge: makeBridge(graph), projectRoot: root, workerPath: WORKER, qcRunner: passingQc });
    await assert.rejects(() => service.build(buildInput()), (e) => e.code === 'locked');
  }

  {
    const service = new CharacterRigService({ bridge: makeBridge(await baseGraph(root)), projectRoot: root, workerPath: WORKER, qcRunner: passingQc });
    const bad = buildInput();
    bad.states = bad.states.filter((s) => s.id !== 'eyes_r.HALF');
    await assert.rejects(() => service.build(bad), (e) => e.code === 'invalid_argument' && /eyes_r\.HALF/.test(e.message));
  }

  {
    const bridge = makeBridge(await baseGraph(root));
    const service = new CharacterRigService({ bridge, projectRoot: root, workerPath: WORKER, qcRunner: passingQc });
    const { job } = await service.build(buildInput());
    const cancelled = await service.cancel(job.id);
    assert.equal(cancelled.status, 'cancelled');
    await service.waitForIdle();
    assert.equal(service.job(job.id).status, 'cancelled');
    assert.ok(!bridge.peek().nodes.some((n) => n.metadata?.schema === 'makewatch.characterRig/1'));
  }

  console.log('character rig service checks passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
