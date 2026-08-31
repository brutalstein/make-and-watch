// Contract for the Native Anime Motion Engine (provider `native-anime`).
//
// The engine is a deterministic 2D-animation renderer: sparse AI key drawings +
// layered-mesh deformation + Verlet secondary motion + 2.5D parallax environment +
// forced-alignment lip sync. It is a drop-in `TemporalProviderRegistry` provider and
// returns the exact same artifact shape FramePack returns, so composition, render and
// provenance are unchanged. Design: project_brain/NATIVE_ANIME_MOTION_ENGINE.md.
//
// This module owns only the request contract (the ShotAnim program the worker
// executes) and its validation. Compiling a ShotAnim from the native project graph
// (buildShotAnimRequest) is a later milestone. Until that compiler exists, production
// requests fail closed instead of silently degrading to an animated still.

import { normalizeBoneTree } from './bone-tree.mjs';

const RESULT_PREFIX = 'MW_TEMPORAL_RESULT_V1\t';
const SHOT_ANIM_SCHEMA = 'makewatch.shotAnim/1';
const MAX_MOTION_CHARACTERS = 8;
const MOTION_EVENT_KINDS = new Set(['footPlant', 'footLift', 'contact', 'impact', 'anticipation', 'recovery', 'settle']);
const MIN_SHOT_SECONDS = 1;
const MAX_SHOT_SECONDS = 20;
const MIN_FPS = 12;
const MAX_FPS = 60;
const MIN_DIMENSION = 64;
const MAX_DIMENSION = 4096;
const MAX_LAYERS = 64;
const MAX_SUBTITLE_CUES = 40;
// The current worker muxes one timing-authority track. Multi-speaker timeline mixing
// belongs in the planned ShotAnim compiler/composition milestone.
const MAX_DIALOGUE_UNITS = 1;

// Anime-simple discrete mouth chart (not photoreal visemes). Order is the channel value.
const MOUTH_SHAPES = Object.freeze(['CLOSED', 'SMALL', 'A', 'I', 'U', 'E', 'O', 'WIDE']);

// Controlled vocabulary for layer semantics; unknown parts are allowed but skipped by QC.
const SEMANTIC_PARTS = Object.freeze([
  'root', 'spine', 'neck', 'head_group', 'face_base', 'eyes_l', 'eyes_r', 'eyes', 'brows',
  'mouth', 'ear_l', 'ear_r', 'front_hair', 'side_hair_l', 'side_hair_r', 'rear_hair',
  'torso', 'hip', 'upper_arm_l', 'upper_arm_r', 'forearm_l', 'forearm_r', 'hand_l', 'hand_r',
  'thigh_l', 'thigh_r', 'shin_l', 'shin_r', 'foot_l', 'foot_r', 'body', 'plate', 'accessory',
]);

const CURVE_EASES = Object.freeze(['step', 'linear', 'hold', 'easeIn', 'easeOut', 'easeInOut']);

function contractError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function finiteNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw contractError('invalid_argument', `${label} must be a finite number`);
  return parsed;
}

function boundedInt(value, label, min, max) {
  const parsed = finiteNumber(value, label);
  const rounded = Math.round(parsed);
  if (rounded < min || rounded > max) throw contractError('invalid_argument', `${label} must be ${min}..${max}`);
  return rounded;
}

// Reject absolute paths and parent traversal here; the provider additionally clamps
// every path to the project media root before the worker ever opens a file.
function safeRelativePath(value, label) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 1024 || text.includes('\0')) {
    throw contractError('invalid_argument', `${label} is missing or invalid`);
  }
  const normalized = text.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw contractError('invalid_argument', `${label} must be a project-relative path`);
  }
  if (normalized.split('/').some((segment) => segment === '..' || segment === '')) {
    throw contractError('invalid_argument', `${label} must not contain path traversal`);
  }
  return normalized;
}

