import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateCharacterRig } from './native-anime-asset-contracts.mjs';
import { MotionClipService } from './motion-clip-service.mjs';

const EYE_STATES = ['OPEN', 'HALF', 'CLOSED'];
const MOUTH_STATES = ['CLOSED', 'SMALL', 'A', 'I', 'U', 'E', 'O', 'WIDE'];
const sha = (seed) => createHash('sha256').update(String(seed)).digest('hex');

const RIG_SKELETON = {
  bones: [
    { id: 'root', parent: null, rest: { x: 0, y: 0, rot: 0, len: 0 } },
    { id: 'hip', parent: 'root', rest: { x: 0, y: 0, rot: 0, len: 0 } },
    { id: 'spine', parent: 'root', rest: { x: 0, y: 0, rot: 0, len: 90 } },
    { id: 'head', parent: 'spine', rest: { x: 90, y: 0, rot: 0, len: 45 } },
    { id: 'thigh_l', parent: 'hip', rest: { x: 0, y: 0, rot: 0, len: 135 } },
    { id: 'shin_l', parent: 'thigh_l', rest: { x: 135, y: 0, rot: 0, len: 128 } },
    { id: 'foot_l', parent: 'shin_l', rest: { x: 128, y: 0, rot: 0, len: 38 } },
    { id: 'thigh_r', parent: 'hip', rest: { x: 0, y: 0, rot: 0, len: 135 } },
    { id: 'shin_r', parent: 'thigh_r', rest: { x: 135, y: 0, rot: 0, len: 128 } },
    { id: 'foot_r', parent: 'shin_r', rest: { x: 128, y: 0, rot: 0, len: 38 } },
    { id: 'upper_arm_l', parent: 'spine', rest: { x: 82, y: 0, rot: 0, len: 105 } },
    { id: 'forearm_l', parent: 'upper_arm_l', rest: { x: 105, y: 0, rot: 0, len: 98 } },
    { id: 'upper_arm_r', parent: 'spine', rest: { x: 82, y: 0, rot: 0, len: 105 } },
    { id: 'forearm_r', parent: 'upper_arm_r', rest: { x: 105, y: 0, rot: 0, len: 98 } },
  ],
};

function rigStates() {
  const base = [
    ['body.DEFAULT', 'body'], ['face_base.DEFAULT', 'face_base'],
    ['front_hair.DEFAULT', 'front_hair'], ['rear_hair.DEFAULT', 'rear_hair'],
  ];
  for (const side of ['eyes_l', 'eyes_r']) for (const s of EYE_STATES) base.push([`${side}.${s}`, side]);
  for (const s of MOUTH_STATES) base.push([`mouth.${s}`, 'mouth']);
  return base.map(([id, part], index) => ({
    id, semanticPart: part,
    imageAssetId: `asset.${id.replaceAll('.', '-')}`, imageSha256: sha(id),
    path: `artifacts/anime/rig/${id}.png`, pivot: [0.5, 0.5], z: index,
  }));
}

function buildRig({ skeleton = RIG_SKELETON, validDomain = {}, withSkeleton = true } = {}) {
  const input = {
    schema: 'makewatch.characterRig/1',
    characterId: 'character.aya',
    characterRevision: 7,
    outfitState: 'default',
    paletteFingerprint: sha('palette'),
    canvas: { width: 2048, height: 2048 },
    states: rigStates(),
    validDomain,
  };
  if (withSkeleton) input.skeleton = skeleton;
  return validateCharacterRig(input);
}

function makeBridge(graph) {
  const state = structuredClone(graph);
  return {
    peek: () => structuredClone(state),
    async snapshot() { return structuredClone(state); },
    async apply(commands) {
      for (const command of commands) {
        if (command.type === 'node.create') state.nodes.push({ revision: 0, ...structuredClone(command.node) });
        else if (command.type === 'node.markFresh') { const n = state.nodes.find((x) => x.id === command.id); if (n) n.stale = false; }
        else if (command.type === 'node.patch') { const n = state.nodes.find((x) => x.id === command.id); if (n && command.approval) { n.approval = command.approval; n.revision += 1; } }
        else if (command.type === 'dependency.add') state.dependencies.push({ dependent: command.dependent, dependency: command.dependency });
      }
      state.projectRevision += 1;
      return { projectRevision: state.projectRevision };
    },
  };
}

async function baseGraph(root, { rig = buildRig(), locked = false } = {}) {
  await mkdir(join(root, '.makewatch', 'artifacts', 'anime', 'character-rig'), { recursive: true });
  const rigBytes = Buffer.from(JSON.stringify(rig, null, 2), 'utf8');
  const rigSha = createHash('sha256').update(rigBytes).digest('hex');
  const rigRel = `artifacts/anime/character-rig/${rigSha}.json`;
  await writeFile(join(root, '.makewatch', rigRel), rigBytes);
  const character = { id: 'character.aya', kind: 'character', title: 'Aya', revision: 7, approval: 'approved', locked, stale: false, metadata: { outfitState: 'default' } };
  const rigNode = {
    id: 'asset.rig.aya', kind: 'asset', revision: 3, approval: 'approved', locked: false, stale: false,
    metadata: { schema: 'makewatch.characterRig/1', characterId: 'character.aya', characterRevision: '7', relativePath: rigRel, sha256: rigSha, mediaType: 'json', hasSkeleton: 'true' },
  };
  return {
    schemaVersion: 1, projectRevision: 100,
    nodes: [character, rigNode],
    dependencies: [{ dependent: character.id, dependency: rigNode.id }],
  };
}

