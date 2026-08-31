import assert from 'node:assert/strict';

import {
  nativeAnimeAssetSchemas,
  validateAlignmentAsset,
  validateAnimeAcceptanceReport,
  validateAnimeQcReport,
  validateCharacterRig,
  validateEnvironmentPackage,
} from './native-anime-asset-contracts.mjs';

const sha = (letter) => letter.repeat(64);
const state = (id, semanticPart, hash = sha('a')) => ({
  id,
  semanticPart,
  imageAssetId: `asset.${id.replaceAll('.', '-')}`,
  imageSha256: hash,
  path: `artifacts/anime/rig/${id}.png`,
  pivot: [0.5, 0.5],
  z: 10,
});

const validRig = {
  schema: 'makewatch.characterRig/1',
  characterId: 'character.aya',
  characterRevision: 7,
  outfitState: 'school-uniform',
  paletteFingerprint: sha('f'),
  canvas: { width: 2048, height: 2048 },
  states: [
    state('body.DEFAULT', 'body'),
    state('face_base.DEFAULT', 'face_base'),
    state('eyes_l.OPEN', 'eyes_l'), state('eyes_l.HALF', 'eyes_l'), state('eyes_l.CLOSED', 'eyes_l'),
    state('eyes_r.OPEN', 'eyes_r'), state('eyes_r.HALF', 'eyes_r'), state('eyes_r.CLOSED', 'eyes_r'),
    ...['CLOSED', 'SMALL', 'A', 'I', 'U', 'E', 'O', 'WIDE'].map((name) => state(`mouth.${name}`, 'mouth')),
    state('front_hair.DEFAULT', 'front_hair'),
    state('rear_hair.DEFAULT', 'rear_hair'),
  ],
  validDomain: { headAngleX: [-24, 24], headAngleY: [-16, 16], headAngleZ: [-14, 14] },
};

const validEnvironment = {
  schema: 'makewatch.environmentPackage/1',
  locationId: 'location.cafe',
  locationRevision: 4,
  canvas: { width: 3072, height: 1728 },
  plates: [
    { id: 'background', role: 'background', imageAssetId: 'asset.bg', imageSha256: sha('b'), path: 'artifacts/anime/environment/bg.png', depth: 0.1 },
    { id: 'midground', role: 'midground', imageAssetId: 'asset.mid', imageSha256: sha('c'), path: 'artifacts/anime/environment/mid.png', depth: 0.5 },
    { id: 'foreground', role: 'foreground', imageAssetId: 'asset.fg', imageSha256: sha('d'), path: 'artifacts/anime/environment/fg.png', depth: 0.9 },
  ],
  occlusionMaskAssetId: 'asset.mask',
  occlusionMaskSha256: sha('e'),
  cameraSafeRegion: { x: [0.05, 0.95], y: [0.05, 0.9] },
  lightingStates: ['day', 'night'],
  weatherStates: ['clear', 'rain'],
};

const validAlignment = {
  schema: 'makewatch.alignment/1',
  dialogueUnitId: 'audio.dialogue.aya.001',
  language: 'ja-JP',
  transcript: 'もっと早く。',
  audioAssetId: 'asset.audio',
  audioSha256: sha('a'),
  provider: { id: 'fixture', version: '1' },
  normalization: 'makewatch.ja/1',
  sampleRate: 48000,
  speechStartSample: 1200,
  speechEndSample: 24000,
  confidence: 0.93,
  warnings: [],
  tokens: [
    { text: 'もっと', readingKana: 'モット', startSample: 1200, endSample: 9600, confidence: 0.94 },
    { text: '早く', readingKana: 'ハヤク', startSample: 9600, endSample: 22000, confidence: 0.92 },
  ],
};

const validQc = {
  schema: 'makewatch.animeQcReport/1',
  shotId: 'shot.001',
  videoAssetId: 'asset.video',
  passed: true,
  promoted: false,
  thresholds: { freezeRatioMax: 0.35 },
  checks: [{ id: 'freeze-ratio', passed: true, value: 0.1 }],
  sampledFrames: [{ frame: 12, sha256: sha('9') }],
  failures: [],
};

const validAcceptance = {
  schema: 'makewatch.animeAcceptanceReport/1',
  episodeId: 'episode.acceptance.001',
  finalAssetId: 'asset.episode',
  finalSha256: sha('8'),
  passed: false,
  gates: [{ id: 'visual-watch-through', state: 'needs_human_review' }],
  jobs: [],
  artifacts: ['asset.episode'],
  runtime: { wallSeconds: 120 },
  storage: { persistentBytes: 1000, scratchBytesAfter: 0 },
  defects: [],
};

assert.deepEqual(nativeAnimeAssetSchemas, {
  characterRig: 'makewatch.characterRig/1',
  environmentPackage: 'makewatch.environmentPackage/1',
  alignment: 'makewatch.alignment/1',
  qcReport: 'makewatch.animeQcReport/1',
  acceptanceReport: 'makewatch.animeAcceptanceReport/1',
});