function normalizeCurve(raw, label, duration) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw contractError('invalid_argument', `${label} must be an array of keyframes`);
  if (raw.length > 512) throw contractError('invalid_argument', `${label} has too many keyframes`);
  let previousT = -Infinity;
  return raw.map((key, index) => {
    if (!key || typeof key !== 'object') throw contractError('invalid_argument', `${label}[${index}] must be an object`);
    const t = finiteNumber(key.t, `${label}[${index}].t`);
    if (t < 0 || t > duration + 1e-6) throw contractError('invalid_argument', `${label}[${index}].t is outside the shot`);
    if (t < previousT - 1e-6) throw contractError('invalid_argument', `${label} keyframes must be sorted by t`);
    previousT = t;
    const ease = key.ease === undefined ? 'linear' : String(key.ease);
    if (!CURVE_EASES.includes(ease)) throw contractError('invalid_argument', `${label}[${index}].ease is unknown`);
    return { t, v: finiteNumber(key.v, `${label}[${index}].v`), ease };
  });
}

function normalizeLayerCurves(raw, label, duration) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object') throw contractError('invalid_argument', `${label} must be an object of channels`);
  const out = {};
  for (const [channel, keys] of Object.entries(raw)) {
    out[String(channel)] = normalizeCurve(keys, `${label}.${channel}`, duration);
  }
  return out;
}

function normalizeLayer(raw, index, duration) {
  if (!raw || typeof raw !== 'object') throw contractError('invalid_argument', `layers[${index}] must be an object`);
  const part = String(raw.part ?? 'body');
  const pivot = Array.isArray(raw.pivot) ? raw.pivot : [0.5, 0.5];
  if (pivot.length !== 2) throw contractError('invalid_argument', `layers[${index}].pivot must be [x, y]`);
  const parallax = raw.parallax === undefined ? 1 : finiteNumber(raw.parallax, `layers[${index}].parallax`);
  if (parallax < 0 || parallax > 4) throw contractError('invalid_argument', `layers[${index}].parallax must be 0..4`);
  return {
    id: String(raw.id ?? part ?? `layer_${index}`).slice(0, 80),
    part,
    knownPart: SEMANTIC_PARTS.includes(part),
    path: safeRelativePath(raw.path, `layers[${index}].path`),
    z: raw.z === undefined ? index : finiteNumber(raw.z, `layers[${index}].z`),
    parallax,
    pivot: [
      Math.min(1, Math.max(0, finiteNumber(pivot[0], `layers[${index}].pivot.x`))),
      Math.min(1, Math.max(0, finiteNumber(pivot[1], `layers[${index}].pivot.y`))),
    ],
    anchor: Array.isArray(raw.anchor) && raw.anchor.length === 2
      ? [finiteNumber(raw.anchor[0], `layers[${index}].anchor.x`), finiteNumber(raw.anchor[1], `layers[${index}].anchor.y`)]
      : null,
    attachTo: raw.attachTo === undefined || raw.attachTo === null ? null : String(raw.attachTo).slice(0, 80),
    bone: raw.bone === undefined || raw.bone === null ? null : String(raw.bone).slice(0, 60),
    dynamic: raw.dynamic && typeof raw.dynamic === 'object' ? {
      segments: boundedInt(raw.dynamic.segments ?? 3, `layers[${index}].dynamic.segments`, 1, 12),
      stiffness: Math.min(1, Math.max(0, finiteNumber(raw.dynamic.stiffness ?? 0.28, `layers[${index}].dynamic.stiffness`))),
      damping: Math.min(1, Math.max(0, finiteNumber(raw.dynamic.damping ?? 0.12, `layers[${index}].dynamic.damping`))),
      gravity: finiteNumber(raw.dynamic.gravity ?? 0.6, `layers[${index}].dynamic.gravity`),
      maxDeg: Math.min(90, Math.max(0, finiteNumber(raw.dynamic.maxDeg ?? 22, `layers[${index}].dynamic.maxDeg`))),
    } : null,
    curves: normalizeLayerCurves(raw.curves, `layers[${index}].curves`, duration),
  };
}

