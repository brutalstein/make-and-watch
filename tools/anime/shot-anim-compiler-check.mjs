import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildShotAnimRequest, planShotAnim } from './shot-anim-compiler.mjs';

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

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = (value) => Buffer.from(JSON.stringify(value, null, 2), 'utf8');

async function fixture({ mutateRig, alignmentAudioSha, shotMetadata = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'makewatch-shot-anim-'));
  const mediaRoot = join(root, '.makewatch');
  await mkdir(join(mediaRoot, 'artifacts', 'anime'), { recursive: true });

  const charBytes = Buffer.from('character-state-fixture');
  const bgBytes = Buffer.from('background-fixture');
  const midBytes = Buffer.from('midground-fixture');
  const fgBytes = Buffer.from('foreground-fixture');
  const maskBytes = Buffer.from('occlusion-fixture');
  const audioBytes = Buffer.from('wave-fixture');
  const state = (id, semanticPart) => ({
    id,
    semanticPart,
    imageAssetId: 'asset.character-state',
    imageSha256: hash(charBytes),
    path: 'artifacts/anime/character.png',
    pivot: [0.5, 0.5],
    z: 10,
  });
  let rig = {
    schema: 'makewatch.characterRig/1',
    characterId: 'character.aya',
    characterRevision: 7,
    outfitState: 'school-uniform',
    paletteFingerprint: 'f'.repeat(64),
    canvas: { width: 2048, height: 2048 },
    states: [
      state('body.DEFAULT', 'body'), state('face_base.DEFAULT', 'face_base'),
      state('eyes_l.OPEN', 'eyes_l'), state('eyes_l.HALF', 'eyes_l'), state('eyes_l.CLOSED', 'eyes_l'),
      state('eyes_r.OPEN', 'eyes_r'), state('eyes_r.HALF', 'eyes_r'), state('eyes_r.CLOSED', 'eyes_r'),
      ...['CLOSED', 'SMALL', 'A', 'I', 'U', 'E', 'O', 'WIDE'].map((name) => state(`mouth.${name}`, 'mouth')),
      state('front_hair.DEFAULT', 'front_hair'), state('rear_hair.DEFAULT', 'rear_hair'),
    ],
    validDomain: { headAngleX: [-24, 24], headAngleY: [-16, 16], headAngleZ: [-14, 14] },
  };
  if (mutateRig) rig = mutateRig(structuredClone(rig));

  const environment = {
    schema: 'makewatch.environmentPackage/1',
    locationId: 'location.cafe',
    locationRevision: 4,
    canvas: { width: 1920, height: 1080 },
    plates: [
      { id: 'background', role: 'background', imageAssetId: 'asset.bg', imageSha256: hash(bgBytes), path: 'artifacts/anime/bg.png', depth: 0.1 },
      { id: 'midground', role: 'midground', imageAssetId: 'asset.mid', imageSha256: hash(midBytes), path: 'artifacts/anime/mid.png', depth: 0.5 },
      { id: 'foreground', role: 'foreground', imageAssetId: 'asset.fg', imageSha256: hash(fgBytes), path: 'artifacts/anime/fg.png', depth: 0.9 },
    ],
    occlusionMaskAssetId: 'asset.mask',
    occlusionMaskSha256: hash(maskBytes),
    cameraSafeRegion: { x: [0.05, 0.95], y: [0.05, 0.9] },
    lightingStates: ['night'],
    weatherStates: ['rain'],
  };
  const alignment = {
    schema: 'makewatch.alignment/1',
    dialogueUnitId: 'audio.dialogue.aya.001',
    language: 'ja-JP',
    transcript: 'もっと早く。',
    audioAssetId: 'asset.audio',
    audioSha256: alignmentAudioSha ?? hash(audioBytes),
    provider: { id: 'fixture', version: '1' },
    normalization: 'makewatch.ja/1',
    sampleRate: 48000,
    speechStartSample: 1200,
    speechEndSample: 24000,
    confidence: 0.93,
    warnings: [],
    tokens: [{ text: 'もっと', readingKana: 'モット', startSample: 1200, endSample: 22000, confidence: 0.93 }],
  };

  const files = new Map([
    ['artifacts/anime/character.png', charBytes],
    ['artifacts/anime/bg.png', bgBytes],
    ['artifacts/anime/mid.png', midBytes],
    ['artifacts/anime/fg.png', fgBytes],
    ['artifacts/anime/mask.png', maskBytes],
    ['artifacts/anime/line.wav', audioBytes],
    ['artifacts/anime/rig.json', jsonBytes(rig)],
    ['artifacts/anime/environment.json', jsonBytes(environment)],
    ['artifacts/anime/alignment.json', jsonBytes(alignment)],
  ]);
  for (const [relativePath, bytes] of files) {
    const absolute = join(mediaRoot, ...relativePath.split('/'));
    await mkdir(join(absolute, '..'), { recursive: true });
    await writeFile(absolute, bytes);
  }

  const asset = (id, mediaType, relativePath, bytes, role) => node(id, 'asset', {
    mediaType,
    role,
    relativePath,
    sha256: hash(bytes),
  });
  const nodes = [
    node('scene.1', 'scene'),
    node('shot.1', 'shot', {
      durationSeconds: '4', generationStrategy: 'I2V', fps: '24', width: '1920', height: '1080',
      characterRigAssetIds: '["asset.rig"]',
      environmentPackageAssetId: 'asset.environment',
      dialogueAudioAssetIds: '{"audio.dialogue.aya.001":"asset.audio"}',
      alignmentAssetIds: '{"audio.dialogue.aya.001":"asset.alignment"}',
      actingCurves: '{"headAngleX":[{"t":0,"v":0},{"t":4,"v":12}],"eyeLookX":[{"t":0,"v":0},{"t":2,"v":-0.5}]}',
      cameraKeyframes: '[{"t":0,"x":0,"y":0,"zoom":1},{"t":4,"x":0,"y":-0.01,"zoom":1.03}]',
      subtitleTextTr: 'Daha erken söylemeliydin.', subtitleStartSeconds: '0.5', subtitleEndSeconds: '3.8',
      ...shotMetadata,
    }, { revision: 9 }),
    node('character.aya', 'character', { outfitState: 'school-uniform' }, { revision: 7 }),
    node('location.cafe', 'location', {}, { revision: 4 }),
    node('audio.dialogue.aya.001', 'audio', { language: 'ja', text: 'もっと早く。', startSeconds: '0.5' }, { revision: 3 }),
    asset('asset.character-state', 'image', 'artifacts/anime/character.png', charBytes, 'character-rig-state'),
    asset('asset.bg', 'image', 'artifacts/anime/bg.png', bgBytes, 'environment-plate'),
    asset('asset.mid', 'image', 'artifacts/anime/mid.png', midBytes, 'environment-plate'),
    asset('asset.fg', 'image', 'artifacts/anime/fg.png', fgBytes, 'environment-plate'),
    asset('asset.mask', 'image', 'artifacts/anime/mask.png', maskBytes, 'occlusion-mask'),
    asset('asset.audio', 'audio', 'artifacts/anime/line.wav', audioBytes, 'dialogue-audio'),
    asset('asset.rig', 'json', 'artifacts/anime/rig.json', files.get('artifacts/anime/rig.json'), 'character-rig'),
    asset('asset.environment', 'json', 'artifacts/anime/environment.json', files.get('artifacts/anime/environment.json'), 'environment-package'),
    asset('asset.alignment', 'json', 'artifacts/anime/alignment.json', files.get('artifacts/anime/alignment.json'), 'dialogue-alignment'),
  ];
  const dependencies = [
    { dependent: 'shot.1', dependency: 'scene.1' },
    { dependent: 'shot.1', dependency: 'character.aya' },
    { dependent: 'shot.1', dependency: 'location.cafe' },
    { dependent: 'shot.1', dependency: 'audio.dialogue.aya.001' },
  ];
  return { root, snapshot: { schemaVersion: 1, projectRevision: 42, nodes, dependencies } };
}

