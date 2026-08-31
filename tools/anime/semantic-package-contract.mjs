import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import { boneName, normalizeBoneTree } from './bone-tree.mjs';

const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9._:-]+$/;
const APPROVED = new Set(['approved', 'locked']);
const EYE_STATES = new Set(['OPEN', 'HALF', 'CLOSED']);
const MOUTH_STATES = new Set(['CLOSED', 'SMALL', 'A', 'I', 'U', 'E', 'O', 'WIDE']);
const DEFAULT_PARTS = new Set(['body', 'torso', 'face_base', 'front_hair', 'rear_hair', 'hair', 'neck']);
const POSE_PARTS = new Set(['upper_arm_l', 'upper_arm_r', 'forearm_l', 'forearm_r', 'hand_l', 'hand_r', 'leg_l', 'leg_r', 'accessory']);
const PLATE_ROLES = new Set(['background', 'midground', 'foreground', 'effect', 'overlay']);
const MAX_STATES = 128;
const MAX_PLATES = 16;
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;

function invalid(message, code = 'invalid_argument') {
  throw Object.assign(new Error(message), { code });
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`);
  return value;
}

function id(value, label, maximum = 180) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > maximum || !ID.test(normalized)) invalid(`${label} is invalid`);
  return normalized;
}

function integer(value, label) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) invalid(`${label} revision must be a non-negative safe integer`);
  return normalized;
}

function finite(value, label, minimum, maximum) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < minimum || normalized > maximum) invalid(`${label} must be finite in ${minimum}..${maximum}`);
  return normalized;
}

function pair(value, label, minimum, maximum) {
  if (!Array.isArray(value) || value.length !== 2) invalid(`${label} must contain two numbers`);
  const result = [finite(value[0], `${label}[0]`, minimum, maximum), finite(value[1], `${label}[1]`, minimum, maximum)];
  if (result[1] < result[0]) invalid(`${label} must be ordered`);
  return result;
}

function semanticPart(stateId) {
  const [part, state, extra] = stateId.split('.');
  if (extra !== undefined) invalid(`unknown semantic state ${stateId}`);
  if (DEFAULT_PARTS.has(part) && state === 'DEFAULT') return part;
  if ((part === 'eyes_l' || part === 'eyes_r') && EYE_STATES.has(state)) return part;
  if (part === 'mouth' && MOUTH_STATES.has(state)) return part;
  if (POSE_PARTS.has(part) && state && ID.test(state)) return part;
  invalid(`unknown semantic state ${stateId}`);
}

function normalizedStates(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_STATES) invalid(`states must contain 1..${MAX_STATES} entries`);
  const states = value.map((raw, index) => {
    const state = object(raw, `states[${index}]`);
    const stateId = id(state.id, `states[${index}].id`, 100);
    return {
      id: stateId,
      semanticPart: semanticPart(stateId),
      sourceAssetId: id(state.sourceAssetId, `states[${index}].sourceAssetId`),
      pivot: pair(state.pivot ?? [0.5, 0.5], `states[${index}].pivot`, 0, 1),
      z: finite(state.z ?? index, `states[${index}].z`, -10000, 10000),
      attachTo: state.attachTo === undefined || state.attachTo === null || state.attachTo === '' ? null : id(state.attachTo, `states[${index}].attachTo`, 100),
      parentBone: state.parentBone === undefined || state.parentBone === null || state.parentBone === '' ? null : boneName(state.parentBone, `states[${index}].parentBone`),
      restAngleDeg: state.restAngleDeg === undefined || state.restAngleDeg === null ? null : finite(state.restAngleDeg, `states[${index}].restAngleDeg`, -3600, 3600),
    };
  });
  if (new Set(states.map((state) => state.id)).size !== states.length) invalid('duplicate state IDs are not allowed');
  return states;
}

const DOMAIN_OPS = new Set(['>', '>=', '<', '<=', '==']);

function normalizedCombinedDomain(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 64) invalid('validDomains.combined must be an array of <= 64 rules');
  return value.map((raw, index) => {
    const rule = object(raw, `validDomains.combined[${index}]`);
    const whenIn = object(rule.if, `validDomains.combined[${index}].if`);
    const thenIn = object(rule.then, `validDomains.combined[${index}].then`);
    const when = {};
    for (const [key, spec] of Object.entries(whenIn)) {
      if (!Array.isArray(spec) || spec.length !== 2 || !DOMAIN_OPS.has(String(spec[0]))) {
        invalid(`validDomains.combined[${index}].if.${key} must be [op, number]`);
      }
      when[boneName(key, `validDomains.combined[${index}].if key`)] = [String(spec[0]), finite(spec[1], `validDomains.combined[${index}].if.${key}[1]`, -10000, 10000)];
    }
    const then = {};
    for (const [key, range] of Object.entries(thenIn)) {
      then[boneName(key, `validDomains.combined[${index}].then key`)] = pair(range, `validDomains.combined[${index}].then.${key}`, -10000, 10000);
    }
    if (!Object.keys(when).length || !Object.keys(then).length) invalid(`validDomains.combined[${index}] needs an if and a then entry`);
    return { if: when, then };
  });
}

function normalizedDomains(value) {
  const domains = object(value ?? {}, 'validDomains');
  return Object.fromEntries(Object.entries(domains).map(([key, range]) => [id(key, 'valid-domain key', 80), pair(range, `validDomains.${key}`, -10000, 10000)]));
}

function stringList(value, label) {
  if (!Array.isArray(value) || value.length > 32) invalid(`${label} must be a bounded array`);
  return value.map((entry, index) => id(entry, `${label}[${index}]`, 100));
}

export function normalizeCharacterRigBuildInput(value) {
  const input = object(value, 'CharacterRig build input');
  const states = normalizedStates(input.states);
  const domainSource = object(input.validDomains ?? input.validDomain ?? {}, 'validDomains');
  const { combined, ...simpleDomains } = domainSource;

  const skeleton = input.skeleton === undefined || input.skeleton === null
    ? null
    : normalizeBoneTree(input.skeleton, 'skeleton');
  for (const state of states) {
    if (state.parentBone === null) continue;
    if (!skeleton) invalid(`states ${state.id} has parentBone but no skeleton was supplied`);
    if (!skeleton.ids.has(state.parentBone)) invalid(`states ${state.id} parentBone ${state.parentBone} is not in the skeleton`);
  }

  return {
    characterId: id(input.characterId, 'characterId'),
    expectedRevision: integer(input.expectedRevision, 'character'),
    outfitState: id(input.outfitState, 'outfitState', 100),
    states,
    skeleton: skeleton ? { bones: skeleton.bones } : null,
    validDomain: normalizedDomains(simpleDomains),
    validDomainCombined: normalizedCombinedDomain(combined ?? input.validDomainCombined),
  };
}

export function normalizeEnvironmentPackageBuildInput(value) {
  const input = object(value, 'EnvironmentPackage build input');
  if (!Array.isArray(input.plates) || input.plates.length < 3 || input.plates.length > MAX_PLATES) {
    invalid(`plates must contain 3..${MAX_PLATES} entries`);
  }
  const plates = input.plates.map((raw, index) => {
    const plate = object(raw, `plates[${index}]`);
    const role = id(plate.role, `plates[${index}].role`, 80);
    if (!PLATE_ROLES.has(role)) invalid(`plates[${index}].role is unknown`);
    return {
      id: id(plate.id, `plates[${index}].id`, 100),
      role,
      sourceAssetId: id(plate.sourceAssetId, `plates[${index}].sourceAssetId`),
      depth: finite(plate.depth, `plates[${index}].depth`, 0, 1),
    };
  });
  if (new Set(plates.map((plate) => plate.id)).size !== plates.length) invalid('duplicate plate IDs are not allowed');
  const roles = new Set(plates.map((plate) => plate.role));
  if (![...['background', 'midground', 'foreground']].every((role) => roles.has(role))) {
    invalid('plates require background, midground and foreground roles');
  }
  const bounds = object(input.cameraSafeBounds ?? input.cameraSafeRegion, 'cameraSafeBounds');
  return {
    locationId: id(input.locationId, 'locationId'),
    expectedRevision: integer(input.expectedRevision, 'location'),
    stateId: id(input.stateId, 'stateId', 100),
    plates,
    occlusionMaskAssetId: id(input.occlusionMaskAssetId, 'occlusionMaskAssetId'),
    cameraSafeRegion: { x: pair(bounds.x, 'cameraSafeBounds.x', 0, 1), y: pair(bounds.y, 'cameraSafeBounds.y', 0, 1) },
    lightingStates: stringList(input.lightingStates ?? [], 'lightingStates'),
    weatherStates: stringList(input.weatherStates ?? [], 'weatherStates'),
  };
}

export async function resolveManagedSourceAsset(snapshot, projectRoot, assetId, expectedMediaType) {
  if (!snapshot || !Array.isArray(snapshot.nodes)) invalid('valid project snapshot is required');
  const sourceId = id(assetId, 'sourceAssetId');
  const asset = snapshot.nodes.find((node) => node.id === sourceId);
  if (!asset || asset.kind !== 'asset') invalid(`source Asset ${sourceId} was not found`, 'not_found');
  if (asset.stale || !APPROVED.has(asset.approval)) invalid(`source Asset ${sourceId} must be current and approved`, 'not_ready');
  if (asset.metadata?.mediaType !== expectedMediaType) invalid(`source Asset ${sourceId} must use mediaType ${expectedMediaType}`);
  const sha256 = String(asset.metadata?.sha256 ?? '');
  if (!SHA256.test(sha256)) invalid(`source Asset ${sourceId} has no valid SHA-256`);
  const relativePath = String(asset.metadata?.relativePath ?? '').replaceAll('\\', '/');
  if (!relativePath || isAbsolute(relativePath) || relativePath.split('/').some((part) => !part || part === '..')) {
    invalid(`source Asset ${sourceId} has an unsafe managed path`);
  }
  const mediaRoot = resolve(projectRoot, '.makewatch');
  const absolutePath = resolve(mediaRoot, ...relativePath.split('/'));
  const escaped = relative(mediaRoot, absolutePath);
  if (!escaped || escaped.startsWith('..') || isAbsolute(escaped)) invalid(`source Asset ${sourceId} path escapes .makewatch`);
  const info = await stat(absolutePath).catch(() => null);
  if (!info?.isFile() || info.size < 1 || info.size > MAX_SOURCE_BYTES) invalid(`source Asset ${sourceId} file is missing or exceeds ${MAX_SOURCE_BYTES} bytes`, 'not_ready');
  const actual = createHash('sha256').update(await readFile(absolutePath)).digest('hex');
  if (actual !== sha256) invalid(`source Asset ${sourceId} failed SHA-256 verification`, 'integrity_error');
  return {
    id: asset.id,
    revision: asset.revision,
    mediaType: expectedMediaType,
    relativePath,
    absolutePath,
    sha256,
    byteSize: info.size,
  };
}

export const semanticPackageLimits = Object.freeze({
  maxStates: MAX_STATES,
  maxPlates: MAX_PLATES,
  maxSourceBytes: MAX_SOURCE_BYTES,
});
