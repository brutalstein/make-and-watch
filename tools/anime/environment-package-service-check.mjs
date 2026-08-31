import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EnvironmentPackageService } from './environment-package-service.mjs';

const WORKER = join(process.cwd(), 'tools/anime/semantic-package-worker.py');
const PLATES = [
  { role: 'background', depth: 0.1 },
  { role: 'midground', depth: 0.5 },
  { role: 'foreground', depth: 0.9 },
];

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
          node.revision += 1;
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

async function writeImageAsset(root, id, name, plateRole) {
  const bytes = Buffer.from(`png-${id}`);
  const rel = `artifacts/plates/${name}.png`;
  await writeFile(join(root, '.makewatch', 'artifacts', 'plates', `${name}.png`), bytes);
  return {
    id, kind: 'asset', revision: 1, approval: 'approved', locked: false, stale: false,
    metadata: { mediaType: 'image', relativePath: rel, sha256: createHash('sha256').update(bytes).digest('hex'), ...(plateRole ? { plateRole } : {}) },
  };
}

async function baseGraph(root) {
  await mkdir(join(root, '.makewatch', 'artifacts', 'plates'), { recursive: true });
  const location = {
    id: 'location.street', kind: 'location', title: 'Rainy Street', revision: 3,
    approval: 'approved', locked: false, stale: false, metadata: {},
  };
  const nodes = [location];
  const dependencies = [];
  for (const plate of PLATES) {
    const asset = await writeImageAsset(root, `asset.plate.${plate.role}`, plate.role, plate.role);
    nodes.push(asset);
    dependencies.push({ dependent: location.id, dependency: asset.id });
  }
  const mask = await writeImageAsset(root, 'asset.occlusion', 'occlusion');
  nodes.push(mask);
  dependencies.push({ dependent: location.id, dependency: mask.id });
  return { schemaVersion: 1, projectRevision: 200, nodes, dependencies };
}

function buildInput(overrides = {}) {
  return {
    locationId: 'location.street',
    expectedRevision: 3,
    stateId: 'night-rain',
    plates: PLATES.map((plate) => ({ id: `plate.${plate.role}`, role: plate.role, sourceAssetId: `asset.plate.${plate.role}`, depth: plate.depth })),
    occlusionMaskAssetId: 'asset.occlusion',
    cameraSafeBounds: { x: [0.06, 0.94], y: [0.06, 0.94] },
    lightingStates: ['night'],
    weatherStates: ['rain'],
    canvas: { width: 1280, height: 720 },
    ...overrides,
  };
}

const passingQc = async (_py, _worker, request) => ({
  operation: 'environment', passed: true,
  checks: [{ id: 'parallax_exposure', passed: true, value: 0 }],
  findings: [], contactSheet: request.contactSheet,
});
const failingQc = async (_py, _worker, request) => ({
  operation: 'environment', passed: false,
  checks: [{ id: 'parallax_exposure', passed: false, value: 0.03 }],
  findings: ['parallax_exposure: worst-case camera pan exposes 0.03 of the safe frame'], contactSheet: request.contactSheet,
});

const root = await mkdtemp(join(tmpdir(), 'makewatch-env-service-'));
try {
  {
    const service = new EnvironmentPackageService({ bridge: makeBridge(await baseGraph(root)), projectRoot: root, workerPath: WORKER, qcRunner: passingQc });
    const plan = await service.plan({ locationId: 'location.street', stateId: 'night-rain' });
    assert.deepEqual(plan.missingPlates, []);
    assert.equal(plan.reusablePackages.length, 0);
  }

  {
    const bridge = makeBridge(await baseGraph(root));
    const service = new EnvironmentPackageService({ bridge, projectRoot: root, workerPath: WORKER, qcRunner: passingQc });
    const { job } = await service.build(buildInput());
    assert.equal(job.status, 'queued');
    await service.waitForIdle();
    const done = service.job(job.id);
    assert.equal(done.status, 'completed', done.error);
    assert.match(done.packageAssetId, /^asset\.[a-f0-9]{24}$/);

    let snap = bridge.peek();
    assert.equal(snap.nodes.find((n) => n.id === done.packageAssetId).approval, 'draft');
    assert.ok(!snap.dependencies.some((e) => e.dependent === 'location.street' && e.dependency === done.packageAssetId));

    const noPromote = await service.validate({ packageAssetId: done.packageAssetId, expectedLocationRevision: 3, promote: false });
    assert.equal(noPromote.promoted, false);
    assert.equal(bridge.peek().nodes.find((n) => n.id === done.packageAssetId).approval, 'draft');

    const promoted = await service.validate({ packageAssetId: done.packageAssetId, expectedLocationRevision: 3, promote: true });
    assert.equal(promoted.passed, true);
    assert.equal(promoted.promoted, true);
    snap = bridge.peek();
    assert.equal(snap.nodes.find((n) => n.id === done.packageAssetId).approval, 'approved');
    assert.ok(snap.dependencies.some((e) => e.dependent === 'location.street' && e.dependency === done.packageAssetId));
    assert.deepEqual(JSON.parse(snap.nodes.find((n) => n.id === 'location.street').metadata.environmentPackageAssetIds), [done.packageAssetId]);
  }

  {
    const bridge = makeBridge(await baseGraph(root));
    const service = new EnvironmentPackageService({ bridge, projectRoot: root, workerPath: WORKER, qcRunner: failingQc });
    const { job } = await service.build(buildInput());
    await service.waitForIdle();
    const packageAssetId = service.job(job.id).packageAssetId;
    const result = await service.validate({ packageAssetId, expectedLocationRevision: 3, promote: true });
    assert.equal(result.passed, false);
    assert.equal(result.promoted, false);
    assert.equal(bridge.peek().nodes.find((n) => n.id === packageAssetId).approval, 'draft');
  }

  {
    const service = new EnvironmentPackageService({ bridge: makeBridge(await baseGraph(root)), projectRoot: root, workerPath: WORKER, qcRunner: passingQc });
    await assert.rejects(() => service.build(buildInput({ expectedRevision: 2 })), (e) => e.code === 'stale_request');
  }

  {
    const graph = await baseGraph(root);
    graph.nodes.find((n) => n.id === 'location.street').locked = true;
    const service = new EnvironmentPackageService({ bridge: makeBridge(graph), projectRoot: root, workerPath: WORKER, qcRunner: passingQc });
    await assert.rejects(() => service.build(buildInput()), (e) => e.code === 'locked');
  }

  {
    const service = new EnvironmentPackageService({ bridge: makeBridge(await baseGraph(root)), projectRoot: root, workerPath: WORKER, qcRunner: passingQc });
    const bad = buildInput();
    bad.plates = [bad.plates[0], bad.plates[1]];
    await assert.rejects(() => service.build(bad), (e) => e.code === 'invalid_argument');
  }

  {
    const bridge = makeBridge(await baseGraph(root));
    const service = new EnvironmentPackageService({ bridge, projectRoot: root, workerPath: WORKER, qcRunner: passingQc });
    const { job } = await service.build(buildInput());
    const cancelled = await service.cancel(job.id);
    assert.equal(cancelled.status, 'cancelled');
    await service.waitForIdle();
    assert.ok(!bridge.peek().nodes.some((n) => n.metadata?.schema === 'makewatch.environmentPackage/1'));
  }

  console.log('environment package service checks passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
