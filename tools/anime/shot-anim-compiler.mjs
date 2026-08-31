import { createHash } from 'node:crypto';
import { readFile as readFileDefault } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import { validateShotAnim } from './native-anime-contract.mjs';
import {
  validateAlignmentAsset,
  validateCharacterRig,
  validateEnvironmentPackage,
} from './native-anime-asset-contracts.mjs';

const ACCEPTED_APPROVALS = new Set(['approved', 'locked']);
const MAX_METADATA_JSON = 256_000;

function compilerError(code, message, details) {
  return Object.assign(new Error(message), { code, details });
}

function cleanId(value) {
  const id = String(value ?? '').trim();
  return id && id.length <= 160 && !/[\r\n\0]/.test(id) ? id : '';
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function parseJson(value, fallback, label) {
  const source = String(value ?? '').trim();
  if (!source) return structuredClone(fallback);
  if (source.length > MAX_METADATA_JSON) throw compilerError('invalid_argument', `${label} exceeds the metadata limit`);
  try { return JSON.parse(source); } catch { throw compilerError('invalid_argument', `${label} is not valid JSON`); }
}

function indexSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.dependencies)) {
    throw compilerError('invalid_argument', 'valid project snapshot is required');
  }
  const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const dependencies = new Map();
  for (const edge of snapshot.dependencies) {
    if (!nodes.has(edge.dependent) || !nodes.has(edge.dependency)) continue;
    if (!dependencies.has(edge.dependent)) dependencies.set(edge.dependent, []);
    dependencies.get(edge.dependent).push(nodes.get(edge.dependency));
  }
  return { nodes, dependencies };
}

function dependenciesOf(index, id, kind) {
  const values = index.dependencies.get(id) ?? [];
  return kind ? values.filter((node) => node.kind === kind) : values;
}

function dependsOn(index, dependent, dependencyId) {
  return (index.dependencies.get(dependent) ?? []).some((node) => node.id === dependencyId);
}

function managedAssetPath(projectRoot, asset, label) {
  const mediaRoot = resolve(projectRoot, '.makewatch');
  const relativePath = String(asset?.metadata?.relativePath ?? '').replaceAll('\\', '/');
  if (!relativePath || isAbsolute(relativePath) || relativePath.split('/').some((part) => !part || part === '..')) {
    throw compilerError('invalid_argument', `${label} has an unsafe managed path`);
  }
  const absolutePath = resolve(mediaRoot, ...relativePath.split('/'));
  const escaped = relative(mediaRoot, absolutePath);
  if (!escaped || escaped.startsWith('..') || isAbsolute(escaped)) {
    throw compilerError('invalid_argument', `${label} path escapes .makewatch`);
  }
  return { relativePath, absolutePath };
}

function assetIssue(index, id, expectedType, issues, label) {
  const asset = index.nodes.get(cleanId(id));
  if (!asset || asset.kind !== 'asset') {
    issues.push({ code: 'missing_asset', message: `${label} Asset ${id || '(missing)'} was not found` });
    return null;
  }
  if (asset.stale) {
    issues.push({ code: 'stale_asset', message: `${label} Asset ${asset.id} is stale` });
    return null;
  }
  if (!ACCEPTED_APPROVALS.has(asset.approval)) {
    issues.push({ code: 'unapproved_asset', message: `${label} Asset ${asset.id} is not approved` });
    return null;
  }
  if (expectedType && asset.metadata?.mediaType !== expectedType) {
    issues.push({ code: 'wrong_media_type', message: `${label} Asset ${asset.id} must use mediaType ${expectedType}` });
    return null;
  }
  if (!/^[a-f0-9]{64}$/.test(String(asset.metadata?.sha256 ?? ''))) {
    issues.push({ code: 'invalid_asset_hash', message: `${label} Asset ${asset.id} has no valid SHA-256` });
    return null;
  }
  return asset;
}

async function readVerifiedAsset(projectRoot, asset, readFile, label) {
  const paths = managedAssetPath(projectRoot, asset, label);
  const bytes = await readFile(paths.absolutePath);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== asset.metadata.sha256) throw compilerError('integrity_error', `${label} Asset ${asset.id} failed SHA-256 verification`);
  return { ...paths, bytes };
}

async function loadStructuredAsset(projectRoot, asset, readFile, validator, label) {
  const loaded = await readVerifiedAsset(projectRoot, asset, readFile, label);
  let decoded;
  try { decoded = JSON.parse(loaded.bytes.toString('utf8')); } catch { throw compilerError('invalid_argument', `${label} Asset ${asset.id} is not valid JSON`); }
  return { ...loaded, value: validator(decoded) };
}

function issueFrom(error, code, prefix) {
  return { code, message: `${prefix}: ${error instanceof Error ? error.message : String(error)}` };
}