assert.equal(validateCharacterRig(validRig).states.length, 18);
assert.equal(validateEnvironmentPackage(validEnvironment).plates.length, 3);
assert.equal(validateAlignmentAsset(validAlignment).audioSha256, sha('a'));
assert.equal(validateAnimeQcReport(validQc).checks[0].id, 'freeze-ratio');
assert.equal(validateAnimeAcceptanceReport(validAcceptance).storage.scratchBytesAfter, 0);

assert.throws(() => validateCharacterRig({ ...validRig, states: [] }), /semantic states/i);
assert.throws(() => validateCharacterRig({ ...validRig, states: [...validRig.states, validRig.states[0]] }), /unique/i);
assert.throws(() => validateCharacterRig({ ...validRig, states: validRig.states.filter(({ id }) => id !== 'mouth.CLOSED') }), /mouth\.CLOSED/);
assert.throws(() => validateCharacterRig({ ...validRig, paletteFingerprint: 'bad' }), /SHA-256/);
assert.throws(() => validateEnvironmentPackage({ ...validEnvironment, plates: validEnvironment.plates.slice(0, 2) }), /background.*midground.*foreground/i);
assert.throws(() => validateEnvironmentPackage({ ...validEnvironment, plates: [validEnvironment.plates[0], validEnvironment.plates[0], validEnvironment.plates[2]] }), /unique/i);
assert.throws(() => validateAlignmentAsset({ ...validAlignment, audioSha256: 'bad' }), /SHA-256/);
assert.throws(() => validateAlignmentAsset({ ...validAlignment, tokens: [...validAlignment.tokens].reverse() }), /sorted/i);
assert.throws(() => validateAnimeQcReport({ ...validQc, passed: true, failures: ['face seam'] }), /passing.*failures/i);
assert.throws(() => validateAnimeAcceptanceReport({ ...validAcceptance, passed: true }), /passed.*gate/i);

assert.ok(Object.isFrozen(validateCharacterRig(validRig)));
assert.ok(Object.isFrozen(validateCharacterRig(validRig).states));

// --- M5 Task 3: optional skeleton + limb states + validDomain.combined ---
assert.equal(validateCharacterRig(validRig).skeleton, null, 'dialogue-only rig has no skeleton');
assert.deepEqual(validateCharacterRig(validRig).validDomainCombined, [], 'no combined rules by default');

const armSkeleton = {
  bones: [
    { id: 'hip', parent: null, rest: { x: 0, y: 0, rot: 0, len: 0 } },
    { id: 'upper_arm_r', parent: 'hip', rest: { x: 0, y: 0, rot: 0, len: 120 } },
    { id: 'forearm_r', parent: 'upper_arm_r', rest: { x: 120, y: 0, rot: 0, len: 110 } },
  ],
};
const limbRig = {
  ...validRig,
  skeleton: armSkeleton,
  states: [...validRig.states, { ...state('upper_arm_r.NEUTRAL', 'upper_arm_r'), parentBone: 'upper_arm_r', restAngleDeg: -12 }],
  validDomain: {
    ...validRig.validDomain,
    upper_arm_r: [-150, 40],
    combined: [{ if: { forearm_r: ['<', -10] }, then: { upper_arm_r: [-90, 0] } }],
  },
};
const builtLimb = validateCharacterRig(limbRig);
assert.equal(builtLimb.skeleton.bones.length, 3);
assert.equal(builtLimb.skeleton.bones[0].id, 'hip', 'skeleton emitted parents-first');
assert.equal(builtLimb.states.at(-1).parentBone, 'upper_arm_r');
assert.equal(builtLimb.states.at(-1).restAngleDeg, -12);
assert.equal(builtLimb.validDomainCombined.length, 1, 'combined rule parsed, not skipped');
assert.deepEqual(builtLimb.validDomainCombined[0].if.forearm_r, ['<', -10]);
assert.deepEqual(builtLimb.validDomainCombined[0].then.upper_arm_r, [-90, 0]);
assert.ok(!('combined' in builtLimb.validDomain), 'combined split out of validDomain');

assert.throws(
  () => validateCharacterRig({ ...limbRig, states: [...validRig.states, { ...state('upper_arm_r.NEUTRAL', 'upper_arm_r'), parentBone: 'tail' }] }),
  /parentBone .*not in the skeleton/,
);
assert.throws(
  () => validateCharacterRig({ ...validRig, states: [...validRig.states, { ...state('upper_arm_r.NEUTRAL', 'upper_arm_r'), parentBone: 'upper_arm_r' }] }),
  /carries no skeleton/,
);
assert.throws(
  () => validateCharacterRig({ ...validRig, skeleton: { bones: [{ id: 'a', parent: 'b', rest: {} }, { id: 'b', parent: 'a', rest: {} }] } }),
  /cycle|exactly one root/,
);
assert.throws(
  () => validateCharacterRig({ ...validRig, validDomain: { ...validRig.validDomain, combined: [{ if: { forearm_r: ['~', 1] }, then: { upper_arm_r: [0, 1] } }] } }),
  /\[op, number\]/,
);

console.log('native anime asset contract checks passed');
