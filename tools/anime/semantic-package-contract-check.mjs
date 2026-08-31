import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  normalizeCharacterRigBuildInput,
  normalizeEnvironmentPackageBuildInput,
  resolveManagedSourceAsset,
  semanticPackageLimits,
} from './semantic-package-contract.mjs';

const rigInput = {
  characterId: 'character.aya',
  expectedRevision: 7,
  outfitState: 'school-uniform',
  states: [
    { id: 'face_base.DEFAULT', sourceAssetId: 'asset.face', pivot: [0.5, 0.55], z: 10 },
    { id: 'eyes_l.OPEN', sourceAssetId: 'asset.eye-open', pivot: [0.4, 0.4], z: 20 },
  ],
  validDomains: { headAngleX: [-12, 12] },
};
const rig = normalizeCharacterRigBuildInput(rigInput);
assert.equal(rig.states[0].semanticPart, 'face_base');
assert.equal(rig.validDomain.headAngleX[1], 12);
assert.throws(() => normalizeCharacterRigBuildInput({ ...rigInput, states: [rigInput.states[0], rigInput.states[0]] }), /duplicate state/i);
assert.throws(() => normalizeCharacterRigBuildInput({ ...rigInput, expectedRevision: -1 }), /revision/i);
assert.throws(() => normalizeCharacterRigBuildInput({ ...rigInput, states: [{ id: 'mystery.DEFAULT', sourceAssetId: 'asset.x' }] }), /unknown semantic state/i);
assert.throws(() => normalizeCharacterRigBuildInput({ ...rigInput, states: [{ ...rigInput.states[0], pivot: [0.5, 2] }] }), /pivot/i);

// M5 Task 3: optional skeleton + limb binding + validDomains.combined
assert.equal(rig.skeleton, null, 'dialogue-only build input has no skeleton');
assert.deepEqual(rig.validDomainCombined, []);
const limbInput = {
  ...rigInput,
  skeleton: { bones: [
    { id: 'hip', parent: null, rest: { x: 0, y: 0, rot: 0, len: 0 } },
    { id: 'upper_arm_r', parent: 'hip', rest: { x: 0, y: 0, rot: 0, len: 120 } },
  ] },
  states: [...rigInput.states, { id: 'upper_arm_r.NEUTRAL', sourceAssetId: 'asset.arm', parentBone: 'upper_arm_r', restAngleDeg: -12 }],
  validDomains: { headAngleX: [-12, 12], combined: [{ if: { upper_arm_r: ['>', 30] }, then: { upper_arm_r: [0, 45] } }] },
};
const limb = normalizeCharacterRigBuildInput(limbInput);
assert.equal(limb.skeleton.bones.length, 2);
assert.equal(limb.states.at(-1).parentBone, 'upper_arm_r');
assert.equal(limb.states.at(-1).restAngleDeg, -12);
assert.equal(limb.validDomainCombined.length, 1);
assert.ok(!('combined' in limb.validDomain));
assert.throws(() => normalizeCharacterRigBuildInput({ ...limbInput, skeleton: { bones: [
  { id: 'a', parent: 'b', rest: {} }, { id: 'b', parent: 'a', rest: {} },
] } }), /cycle|exactly one root/);
assert.throws(() => normalizeCharacterRigBuildInput({
  ...rigInput,
  states: [...rigInput.states, { id: 'upper_arm_r.NEUTRAL', sourceAssetId: 'asset.arm', parentBone: 'ghost' }],
  skeleton: limbInput.skeleton,
}), /not in the skeleton/);
assert.throws(() => normalizeCharacterRigBuildInput({
  ...rigInput,
  states: [...rigInput.states, { id: 'upper_arm_r.NEUTRAL', sourceAssetId: 'asset.arm', parentBone: 'upper_arm_r' }],
}), /no skeleton was supplied/);

const environment = normalizeEnvironmentPackageBuildInput({
  locationId: 'location.school',
  expectedRevision: 3,
  stateId: 'day-clear',
  plates: [
    { id: 'background', role: 'background', sourceAssetId: 'asset.bg', depth: 0.1 },
    { id: 'midground', role: 'midground', sourceAssetId: 'asset.mid', depth: 0.5 },
    { id: 'foreground', role: 'foreground', sourceAssetId: 'asset.fg', depth: 0.9 },
  ],
  occlusionMaskAssetId: 'asset.mask',
  cameraSafeBounds: { x: [0.1, 0.9], y: [0.05, 0.95] },
  lightingStates: ['day'],
  weatherStates: ['clear'],
});
assert.equal(environment.cameraSafeRegion.x[0], 0.1);
assert.throws(() => normalizeEnvironmentPackageBuildInput({ ...environment, plates: [environment.plates[0], environment.plates[0], environment.plates[2]] }), /duplicate plate/i);
assert.throws(() => normalizeEnvironmentPackageBuildInput({ ...environment, plates: [{ ...environment.plates[0], depth: Infinity }, environment.plates[1], environment.plates[2]] }), /depth/i);

const root = await mkdtemp(join(tmpdir(), 'makewatch-semantic-contract-'));
try {
  const directory = join(root, '.makewatch', 'artifacts', 'references');
  await mkdir(directory, { recursive: true });
  const bytes = Buffer.from('verified-image-fixture');
  const path = join(directory, 'source.png');
  await writeFile(path, bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const baseAsset = {
    id: 'asset.source', kind: 'asset', revision: 1, approval: 'approved', locked: false, stale: false,
    metadata: { mediaType: 'image', relativePath: 'artifacts/references/source.png', sha256 },
  };
  const snapshot = { nodes: [baseAsset], dependencies: [] };
  const resolved = await resolveManagedSourceAsset(snapshot, root, 'asset.source', 'image');
  assert.equal(resolved.sha256, sha256);
  assert.equal(resolved.byteSize, bytes.length);
  assert.equal('bytes' in resolved, false);
  await assert.rejects(
    resolveManagedSourceAsset({ ...snapshot, nodes: [{ ...baseAsset, metadata: { ...baseAsset.metadata, relativePath: '../outside.png' } }] }, root, 'asset.source', 'image'),
    /unsafe|escape|traversal/i,
  );
  await assert.rejects(
    resolveManagedSourceAsset({ ...snapshot, nodes: [{ ...baseAsset, metadata: { ...baseAsset.metadata, mediaType: 'audio' } }] }, root, 'asset.source', 'image'),
    /mediaType/i,
  );
  await assert.rejects(
    resolveManagedSourceAsset({ ...snapshot, nodes: [{ ...baseAsset, metadata: { ...baseAsset.metadata, sha256: '0'.repeat(64) } }] }, root, 'asset.source', 'image'),
    /SHA-256/i,
  );
  assert.ok(semanticPackageLimits.maxSourceBytes >= bytes.length);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('semantic package contract check: passed');