function checkReferencedImage(index, projectRoot, readFile, reference, issues, label) {
  const asset = assetIssue(index, reference.imageAssetId, 'image', issues, label);
  if (!asset) return Promise.resolve();
  if (asset.metadata.sha256 !== reference.imageSha256) {
    issues.push({ code: 'source_hash_mismatch', message: `${label} hash does not match ${asset.id}` });
    return Promise.resolve();
  }
  let paths;
  try { paths = managedAssetPath(projectRoot, asset, label); } catch (error) {
    issues.push(issueFrom(error, error.code ?? 'invalid_argument', label));
    return Promise.resolve();
  }
  if (paths.relativePath !== reference.path) {
    issues.push({ code: 'source_path_mismatch', message: `${label} path does not match ${asset.id}` });
    return Promise.resolve();
  }
  return readVerifiedAsset(projectRoot, asset, readFile, label).catch((error) => {
    issues.push(issueFrom(error, error.code ?? 'integrity_error', label));
  });
}

function selectedRigStates(rig) {
  const selectedIds = new Set([
    'body.DEFAULT', 'torso.DEFAULT', 'face_base.DEFAULT',
    'eyes_l.OPEN', 'eyes_r.OPEN', 'mouth.CLOSED',
    'front_hair.DEFAULT', 'rear_hair.DEFAULT', 'hair.DEFAULT',
  ]);
  return rig.states.filter((state) => selectedIds.has(state.id));
}

function domainIssues(rigs, curves, correctiveKeys) {
  if (correctiveKeys.length) return [];
  const issues = [];
  for (const rig of rigs) {
    for (const [channel, keys] of Object.entries(curves)) {
      const range = rig.validDomain[channel];
      if (!range || !Array.isArray(keys)) continue;
      for (const key of keys) {
        const value = Number(key?.v);
        if (Number.isFinite(value) && (value < range[0] || value > range[1])) {
          issues.push({
            code: 'pose_outside_valid_domain',
            blocker: 'corrective_redraw',
            characterId: rig.characterId,
            channel,
            message: `${channel}=${value} exceeds ${rig.characterId} domain ${range[0]}..${range[1]}; corrective redraw required`,
          });
          break;
        }
      }
    }
  }
  return issues;
}