// Per-character retargeted skeletal motion baked by the ShotAnim compiler. The worker
// walks `skeleton` with `boneCurves` (degrees, sampled in `t` seconds) to build each
// limb layer's FK transform; `events` and `rootMotion` drive contacts and locomotion.
function normalizeMotion(raw, duration) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw contractError('invalid_argument', 'shotAnim.motion must be an array');
  if (raw.length > MAX_MOTION_CHARACTERS) throw contractError('invalid_argument', `shotAnim.motion has more than ${MAX_MOTION_CHARACTERS} characters`);
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw contractError('invalid_argument', `shotAnim.motion[${index}] must be an object`);
    const skeleton = normalizeBoneTree(entry.skeleton, `shotAnim.motion[${index}].skeleton`);
    const boneCurves = normalizeLayerCurves(entry.boneCurves, `shotAnim.motion[${index}].boneCurves`, duration);
    for (const bone of Object.keys(boneCurves)) {
      if (!skeleton.ids.has(bone)) throw contractError('invalid_argument', `shotAnim.motion[${index}].boneCurves references bone ${bone} not in the skeleton`);
    }
    const rawEvents = Array.isArray(entry.events) ? entry.events : [];
    let previousT = -Infinity;
    const events = rawEvents.map((event, eventIndex) => {
      if (!event || typeof event !== 'object') throw contractError('invalid_argument', `shotAnim.motion[${index}].events[${eventIndex}] must be an object`);
      const t = finiteNumber(event.t, `shotAnim.motion[${index}].events[${eventIndex}].t`);
      if (t < 0 || t > duration + 1e-6) throw contractError('invalid_argument', `shotAnim.motion[${index}].events[${eventIndex}].t is outside the shot`);
      if (t < previousT - 1e-6) throw contractError('invalid_argument', `shotAnim.motion[${index}].events must be sorted by t`);
      previousT = t;
      const kind = String(event.kind ?? '');
      if (!MOTION_EVENT_KINDS.has(kind)) throw contractError('invalid_argument', `shotAnim.motion[${index}].events[${eventIndex}].kind is unknown`);
      const bone = event.bone === undefined || event.bone === null ? null : String(event.bone).slice(0, 60);
      if (bone && !skeleton.ids.has(bone)) throw contractError('invalid_argument', `shotAnim.motion[${index}].events[${eventIndex}] references bone ${bone} not in the skeleton`);
      return { t, kind, bone };
    });
    const rawRoot = Array.isArray(entry.rootMotion) ? entry.rootMotion : [];
    previousT = -Infinity;
    const rootMotion = rawRoot.map((key, keyIndex) => {
      if (!key || typeof key !== 'object') throw contractError('invalid_argument', `shotAnim.motion[${index}].rootMotion[${keyIndex}] must be an object`);
      const t = finiteNumber(key.t, `shotAnim.motion[${index}].rootMotion[${keyIndex}].t`);
      if (t < previousT - 1e-6) throw contractError('invalid_argument', `shotAnim.motion[${index}].rootMotion must be sorted by t`);
      previousT = t;
      return {
        t,
        x: finiteNumber(key.x ?? 0, `shotAnim.motion[${index}].rootMotion[${keyIndex}].x`),
        y: finiteNumber(key.y ?? 0, `shotAnim.motion[${index}].rootMotion[${keyIndex}].y`),
      };
    });
    return {
      characterId: String(entry.characterId ?? '').slice(0, 160),
      fps: boundedInt(entry.fps ?? 24, `shotAnim.motion[${index}].fps`, MIN_FPS, MAX_FPS),
      loop: entry.loop === true,
      screenAnchor: Array.isArray(entry.screenAnchor) && entry.screenAnchor.length === 2
        ? [finiteNumber(entry.screenAnchor[0], `shotAnim.motion[${index}].screenAnchor.x`), finiteNumber(entry.screenAnchor[1], `shotAnim.motion[${index}].screenAnchor.y`)]
        : null,
      skeleton: { bones: skeleton.bones },
      boneCurves,
      events,
      rootMotion,
    };
  });
}

function normalizeColor(raw, fallback) {
  if (!Array.isArray(raw) || raw.length !== 3) return [...fallback];
  return raw.map((channel) => Math.min(255, Math.max(0, Math.round(Number(channel) || 0))));
}