const readyFixture = await fixture();
try {
  const plan = await planShotAnim(readyFixture.snapshot, 'shot.1', { projectRoot: readyFixture.root });
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.inputAssetIds.sort(), ['asset.alignment', 'asset.audio', 'asset.environment', 'asset.rig'].sort());

  const compiled = await buildShotAnimRequest(readyFixture.snapshot, 'shot.1', { projectRoot: readyFixture.root });
  assert.equal(compiled.shotAnim.schema, 'makewatch.shotAnim/1');
  assert.equal(compiled.shotAnim.dialogue[0].language, 'ja');
  assert.equal(compiled.shotAnim.dialogue[0].audioPath, 'artifacts/anime/line.wav');
  assert.equal(compiled.shotAnim.layers.filter(({ part }) => part === 'plate').length, 3);
  assert.equal(compiled.compileReport.resolvedRevisions.shot, 9);

  const stale = structuredClone(readyFixture.snapshot);
  stale.nodes.find(({ id }) => id === 'asset.rig').stale = true;
  assert.equal((await planShotAnim(stale, 'shot.1', { projectRoot: readyFixture.root })).issues[0].code, 'stale_asset');

  const missingEnvironment = structuredClone(readyFixture.snapshot);
  delete missingEnvironment.nodes.find(({ id }) => id === 'shot.1').metadata.environmentPackageAssetId;
  assert.ok((await planShotAnim(missingEnvironment, 'shot.1', { projectRoot: readyFixture.root })).issues.some(({ code }) => code === 'missing_environment_package'));

  const outsideDomain = structuredClone(readyFixture.snapshot);
  outsideDomain.nodes.find(({ id }) => id === 'shot.1').metadata.actingCurves = '{"headAngleX":[{"t":0,"v":30}]}';
  const outsidePlan = await planShotAnim(outsideDomain, 'shot.1', { projectRoot: readyFixture.root });
  assert.equal(outsidePlan.ready, false);
  assert.ok(outsidePlan.issues.some(({ code, message }) => code === 'pose_outside_valid_domain' && /corrective redraw/i.test(message)));

  await assert.rejects(() => buildShotAnimRequest(missingEnvironment, 'shot.1', { projectRoot: readyFixture.root }), (error) => error.code === 'not_ready');
} finally {
  await rm(readyFixture.root, { recursive: true, force: true });
}

const missingClosedFixture = await fixture({ mutateRig: (rig) => ({ ...rig, states: rig.states.filter(({ id }) => id !== 'mouth.CLOSED') }) });
try {
  const plan = await planShotAnim(missingClosedFixture.snapshot, 'shot.1', { projectRoot: missingClosedFixture.root });
  assert.ok(plan.issues.some(({ code, message }) => code === 'invalid_character_rig' && /mouth\.CLOSED/.test(message)));
} finally {
  await rm(missingClosedFixture.root, { recursive: true, force: true });
}

const mismatchFixture = await fixture({ alignmentAudioSha: '0'.repeat(64) });
try {
  const plan = await planShotAnim(mismatchFixture.snapshot, 'shot.1', { projectRoot: mismatchFixture.root });
  assert.ok(plan.issues.some(({ code }) => code === 'alignment_audio_mismatch'));
} finally {
  await rm(mismatchFixture.root, { recursive: true, force: true });
}

console.log('shot anim compiler checks passed');
