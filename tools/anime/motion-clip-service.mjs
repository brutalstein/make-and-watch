import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateCharacterRig } from './native-anime-asset-contracts.mjs';
import { validateMotionClip } from './motion-clip-contract.mjs';
import { retargetMotionClip } from './motion-retarget.mjs';

const CLIP_SCHEMA = 'makewatch.motionClip/1';
const RIG_SCHEMA = 'makewatch.characterRig/1';
const DEFAULT_LIBRARY = resolve(dirname(fileURLToPath(import.meta.url)), 'motion-library');
const LIBRARY_ID = /^[a-z][a-z0-9_-]{0,60}$/;
const APPROVED = new Set(['approved', 'locked']);

function clipError(code, message) {
  return Object.assign(new Error(message), { code });
}

function nodeById(snapshot, id) {
  return snapshot.nodes.find((node) => node.id === id) ?? null;
}
function hasDependency(snapshot, dependent, dependency) {
  return snapshot.dependencies.some((edge) => edge.dependent === dependent && edge.dependency === dependency);
}
function safeStem(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'clip';
}
function clipSummary(clip) {
  return {
    clipId: clip.clipId,
    fps: clip.fps,
    frameCount: clip.frameCount,
    durationSeconds: clip.durationSeconds,
    loopable: clip.loopable,
    bones: clip.skeleton.bones.map((bone) => bone.id),
    events: clip.events.map((event) => event.kind),
  };
}

export class MotionClipService {
  constructor({ bridge, projectRoot, libraryDir = DEFAULT_LIBRARY } = {}) {
    if (!bridge || !projectRoot) throw clipError('invalid_argument', 'bridge and projectRoot are required');
    this.bridge = bridge;
    this.projectRoot = resolve(projectRoot);
    this.libraryDir = resolve(libraryDir);
    this.mediaRoot = resolve(this.projectRoot, '.makewatch');
    this._library = null;
  }