function normalizeCamera(raw, duration) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const keyframes = Array.isArray(value.keyframes) ? value.keyframes : [];
  let previousT = -Infinity;
  const normalized = keyframes.map((key, index) => {
    if (!key || typeof key !== 'object') throw contractError('invalid_argument', `camera.keyframes[${index}] must be an object`);
    const t = finiteNumber(key.t, `camera.keyframes[${index}].t`);
    if (t < 0 || t > duration + 1e-6) throw contractError('invalid_argument', `camera.keyframes[${index}].t is outside the shot`);
    if (t < previousT - 1e-6) throw contractError('invalid_argument', 'camera.keyframes must be sorted by t');
    previousT = t;
    return {
      t,
      x: finiteNumber(key.x ?? 0, `camera.keyframes[${index}].x`),
      y: finiteNumber(key.y ?? 0, `camera.keyframes[${index}].y`),
      zoom: Math.max(0.2, finiteNumber(key.zoom ?? 1, `camera.keyframes[${index}].zoom`)),
      rot: finiteNumber(key.rot ?? 0, `camera.keyframes[${index}].rot`),
      ease: CURVE_EASES.includes(String(key.ease ?? 'easeInOut')) ? String(key.ease ?? 'easeInOut') : 'easeInOut',
    };
  });
  if (!normalized.length) normalized.push({ t: 0, x: 0, y: 0, zoom: 1, rot: 0, ease: 'linear' });
  return {
    keyframes: normalized,
    shake: value.shake && typeof value.shake === 'object'
      ? { amp: Math.max(0, Number(value.shake.amp) || 0), hz: Math.max(0, Number(value.shake.hz) || 0) }
      : null,
  };
}

/**
 * Validate + normalize a ShotAnim program. Throws `invalid_argument` on any malformed
 * field. Returns a frozen normalized object ready to hand to the worker.
 */
