import assert from 'node:assert/strict';

import {
  buildTemporalShotRequest,
  parseReferenceAssetIds,
  planTemporalSegments,
  temporalResourcePolicy,
  temporalShotContract,
} from './temporal-shot-contract.mjs';

function node(id, kind, metadata = {}, extra = {}) {
  return {
    id,
    kind,
    title: id,
    revision: extra.revision ?? 1,
    approval: extra.approval ?? 'approved',
    locked: extra.locked ?? false,
    stale: extra.stale ?? false,
    metadata,
  };
}

const snapshot = {
  projectRevision: 42,
  nodes: [
    node('series.1', 'series'),
    node('episode.1', 'episode'),
    node('scene.1', 'scene'),
    node('character.alex', 'character', {
      continuityPolicy: 'require-reference',
      canonicalImageAssetIds: '["asset.face","asset.face","missing"]',
    }),
    node('location.room', 'location', {
      acceptedReferenceAssetIds: 'asset.room\nasset.room.alt',
    }),
    node('shot.1', 'shot', {
      durationSeconds: '11',
      generationStrategy: 'I2V',
      qualityTier: 'preview',
      continuityPriority: 'critical',
      motionLevel: 'medium',
      subjectAction: 'Alex crosses the room and stops by the window.',
    }, { revision: 7 }),
    node('generation.hero', 'generation', { status: 'ready', mediaType: 'image' }, { revision: 5 }),
    node('asset.hero', 'asset', { mediaType: 'image', relativePath: 'artifacts/hero.png', sha256: 'hero' }),
    node('asset.face', 'asset', { mediaType: 'image', relativePath: 'artifacts/face.png', sha256: 'face' }),
    node('asset.room', 'asset', { mediaType: 'image', relativePath: 'artifacts/room.png', sha256: 'room' }),
    node('asset.room.alt', 'asset', { mediaType: 'image', relativePath: 'artifacts/room-alt.png', sha256: 'room-alt' }),
  ],
  dependencies: [
    { dependent: 'episode.1', dependency: 'series.1' },
    { dependent: 'scene.1', dependency: 'episode.1' },
    { dependent: 'shot.1', dependency: 'scene.1' },
    { dependent: 'shot.1', dependency: 'character.alex' },
    { dependent: 'shot.1', dependency: 'location.room' },
    { dependent: 'generation.hero', dependency: 'shot.1' },
    { dependent: 'asset.hero', dependency: 'generation.hero' },
  ],
};

assert.deepEqual(temporalShotContract.strategies, ['I2V', 'FLF2V', 'VIDEO']);
assert.equal(temporalShotContract.stillImageFallbackAllowed, false);
assert.deepEqual(parseReferenceAssetIds('a,b\na; b'), ['a', 'b']);
assert.deepEqual(parseReferenceAssetIds('["a","b","a"]'), ['a', 'b']);
assert.deepEqual(planTemporalSegments(11, 6).map((segment) => segment.durationSeconds), [6, 5]);

const request = buildTemporalShotRequest(snapshot, 'shot.1', { totalVramMb: 8192 });
assert.equal(request.schemaVersion, 2);
assert.equal(request.shot.strategy, 'I2V');
assert.equal(request.inputs.startFrame.id, 'asset.hero');
assert.equal(request.inputs.characters[0].references[0].id, 'asset.face');
assert.deepEqual(request.inputs.locations[0].references.map((asset) => asset.id), ['asset.room', 'asset.room.alt']);
assert.equal(request.inputs.referenceAssets.length, 3);
assert.deepEqual(request.segments.map((segment) => segment.inputFramePolicy), ['hero-frame', 'previous-tail-frame']);
assert.equal(request.resourcePolicy.exclusiveGpu, true);
assert.equal(request.resourcePolicy.releaseOtherGpuModelsBeforeLaunch, true);
assert.equal(request.providerContract.mustReturnMediaType, 'video');
assert.equal(request.providerContract.tailFrameHandoffRequired, true);
assert.equal(request.providerContract.stillImageFallbackAllowed, false);

const eightGb = temporalResourcePolicy({ qualityTier: 'preview', totalVramMb: 8192 });
assert.equal(eightGb.reserveVramMb, 1536);
assert.equal(eightGb.usableVramMb, 6656);

const flf = structuredClone(snapshot);
flf.nodes = flf.nodes.map((candidate) => candidate.id === 'shot.1'
  ? { ...candidate, metadata: { ...candidate.metadata, generationStrategy: 'FLF2V', endFrameAssetId: 'asset.face' } }
  : candidate);
assert.equal(buildTemporalShotRequest(flf, 'shot.1').inputs.endFrame.id, 'asset.face');

const missingEnd = structuredClone(snapshot);
missingEnd.nodes = missingEnd.nodes.map((candidate) => candidate.id === 'shot.1'
  ? { ...candidate, metadata: { ...candidate.metadata, generationStrategy: 'FLF2V' } }
  : candidate);
assert.throws(() => buildTemporalShotRequest(missingEnd, 'shot.1'), /endFrameAssetId/);

for (const legacy of ['STILL_MOTION', 'T2I', 'COMPOSITE']) {
  const old = structuredClone(snapshot);
  old.nodes = old.nodes.map((candidate) => candidate.id === 'shot.1'
    ? { ...candidate, metadata: { ...candidate.metadata, generationStrategy: legacy } }
    : candidate);
  assert.throws(
    () => buildTemporalShotRequest(old, 'shot.1'),
    /still-image output strategies were removed/,
    `${legacy} must not re-enter final Shot synthesis`,
  );
}

console.log('temporal-only shot contract checks passed');
