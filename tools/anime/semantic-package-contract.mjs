import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

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
    };
  });
  if (new Set(states.map((state) => state.id)).size !== states.length) invalid('duplicate state IDs are not allowed');
  return states;
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
  return {
    characterId: id(input.characterId, 'characterId'),
    expectedRevision: integer(input.expectedRevision, 'character'),
    outfitState: id(input.outfitState, 'outfitState', 100),
    states: normalizedStates(input.states),
    validDomain: normalizedDomains(input.validDomains ?? input.validDomain),
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