export async function planShotAnim(snapshot, shotId, { projectRoot, readFile = readFileDefault } = {}) {
  const index = indexSnapshot(snapshot);
  const id = cleanId(shotId);
  const shot = index.nodes.get(id);
  if (!shot || shot.kind !== 'shot') throw compilerError('not_found', 'shot node was not found');
  if (!projectRoot) throw compilerError('invalid_argument', 'projectRoot is required');

  const issues = [];
  const sceneOwners = dependenciesOf(index, id, 'scene');
  if (sceneOwners.length !== 1) issues.push({ code: 'invalid_scene_ownership', message: `Shot ${id} must depend on exactly one Scene` });
  if (shot.stale) issues.push({ code: 'stale_shot', message: `Shot ${id} is stale` });
  if (shot.locked && shot.approval !== 'locked') issues.push({ code: 'locked_shot', message: `Shot ${id} is locked without locked approval` });

  let rigIds = [];
  let dialogueAudioIds = {};
  let alignmentIds = {};
  let actingCurves = {};
  let cameraKeyframes = [];
  let correctiveKeyIds = [];
  try {
    rigIds = parseJson(shot.metadata?.characterRigAssetIds, [], 'characterRigAssetIds');
    dialogueAudioIds = parseJson(shot.metadata?.dialogueAudioAssetIds, {}, 'dialogueAudioAssetIds');
    alignmentIds = parseJson(shot.metadata?.alignmentAssetIds, {}, 'alignmentAssetIds');
    actingCurves = parseJson(shot.metadata?.actingCurves, {}, 'actingCurves');
    cameraKeyframes = parseJson(shot.metadata?.cameraKeyframes, [], 'cameraKeyframes');
    correctiveKeyIds = parseJson(shot.metadata?.correctiveKeyAssetIds, [], 'correctiveKeyAssetIds');
  } catch (error) {
    issues.push(issueFrom(error, 'invalid_metadata', 'Shot metadata'));
  }
  if (!Array.isArray(rigIds)) {
    issues.push({ code: 'invalid_character_rigs', message: 'characterRigAssetIds must be a JSON array' });
    rigIds = [];
  }
  if (!Array.isArray(cameraKeyframes)) cameraKeyframes = [];
  if (!Array.isArray(correctiveKeyIds)) correctiveKeyIds = [];
  if (!actingCurves || typeof actingCurves !== 'object' || Array.isArray(actingCurves)) actingCurves = {};

  const characters = dependenciesOf(index, id, 'character');
  const locations = dependenciesOf(index, id, 'location');
  const dialogueUnits = dependenciesOf(index, id, 'audio');
  if (!characters.length) issues.push({ code: 'missing_character', message: `Shot ${id} has no Character dependency` });
  if (locations.length !== 1) issues.push({ code: 'missing_location', message: `Shot ${id} must depend on exactly one Location` });
  if (rigIds.length !== characters.length) issues.push({ code: 'missing_character_rig', message: `Shot ${id} requires one CharacterRig per visible Character` });

  const inputAssetIds = [];
  const rigs = [];
  const rigAssets = [];
  for (const rigId of rigIds.slice(0, 8)) {
    const asset = assetIssue(index, rigId, 'json', issues, 'CharacterRig');
    if (!asset) continue;
    inputAssetIds.push(asset.id);
    try {
      const loaded = await loadStructuredAsset(projectRoot, asset, readFile, validateCharacterRig, 'CharacterRig');
      const character = characters.find(({ id: characterId }) => characterId === loaded.value.characterId);
      if (!character) issues.push({ code: 'rig_character_mismatch', message: `CharacterRig ${asset.id} does not belong to a visible Character` });
      else if (character.revision !== loaded.value.characterRevision) issues.push({ code: 'rig_revision_mismatch', message: `CharacterRig ${asset.id} targets Character revision ${loaded.value.characterRevision}, current is ${character.revision}` });
      else if (String(character.metadata?.outfitState ?? 'default') !== loaded.value.outfitState) issues.push({ code: 'rig_outfit_mismatch', message: `CharacterRig ${asset.id} outfit does not match ${character.id}` });
      else if (!dependsOn(index, character.id, asset.id)) issues.push({ code: 'rig_not_promoted', message: `CharacterRig ${asset.id} is not a promoted dependency of ${character.id}; run character_rig_validate({ promote: true })` });
      await Promise.all(loaded.value.states.map((state) => checkReferencedImage(index, projectRoot, readFile, state, issues, `CharacterRig state ${state.id}`)));
      rigs.push(loaded.value);
      rigAssets.push(asset);
    } catch (error) {
      issues.push(issueFrom(error, 'invalid_character_rig', `CharacterRig ${asset.id}`));
    }
  }

  const environmentId = cleanId(shot.metadata?.environmentPackageAssetId);
  if (!environmentId) issues.push({ code: 'missing_environment_package', message: `Shot ${id} has no EnvironmentPackage` });
  const environmentAsset = environmentId ? assetIssue(index, environmentId, 'json', issues, 'EnvironmentPackage') : null;
  let environment = null;
  if (environmentAsset) {
    inputAssetIds.push(environmentAsset.id);
    try {
      const loaded = await loadStructuredAsset(projectRoot, environmentAsset, readFile, validateEnvironmentPackage, 'EnvironmentPackage');
      environment = loaded.value;
      const location = locations.find(({ id: locationId }) => locationId === environment.locationId);
      if (!location) issues.push({ code: 'environment_location_mismatch', message: `EnvironmentPackage ${environmentAsset.id} does not belong to the Shot Location` });
      else if (location.revision !== environment.locationRevision) issues.push({ code: 'environment_revision_mismatch', message: `EnvironmentPackage ${environmentAsset.id} targets Location revision ${environment.locationRevision}, current is ${location.revision}` });
      await Promise.all(environment.plates.map((plate) => checkReferencedImage(index, projectRoot, readFile, plate, issues, `Environment plate ${plate.id}`)));
    } catch (error) {
      issues.push(issueFrom(error, 'invalid_environment_package', `EnvironmentPackage ${environmentAsset.id}`));
    }
  }

  const dialogue = [];
  for (const unit of dialogueUnits.slice(0, 1)) {
    const audioId = cleanId(dialogueAudioIds?.[unit.id]);
    const alignmentId = cleanId(alignmentIds?.[unit.id]);
    const audioAsset = assetIssue(index, audioId, 'audio', issues, `Dialogue ${unit.id} audio`);
    const alignmentAsset = assetIssue(index, alignmentId, 'json', issues, `Dialogue ${unit.id} alignment`);
    if (!audioAsset || !alignmentAsset) continue;
    inputAssetIds.push(audioAsset.id, alignmentAsset.id);
    try {
      const [audio, alignmentLoaded] = await Promise.all([
        readVerifiedAsset(projectRoot, audioAsset, readFile, `Dialogue ${unit.id} audio`),
        loadStructuredAsset(projectRoot, alignmentAsset, readFile, validateAlignmentAsset, `Dialogue ${unit.id} alignment`),
      ]);
      const alignment = alignmentLoaded.value;
      if (alignment.audioAssetId !== audioAsset.id || alignment.audioSha256 !== audioAsset.metadata.sha256) {
        issues.push({ code: 'alignment_audio_mismatch', message: `Alignment ${alignmentAsset.id} does not match Audio ${audioAsset.id}` });
      }
      if (alignment.dialogueUnitId !== unit.id) issues.push({ code: 'alignment_dialogue_mismatch', message: `Alignment ${alignmentAsset.id} does not match ${unit.id}` });
      dialogue.push({ unit, audioAsset, alignmentAsset, audio, alignment: alignmentLoaded });
    } catch (error) {
      issues.push(issueFrom(error, 'invalid_alignment', `Dialogue ${unit.id}`));
    }
  }

  issues.push(...domainIssues(rigs, actingCurves, correctiveKeyIds));
  const uniqueInputAssetIds = [...new Set(inputAssetIds)];
  const ready = issues.length === 0;
  return {
    ready,
    shotId: id,
    projectRevision: snapshot.projectRevision,
    issues,
    inputAssetIds: uniqueInputAssetIds,
    resolved: { shot, scene: sceneOwners[0] ?? null, rigs, rigAssets, environment, environmentAsset, dialogue, actingCurves, cameraKeyframes, correctiveKeyIds },
  };
}