export function validateShotAnim(value) {
  if (!value || typeof value !== 'object') throw contractError('invalid_argument', 'shotAnim must be an object');
  if (String(value.schema ?? '') !== SHOT_ANIM_SCHEMA) {
    throw contractError('invalid_argument', `shotAnim.schema must be ${SHOT_ANIM_SCHEMA}`);
  }
  const durationSeconds = finiteNumber(value.durationSeconds, 'shotAnim.durationSeconds');
  if (durationSeconds < MIN_SHOT_SECONDS || durationSeconds > MAX_SHOT_SECONDS) {
    throw contractError('invalid_argument', `shotAnim.durationSeconds must be ${MIN_SHOT_SECONDS}..${MAX_SHOT_SECONDS}`);
  }
  const fps = boundedInt(value.fps ?? 24, 'shotAnim.fps', MIN_FPS, MAX_FPS);
  const resolution = Array.isArray(value.resolution) ? value.resolution : [];
  if (resolution.length !== 2) throw contractError('invalid_argument', 'shotAnim.resolution must be [width, height]');
  const width = boundedInt(resolution[0], 'shotAnim.resolution.width', MIN_DIMENSION, MAX_DIMENSION);
  const height = boundedInt(resolution[1], 'shotAnim.resolution.height', MIN_DIMENSION, MAX_DIMENSION);
  if (width % 2 !== 0 || height % 2 !== 0) throw contractError('invalid_argument', 'shotAnim.resolution must be even (yuv420p)');

  const layers = Array.isArray(value.layers) ? value.layers : [];
  if (layers.length < 1 || layers.length > MAX_LAYERS) {
    throw contractError('invalid_argument', `shotAnim.layers must contain 1..${MAX_LAYERS} entries`);
  }
  const normalizedLayers = layers
    .map((layer, index) => normalizeLayer(layer, index, durationSeconds))
    .sort((left, right) => left.z - right.z);

  const dialogue = Array.isArray(value.dialogue) ? value.dialogue : [];
  if (dialogue.length > MAX_DIALOGUE_UNITS) throw contractError('invalid_argument', 'shotAnim.dialogue has too many units');
  const normalizedDialogue = dialogue.map((unit, index) => {
    if (!unit || typeof unit !== 'object') throw contractError('invalid_argument', `shotAnim.dialogue[${index}] must be an object`);
    const start = finiteNumber(unit.startSeconds ?? 0, `shotAnim.dialogue[${index}].startSeconds`);
    if (start < 0 || start > durationSeconds) throw contractError('invalid_argument', `shotAnim.dialogue[${index}].startSeconds is outside the shot`);
    return {
      id: String(unit.id ?? `dlg_${index}`).slice(0, 80),
      startSeconds: start,
      language: String(unit.language ?? 'ja').slice(0, 16),
      targetLayerId: unit.targetLayerId === undefined ? null : String(unit.targetLayerId).slice(0, 80),
      audioPath: unit.audioPath === undefined || unit.audioPath === null
        ? null : safeRelativePath(unit.audioPath, `shotAnim.dialogue[${index}].audioPath`),
      alignmentPath: unit.alignmentPath === undefined || unit.alignmentPath === null
        ? null : safeRelativePath(unit.alignmentPath, `shotAnim.dialogue[${index}].alignmentPath`),
      mouthSource: ['alignment', 'vad', 'envelope', 'none'].includes(String(unit.mouthSource ?? 'alignment'))
        ? String(unit.mouthSource ?? 'alignment') : 'alignment',
    };
  });

  const subtitles = Array.isArray(value.subtitles) ? value.subtitles : [];
  if (subtitles.length > MAX_SUBTITLE_CUES) throw contractError('invalid_argument', 'shotAnim.subtitles has too many cues');
  const normalizedSubtitles = subtitles.map((cue, index) => {
    if (!cue || typeof cue !== 'object') throw contractError('invalid_argument', `shotAnim.subtitles[${index}] must be an object`);
    const start = finiteNumber(cue.startSeconds, `shotAnim.subtitles[${index}].startSeconds`);
    const end = finiteNumber(cue.endSeconds, `shotAnim.subtitles[${index}].endSeconds`);
    if (!(end > start)) throw contractError('invalid_argument', `shotAnim.subtitles[${index}] end must be after start`);
    const text = String(cue.text ?? '').slice(0, 240);
    if (!text.trim()) throw contractError('invalid_argument', `shotAnim.subtitles[${index}].text is empty`);
    const clippedStart = Math.max(0, start);
    const clippedEnd = Math.min(durationSeconds, end);
    if (!(clippedEnd > clippedStart)) {
      throw contractError('invalid_argument', `shotAnim.subtitles[${index}] does not overlap the shot`);
    }
    return {
      text,
      startSeconds: clippedStart,
      endSeconds: clippedEnd,
      language: String(cue.language ?? 'tr').slice(0, 16),
    };
  });

  const environment = value.environment && typeof value.environment === 'object' ? value.environment : {};
  const grain = Math.min(0.5, Math.max(0, Number(value.grain ?? environment.grain ?? 0)));

  return Object.freeze({
    schema: SHOT_ANIM_SCHEMA,
    shotId: String(value.shotId ?? 'shot.anim').slice(0, 160),
    durationSeconds,
    fps,
    resolution: [width, height],
    frameCount: Math.max(1, Math.round(durationSeconds * fps)),
    background: value.background && typeof value.background === 'object'
      ? { color: normalizeColor(value.background.color, [8, 10, 16]) }
      : { color: [8, 10, 16] },
    layers: normalizedLayers,
    camera: normalizeCamera(value.camera, durationSeconds),
    dialogue: normalizedDialogue,
    subtitles: normalizedSubtitles,
    subtitleFontPath: value.subtitleFontPath ? String(value.subtitleFontPath).slice(0, 1024) : null,
    grain,
    cadence: {
      bodyKeys: String(value.cadence?.bodyKeys ?? 'on-2'),
      mouth: String(value.cadence?.mouth ?? 'discrete'),
    },
    correctiveKeys: Array.isArray(value.correctiveKeys) ? value.correctiveKeys.length : 0,
    motion: normalizeMotion(value.motion, durationSeconds),
  });
}

export const nativeAnimeContract = Object.freeze({
  providerId: 'native-anime',
  displayName: 'Native Anime Motion Engine',
  strategies: Object.freeze(['I2V']),
  resultPrefix: RESULT_PREFIX,
  schema: SHOT_ANIM_SCHEMA,
  minShotSeconds: MIN_SHOT_SECONDS,
  maxShotSeconds: MAX_SHOT_SECONDS,
  fpsRange: Object.freeze([MIN_FPS, MAX_FPS]),
  mouthShapes: MOUTH_SHAPES,
  semanticParts: SEMANTIC_PARTS,
  // Storage/compute posture the engine promises; asserted by the vertical slice, not CI.
  persistsIntermediateFrames: false,
  residentVideoModel: false,
  deterministic: true,
});
