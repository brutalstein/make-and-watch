// `makewatch.motionClip/1` — provider-neutral skeletal performance. Bone-rotation
// channels + param channels + contact/impact events over an integer frame range.
// Authored by hand, by a procedural generator, or (later) DWPose extraction; a
// clip owns no raster data and is retargeted onto a CharacterRig skeleton at
// compile time. Normalization is deterministic: identical input -> identical bytes.

const SCHEMA = 'makewatch.motionClip/1';
const BONE_ID = /^[a-z][a-z0-9_]*$/;
const PARAM_ID = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const EASES = new Set(['step', 'linear', 'easeIn', 'easeOut', 'easeInOut', 'hold']);
const EVENT_KINDS = new Set(['footPlant', 'footLift', 'contact', 'impact', 'anticipation', 'recovery', 'settle']);
const MAX_BONES = 64;
const MAX_KEYS = 2048;
const MAX_EVENTS = 256;
const MAX_FRAMES = 2048;

function invalid(message) {
  throw Object.assign(new Error(message), { code: 'invalid_argument' });
}
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`);
  return value;
}
function finiteNumber(value, label, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) invalid(`${label} must be a finite number in ${min}..${max}`);
  return n;
}
function integer(value, label, min, max) {
  const n = finiteNumber(value, label, min, max);
  if (!Number.isInteger(n)) invalid(`${label} must be an integer`);
  return n;
}
function boneName(value, label) {
  const s = String(value ?? '');
  if (!BONE_ID.test(s) || s.length > 60) invalid(`${label} must match ${BONE_ID} and be <= 60 chars`);
  return s;
}
function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function normalizeSkeleton(value) {
  const input = object(value, 'MotionClip.skeleton');
  if (!Array.isArray(input.bones) || input.bones.length < 1 || input.bones.length > MAX_BONES) {
    invalid(`MotionClip.skeleton.bones must contain 1..${MAX_BONES} bones`);
  }
  const bones = input.bones.map((raw, index) => {
    const bone = object(raw, `MotionClip.skeleton.bones[${index}]`);
    const rest = object(bone.rest ?? {}, `MotionClip.skeleton.bones[${index}].rest`);
    return {
      id: boneName(bone.id, `MotionClip.skeleton.bones[${index}].id`),
      parent: bone.parent === undefined || bone.parent === null ? null : boneName(bone.parent, `MotionClip.skeleton.bones[${index}].parent`),
      rest: {
        x: finiteNumber(rest.x ?? 0, `MotionClip.skeleton.bones[${index}].rest.x`, -100000, 100000),
        y: finiteNumber(rest.y ?? 0, `MotionClip.skeleton.bones[${index}].rest.y`, -100000, 100000),
        rot: finiteNumber(rest.rot ?? 0, `MotionClip.skeleton.bones[${index}].rest.rot`, -3600, 3600),
        len: finiteNumber(rest.len ?? 0, `MotionClip.skeleton.bones[${index}].rest.len`, 0, 100000),
      },
    };
  });

  const ids = bones.map((bone) => bone.id);
  if (new Set(ids).size !== ids.length) invalid('MotionClip.skeleton bone ids must be unique');
  const idSet = new Set(ids);
  const roots = bones.filter((bone) => bone.parent === null);
  if (roots.length !== 1) invalid('MotionClip.skeleton must have exactly one root bone (parent: null)');
  for (const bone of bones) {
    if (bone.parent !== null && !idSet.has(bone.parent)) invalid(`MotionClip.skeleton bone ${bone.id} references missing parent ${bone.parent}`);
    if (bone.parent === bone.id) invalid(`MotionClip.skeleton bone ${bone.id} cannot be its own parent`);
  }
  // acyclic: every bone must reach the root
  const parentOf = new Map(bones.map((bone) => [bone.id, bone.parent]));
  for (const start of ids) {
    let cursor = start;
    let hops = 0;
    while (cursor !== null) {
      cursor = parentOf.get(cursor) ?? null;
      if (++hops > bones.length) invalid(`MotionClip.skeleton has a cycle through bone ${start}`);
    }
  }
  // topological order: parents before children, deterministic
  const ordered = [];
  const placed = new Set();
  while (ordered.length < bones.length) {
    const before = ordered.length;
    for (const bone of bones) {
      if (placed.has(bone.id)) continue;
      if (bone.parent === null || placed.has(bone.parent)) {
        ordered.push(bone);
        placed.add(bone.id);
      }
    }
    if (ordered.length === before) invalid('MotionClip.skeleton could not be ordered (disconnected or cyclic)');
  }
  return { bones: ordered, ids: idSet, root: roots[0].id };
}

function normalizeKeyframes(value, label, frameCount, valueKey, valueRange) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_KEYS) {
    invalid(`${label} must contain 1..${MAX_KEYS} keyframes`);
  }
  let priorFrame = -1;
  return value.map((raw, index) => {
    const key = object(raw, `${label}[${index}]`);
    const f = integer(key.f, `${label}[${index}].f`, 0, frameCount - 1);
    if (f <= priorFrame) invalid(`${label} keyframes must have strictly increasing frame indices`);
    priorFrame = f;
    const out = { f, [valueKey]: finiteNumber(key[valueKey], `${label}[${index}].${valueKey}`, valueRange[0], valueRange[1]) };
    if (key.ease !== undefined && key.ease !== null) {
      const ease = String(key.ease);
      if (!EASES.has(ease)) invalid(`${label}[${index}].ease must be one of ${[...EASES].join(', ')}`);
      out.ease = ease;
    }
    return out;
  });
}

function normalizeChannels(value, skeleton, frameCount) {
  const input = object(value ?? {}, 'MotionClip.channels');
  const boneInput = object(input.bone ?? {}, 'MotionClip.channels.bone');
  const paramInput = object(input.param ?? {}, 'MotionClip.channels.param');

  const bone = {};
  for (const rawId of Object.keys(boneInput).sort()) {
    const id = boneName(rawId, 'MotionClip.channels.bone key');
    if (!skeleton.ids.has(id)) invalid(`MotionClip.channels.bone references bone ${id} that is not in the skeleton`);
    bone[id] = normalizeKeyframes(boneInput[rawId], `MotionClip.channels.bone.${id}`, frameCount, 'deg', [-3600, 3600]);
  }

  const param = {};
  for (const rawId of Object.keys(paramInput).sort()) {
    const id = String(rawId);
    if (!PARAM_ID.test(id) || id.length > 60) invalid(`MotionClip.channels.param key ${id} is invalid`);
    param[id] = normalizeKeyframes(paramInput[rawId], `MotionClip.channels.param.${id}`, frameCount, 'v', [-10000, 10000]);
  }

  if (Object.keys(bone).length === 0 && Object.keys(param).length === 0) {
    invalid('MotionClip.channels must carry at least one bone or param channel');
  }
  return { bone, param };
}

function normalizeEvents(value, skeleton, frameCount) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_EVENTS) invalid(`MotionClip.events must be an array of <= ${MAX_EVENTS}`);
  const events = value.map((raw, index) => {
    const event = object(raw, `MotionClip.events[${index}]`);
    const kind = String(event.kind ?? '');
    if (!EVENT_KINDS.has(kind)) invalid(`MotionClip.events[${index}].kind must be one of ${[...EVENT_KINDS].join(', ')}`);
    const f = integer(event.f, `MotionClip.events[${index}].f`, 0, frameCount - 1);
    const out = { f, kind };
    if (event.bone !== undefined && event.bone !== null) {
      const bone = boneName(event.bone, `MotionClip.events[${index}].bone`);
      if (!skeleton.ids.has(bone)) invalid(`MotionClip.events[${index}] references bone ${bone} not in the skeleton`);
      out.bone = bone;
    }
    if ((event.kind === 'footPlant' || event.kind === 'footLift') && !out.bone) {
      invalid(`MotionClip.events[${index}] (${kind}) requires a bone`);
    }
    return out;
  });
  events.sort((a, b) => (a.f - b.f) || a.kind.localeCompare(b.kind) || String(a.bone ?? '').localeCompare(String(b.bone ?? '')));
  return events;
}

function normalizeRootMotion(value, frameCount) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_KEYS) invalid('MotionClip.rootMotion must be a bounded array');
  let priorFrame = -1;
  return value.map((raw, index) => {
    const key = object(raw, `MotionClip.rootMotion[${index}]`);
    const f = integer(key.f, `MotionClip.rootMotion[${index}].f`, 0, frameCount - 1);
    if (f <= priorFrame) invalid('MotionClip.rootMotion frames must strictly increase');
    priorFrame = f;
    return {
      f,
      x: finiteNumber(key.x ?? 0, `MotionClip.rootMotion[${index}].x`, -100000, 100000),
      y: finiteNumber(key.y ?? 0, `MotionClip.rootMotion[${index}].y`, -100000, 100000),
    };
  });
}

function normalizeCore(value) {
  const input = object(value, 'MotionClip');
  const clipId = String(input.clipId ?? '').trim();
  if (!clipId || clipId.length > 120 || /[\r\n\0]/.test(clipId)) invalid('MotionClip.clipId is missing or invalid');
  const fps = integer(input.fps, 'MotionClip.fps', 1, 120);
  const frameCount = integer(input.frameCount, 'MotionClip.frameCount', 1, MAX_FRAMES);
  const skeleton = normalizeSkeleton(input.skeleton);
  const channels = normalizeChannels(input.channels, skeleton, frameCount);
  const events = normalizeEvents(input.events, skeleton, frameCount);
  const rootMotion = normalizeRootMotion(input.rootMotion, frameCount);

  return freezeDeep({
    schema: SCHEMA,
    clipId,
    fps,
    frameCount,
    durationSeconds: Number((frameCount / fps).toFixed(6)),
    loopable: input.loopable === true,
    skeleton: { bones: skeleton.bones },
    channels,
    events,
    rootMotion,
  });
}

export function normalizeMotionClipInput(value) {
  return normalizeCore(value);
}

export function validateMotionClip(value) {
  const input = object(value, 'MotionClip');
  if (input.schema !== SCHEMA) invalid(`MotionClip.schema must be ${SCHEMA}`);
  return normalizeCore(input);
}

export const motionClipLimits = Object.freeze({
  schema: SCHEMA,
  maxBones: MAX_BONES,
  maxKeys: MAX_KEYS,
  maxEvents: MAX_EVENTS,
  maxFrames: MAX_FRAMES,
  eases: Object.freeze([...EASES]),
  eventKinds: Object.freeze([...EVENT_KINDS]),
});