const root = await mkdtemp(join(tmpdir(), 'makewatch-motion-clip-'));
try {
  // list() surfaces the hand-authored library
  {
    const service = new MotionClipService({ bridge: makeBridge(await baseGraph(root)), projectRoot: root });
    const listed = await service.list();
    assert.equal(listed.library.length, 5, 'five starter clips');
    assert.ok(listed.library.some((c) => c.libraryClipId === 'walk' && c.loopable));
    assert.ok(listed.library.some((c) => c.libraryClipId === 'strike' && c.events.includes('impact')));
    assert.deepEqual(listed.registered, []);
  }

  // register() content-addresses the clip as a draft asset with provenance, no raster
  {
    const bridge = makeBridge(await baseGraph(root));
    const service = new MotionClipService({ bridge, projectRoot: root });
    const first = await service.register({ libraryClipId: 'walk' });
    assert.equal(first.created, true);
    assert.match(first.clipAssetId, /^asset\.[a-f0-9]{24}$/);
    assert.equal(first.clipAssetId, `asset.${first.sha256.slice(0, 24)}`);
    const snap = bridge.peek();
    const asset = snap.nodes.find((n) => n.id === first.clipAssetId);
    assert.equal(asset.approval, 'draft');
    assert.equal(asset.metadata.schema, 'makewatch.motionClip/1');
    assert.equal(asset.metadata.mediaType, 'json');
    const gen = snap.nodes.find((n) => n.id === asset.metadata.generatedBy);
    assert.equal(gen.metadata.handAuthored, 'true');
    assert.equal(gen.metadata.provider, 'native-anime');
    const onDisk = await readFile(join(root, '.makewatch', asset.metadata.relativePath));
    assert.equal(createHash('sha256').update(onDisk).digest('hex'), first.sha256);

    // idempotent on identical content
    const second = await service.register({ libraryClipId: 'walk' });
    assert.equal(second.created, false);
    assert.equal(second.clipAssetId, first.clipAssetId);
    assert.equal(bridge.peek().nodes.filter((n) => n.id === first.clipAssetId).length, 1);

    const listed = await service.list();
    assert.equal(listed.registered.length, 1);
    assert.equal(listed.registered[0].clipId, 'walk.neutral.loop');
  }

  // retargetPlan() reports covered/missing bones + escalations without writing state
  {
    const bridge = makeBridge(await baseGraph(root, { rig: buildRig({ validDomain: { 'bone.thigh_l': [-5, 5] } }) }));
    const service = new MotionClipService({ bridge, projectRoot: root });
    const { clipAssetId } = await service.register({ libraryClipId: 'walk' });
    const before = bridge.peek().nodes.length;
    const plan = await service.retargetPlan({ clipAssetId, characterId: 'character.aya' });
    assert.ok(plan.coveredBones.includes('thigh_l') && plan.coveredBones.includes('upper_arm_r'));
    assert.deepEqual(plan.missingBones, []);
    assert.ok(plan.domainEscalationCount > 0, 'tight thigh domain escalates on a walk swing');
    assert.equal(plan.correctiveRedrawRequired, false);
    assert.equal(bridge.peek().nodes.length, before, 'retargetPlan writes nothing');
  }

  // a clip needing a bone the rig lacks -> missing_bone + corrective redraw
  {
    const bridge = makeBridge(await baseGraph(root));
    const service = new MotionClipService({ bridge, projectRoot: root });
    const tailClip = {
      schema: 'makewatch.motionClip/1', clipId: 'wag.tail', fps: 24, frameCount: 8,
      skeleton: { bones: [
        { id: 'root', parent: null, rest: { x: 0, y: 0, rot: 0, len: 0 } },
        { id: 'tail', parent: 'root', rest: { x: 0, y: 0, rot: 0, len: 40 } },
      ] },
      channels: { bone: { tail: [{ f: 0, deg: -20 }, { f: 7, deg: 20 }] } },
    };
    const { clipAssetId } = await service.register({ clip: tailClip });
    const plan = await service.retargetPlan({ clipAssetId, characterId: 'character.aya' });
    assert.deepEqual(plan.missingBones, ['tail']);
    assert.equal(plan.correctiveRedrawRequired, true);
  }

  // stale expected revision and a locked Character are rejected
  {
    const service = new MotionClipService({ bridge: makeBridge(await baseGraph(root)), projectRoot: root });
    const { clipAssetId } = await service.register({ libraryClipId: 'turn' });
    await assert.rejects(
      () => service.retargetPlan({ clipAssetId, characterId: 'character.aya', expectedCharacterRevision: 999 }),
      /expected 999/,
    );
  }
  {
    const service = new MotionClipService({ bridge: makeBridge(await baseGraph(root, { locked: true })), projectRoot: root });
    const { clipAssetId } = await service.register({ libraryClipId: 'turn' });
    await assert.rejects(() => service.retargetPlan({ clipAssetId, characterId: 'character.aya' }), /unlock/);
  }

  // validate() promotes a draft clip
  {
    const bridge = makeBridge(await baseGraph(root));
    const service = new MotionClipService({ bridge, projectRoot: root });
    const { clipAssetId } = await service.register({ libraryClipId: 'reach' });
    const result = await service.validate({ clipAssetId, promote: true });
    assert.equal(result.promoted, true);
    assert.equal(bridge.peek().nodes.find((n) => n.id === clipAssetId).approval, 'approved');
  }

  // a skeleton-less rig cannot be a retarget target
  {
    const bridge = makeBridge(await baseGraph(root, { rig: buildRig({ withSkeleton: false }) }));
    const service = new MotionClipService({ bridge, projectRoot: root });
    const { clipAssetId } = await service.register({ libraryClipId: 'walk' });
    await assert.rejects(() => service.retargetPlan({ clipAssetId, characterId: 'character.aya' }), /no skeleton/);
  }

  console.log('motion clip service checks passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