  async #library() {
    if (this._library) return this._library;
    const files = (await readdir(this.libraryDir)).filter((name) => name.endsWith('.json')).sort();
    const library = new Map();
    for (const file of files) {
      const stem = file.slice(0, -5);
      if (!LIBRARY_ID.test(stem)) throw clipError('invalid_argument', `motion-library file name ${file} is not a valid clip id`);
      const bytes = await readFile(join(this.libraryDir, file));
      let clip;
      try {
        clip = validateMotionClip(JSON.parse(bytes.toString('utf8')));
      } catch (error) {
        throw clipError('invalid_argument', `motion-library/${file} is not a valid MotionClip: ${error.message}`);
      }
      library.set(stem, { libraryClipId: stem, clip });
    }
    this._library = library;
    return library;
  }

  async plan({ characterId } = {}) {
    const [library, snapshot] = await Promise.all([this.#library(), this.bridge.snapshot()]);
    let character = null;
    if (characterId) {
      const node = nodeById(snapshot, String(characterId));
      if (!node || node.kind !== 'character') throw clipError('not_found', 'character node was not found');
      const rig = this.#promotedRig(snapshot, node);
      character = {
        id: node.id,
        revision: node.revision,
        locked: Boolean(node.locked),
        stale: Boolean(node.stale),
        promotedRigAssetId: rig?.id ?? null,
        hasSkeleton: rig ? rig.metadata?.hasSkeleton === 'true' : false,
      };
    }
    return {
      library: [...library.values()].map(({ libraryClipId, clip }) => ({ libraryClipId, ...clipSummary(clip) })),
      registered: this.#registeredClips(snapshot),
      character,
    };
  }

  async list() {
    const [library, snapshot] = await Promise.all([this.#library(), this.bridge.snapshot()]);
    return {
      library: [...library.values()].map(({ libraryClipId, clip }) => ({ libraryClipId, ...clipSummary(clip) })),
      registered: this.#registeredClips(snapshot),
    };
  }

  #registeredClips(snapshot) {
    return snapshot.nodes
      .filter((node) => node.kind === 'asset' && node.metadata?.schema === CLIP_SCHEMA)
      .map((node) => ({
        clipAssetId: node.id,
        clipId: node.metadata?.clipId ?? null,
        sha256: node.metadata?.sha256 ?? null,
        approval: node.approval,
        stale: Boolean(node.stale),
      }))
      .sort((a, b) => a.clipAssetId.localeCompare(b.clipAssetId));
  }

  #promotedRig(snapshot, character) {
    return snapshot.nodes
      .filter((node) => node.kind === 'asset'
        && node.metadata?.schema === RIG_SCHEMA
        && node.metadata?.characterId === character.id
        && !node.stale
        && APPROVED.has(node.approval)
        && hasDependency(snapshot, character.id, node.id))
      .sort((a, b) => Number(b.metadata?.characterRevision ?? -1) - Number(a.metadata?.characterRevision ?? -1))[0] ?? null;
  }

  async register({ libraryClipId, clip } = {}) {
    let source;
    let handAuthored = false;
    if (libraryClipId !== undefined && libraryClipId !== null) {
      const library = await this.#library();
      const entry = library.get(String(libraryClipId));
      if (!entry) throw clipError('not_found', `motion-library clip ${libraryClipId} was not found`);
      source = entry.clip;
      handAuthored = true;
    } else if (clip !== undefined && clip !== null) {
      source = validateMotionClip(clip);
    } else {
      throw clipError('invalid_argument', 'register needs a libraryClipId or a clip');
    }

    const bytes = Buffer.from(`${JSON.stringify(source, null, 2)}\n`, 'utf8');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const clipAssetId = `asset.${sha256.slice(0, 24)}`;
    const stem = safeStem(source.clipId);
    const generationNodeId = `generation.motion-clip.${stem}.${sha256.slice(0, 12)}`;
    const directory = resolve(this.mediaRoot, 'artifacts', 'anime', 'motion-clip');
    const outputPath = join(directory, `${sha256}.json`);
    const relativePath = relative(this.mediaRoot, outputPath).replaceAll('\\', '/');

    await mkdir(directory, { recursive: true });
    await writeFile(outputPath, bytes, { flag: 'wx' }).catch(async (error) => {
      if (error?.code !== 'EEXIST') throw error;
      const existing = await readFile(outputPath);
      if (createHash('sha256').update(existing).digest('hex') !== sha256) {
        throw clipError('integrity_error', 'MotionClip content-addressed file failed hash verification');
      }
    });

    const snapshot = await this.bridge.snapshot();
    const existing = nodeById(snapshot, clipAssetId);
    if (existing) {
      if (existing.kind !== 'asset' || existing.metadata?.sha256 !== sha256) {
        throw clipError('conflict', `MotionClip Asset ID collision: ${clipAssetId}`);
      }
      return { clipAssetId, sha256, clipId: source.clipId, created: false };
    }

    const commands = [
      {
        type: 'node.create',
        node: {
          id: generationNodeId,
          kind: 'generation',
          title: `MotionClip · ${source.clipId}`,
          approval: 'draft', locked: false, stale: false,
          metadata: {
            status: 'ready',
            mediaType: 'json',
            strategy: 'NATIVE_ANIME_MOTION_CLIP',
            provider: 'native-anime',
            schema: CLIP_SCHEMA,
            clipId: source.clipId,
            artifactPath: relativePath,
            artifactSha256: sha256,
            handAuthored: String(handAuthored),
          },
        },
      },
      { type: 'node.markFresh', id: generationNodeId },
      {
        type: 'node.create',
        node: {
          id: clipAssetId,
          kind: 'asset',
          title: `MotionClip (${source.clipId})`,
          approval: 'draft', locked: false, stale: false,
          metadata: {
            mediaType: 'json',
            role: 'native-anime-motion-clip',
            schema: CLIP_SCHEMA,
            relativePath,
            sha256,
            mimeType: 'application/json',
            generatedBy: generationNodeId,
            clipId: source.clipId,
            frameCount: String(source.frameCount),
            fps: String(source.fps),
            loopable: String(source.loopable),
          },
        },
      },
      { type: 'node.markFresh', id: clipAssetId },
      { type: 'dependency.add', dependent: clipAssetId, dependency: generationNodeId },
    ];
    await this.bridge.apply(commands, {
      actor: 'system',
      source: 'native-anime-motion-clip',
      reason: `register MotionClip ${source.clipId}`,
    }, snapshot.projectRevision);

    return { clipAssetId, sha256, clipId: source.clipId, created: true };
  }

  async #loadClipAsset(snapshot, clipAssetId) {
    const asset = nodeById(snapshot, String(clipAssetId ?? ''));
    if (!asset || asset.kind !== 'asset' || asset.metadata?.schema !== CLIP_SCHEMA) {
      throw clipError('not_found', 'MotionClip Asset was not found');
    }
    const bytes = await readFile(resolve(this.mediaRoot, ...String(asset.metadata.relativePath).split('/')));
    if (createHash('sha256').update(bytes).digest('hex') !== asset.metadata.sha256) {
      throw clipError('integrity_error', 'MotionClip Asset failed SHA-256 verification');
    }
    return { asset, clip: validateMotionClip(JSON.parse(bytes.toString('utf8'))) };
  }

  async retargetPlan({ clipAssetId, characterId, expectedCharacterRevision } = {}) {
    const snapshot = await this.bridge.snapshot();
    const { clip } = await this.#loadClipAsset(snapshot, clipAssetId);

    const character = nodeById(snapshot, String(characterId ?? ''));
    if (!character || character.kind !== 'character') throw clipError('not_found', 'character node was not found');
    if (character.locked) throw clipError('locked', 'unlock the Character before planning a retarget');
    if (character.stale) throw clipError('stale_request', 'Character is stale');
    if (Number.isInteger(expectedCharacterRevision) && character.revision !== expectedCharacterRevision) {
      throw clipError('stale_request', `Character is at revision ${character.revision}, expected ${expectedCharacterRevision}`);
    }

    const rigNode = this.#promotedRig(snapshot, character);
    if (!rigNode) throw clipError('not_ready', `Character ${character.id} has no promoted CharacterRig`);
    const rigBytes = await readFile(resolve(this.mediaRoot, ...String(rigNode.metadata.relativePath).split('/')));
    if (createHash('sha256').update(rigBytes).digest('hex') !== rigNode.metadata.sha256) {
      throw clipError('integrity_error', 'CharacterRig Asset failed SHA-256 verification');
    }
    const rig = validateCharacterRig(JSON.parse(rigBytes.toString('utf8')));
    if (!rig.skeleton) throw clipError('not_ready', `CharacterRig ${rigNode.id} carries no skeleton; rebuild it with limb bones`);

    const baked = retargetMotionClip({ clip, targetRig: rig });
    const missingBones = baked.notes.filter((note) => note.code === 'missing_bone').map((note) => note.bone);
    const footLockUnreached = baked.notes.filter((note) => note.code === 'foot_lock_unreached').map((note) => note.frame);
    return {
      clipId: clip.clipId,
      clipAssetId: String(clipAssetId),
      characterId: character.id,
      characterRevision: rig.characterRevision,
      rigAssetId: rigNode.id,
      coveredBones: Object.keys(baked.boneCurves),
      missingBones,
      domainEscalationCount: baked.domainEscalations.length,
      domainEscalationSample: baked.domainEscalations.slice(0, 8),
      footLockUnreachedFrames: [...new Set(footLockUnreached)],
      correctiveRedrawRequired: missingBones.length > 0,
    };
  }

  async validate({ clipAssetId, promote = false } = {}) {
    const snapshot = await this.bridge.snapshot();
    const { asset } = await this.#loadClipAsset(snapshot, clipAssetId);
    let promoted = false;
    if (promote && !APPROVED.has(asset.approval)) {
      await this.bridge.apply(
        [{ type: 'node.patch', id: asset.id, approval: 'approved' }],
        { actor: 'system', source: 'native-anime-motion-clip-validate', reason: `promote MotionClip ${asset.id}` },
        snapshot.projectRevision,
      );
      promoted = true;
    }
    return { clipAssetId: asset.id, valid: true, promoted };
  }
}