export async function buildShotAnimRequest(snapshot, shotId, options = {}) {
  const plan = await planShotAnim(snapshot, shotId, options);
  if (!plan.ready) throw compilerError('not_ready', `Shot ${plan.shotId} is not ready for native animation`, { issues: plan.issues });
  const { shot, scene, rigs, environment, dialogue, actingCurves, cameraKeyframes, correctiveKeyIds } = plan.resolved;
  const layers = [
    ...environment.plates.map((plate, index) => ({
      id: `environment.${plate.id}`,
      part: 'plate',
      path: plate.path,
      z: index,
      parallax: plate.depth,
      pivot: [0.5, 0.5],
    })),
    ...rigs.flatMap((rig, rigIndex) => selectedRigStates(rig).map((state, stateIndex) => ({
      id: `${rig.characterId}.${state.id}`,
      part: state.semanticPart,
      path: state.path,
      z: 10 + rigIndex * 100 + state.z + stateIndex / 100,
      parallax: 1,
      pivot: state.pivot,
      attachTo: state.attachTo,
      curves: actingCurves,
      dynamic: state.semanticPart === 'front_hair'
        ? { segments: 3, stiffness: 0.28, damping: 0.12, gravity: 0.6, maxDeg: 22 }
        : null,
    }))),
  ];
  const compiledDialogue = dialogue.map(({ unit, audioAsset, alignmentAsset }) => ({
    id: unit.id,
    startSeconds: finite(unit.metadata?.startSeconds, 0),
    language: String(unit.metadata?.language ?? 'ja').slice(0, 16),
    audioPath: String(audioAsset.metadata.relativePath),
    alignmentPath: String(alignmentAsset.metadata.relativePath),
    mouthSource: 'alignment',
  }));
  const subtitleText = String(shot.metadata?.subtitleTextTr ?? '').trim();
  const shotAnim = validateShotAnim({
    schema: 'makewatch.shotAnim/1',
    shotId: shot.id,
    durationSeconds: finite(shot.metadata?.durationSeconds, 0),
    fps: finite(shot.metadata?.fps, 24),
    resolution: [finite(shot.metadata?.width, 1920), finite(shot.metadata?.height, 1080)],
    background: { color: [8, 10, 16] },
    layers,
    camera: { keyframes: cameraKeyframes },
    dialogue: compiledDialogue,
    subtitles: subtitleText ? [{
      text: subtitleText,
      startSeconds: finite(shot.metadata?.subtitleStartSeconds, compiledDialogue[0]?.startSeconds ?? 0),
      endSeconds: finite(shot.metadata?.subtitleEndSeconds, finite(shot.metadata?.durationSeconds, 0)),
      language: 'tr',
    }] : [],
    cadence: { bodyKeys: String(shot.metadata?.bodyCadence ?? 'on-2'), mouth: 'discrete' },
    correctiveKeys: correctiveKeyIds.map((assetId) => ({ assetId })),
    grain: finite(shot.metadata?.grain, 0.03),
  });
  return {
    shotAnim,
    inputAssetIds: plan.inputAssetIds,
    compileReport: {
      schema: 'makewatch.shotAnimCompileReport/1',
      projectRevision: snapshot.projectRevision,
      resolvedRevisions: {
        shot: shot.revision,
        scene: scene.revision,
        characters: Object.fromEntries(rigs.map((rig) => [rig.characterId, rig.characterRevision])),
        location: environment.locationRevision,
      },
      inputAssetIds: plan.inputAssetIds,
      correctiveRedrawBlockers: [],
      warnings: [],
    },
  };
}
