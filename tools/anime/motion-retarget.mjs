// Retarget a `makewatch.motionClip/1` performance onto a CharacterRig skeleton and
// bake frame-aligned bone-rotation curves for the ShotAnim. Deterministic: bone-name
// correspondence + per-limb length scaling + foot-lock IK during footPlant windows +
// a centre-of-mass hip shift, with every out-of-`validDomain` frame surfaced as a
// redraw escalation rather than a folded mesh.

import { forwardKinematics, solveFootLock } from './skeleton-kinematics.mjs';

const EASES = new Set(['step', 'linear', 'easeIn', 'easeOut', 'easeInOut', 'hold']);
const LEG_SIDES = ['l', 'r'];

function fail(message) {
  throw Object.assign(new Error(message), { code: 'invalid_argument' });
}

function easeValue(kind, u) {
  switch (kind) {
    case 'step': return 0;
    case 'hold': return 0;
    case 'easeIn': return u * u;
    case 'easeOut': return 1 - (1 - u) * (1 - u);
    case 'easeInOut': return u < 0.5 ? 2 * u * u : 1 - ((-2 * u + 2) ** 2) / 2;
    case 'linear':
    default: return u;
  }
}

/** Sample a `[{ f, <valueKey>, ease? }]` channel at fractional frame `f`. */
function sampleChannel(keys, valueKey, f) {
  if (keys.length === 1 || f <= keys[0].f) return keys[0][valueKey];
  if (f >= keys[keys.length - 1].f) return keys[keys.length - 1][valueKey];
  for (let i = 1; i < keys.length; i += 1) {
    const a = keys[i - 1];
    const b = keys[i];
    if (f <= b.f) {
      const ease = b.ease && EASES.has(b.ease) ? b.ease : 'linear';
      if (ease === 'step' || ease === 'hold') return a[valueKey];
      const span = (b.f - a.f) || 1;
      const u = easeValue(ease, (f - a.f) / span);
      return a[valueKey] + (b[valueKey] - a[valueKey]) * u;
    }
  }
  return keys[keys.length - 1][valueKey];
}

function boneMap(skeleton) {
  const map = new Map();
  for (const bone of skeleton.bones) map.set(bone.id, bone);
  return map;
}

function round6(value) {
  return Number.isFinite(value) ? Number(value.toFixed(6)) : 0;
}

function checkDomain(channel, value, validDomain) {
  const range = validDomain?.[channel];
  if (!Array.isArray(range) || range.length !== 2) return true;
  return value >= range[0] && value <= range[1];
}

// `validDomain.combined`: [{ if: { chan: ['>', n] }, then: { chan: [min, max] } }]
function checkCombined(sampled, combinedRules) {
  const violations = [];
  for (const rule of combinedRules ?? []) {
    const conds = Object.entries(rule.if ?? {});
    const active = conds.every(([chan, [op, threshold]]) => {
      const v = sampled[chan];
      if (v === undefined) return false;
      if (op === '>') return v > threshold;
      if (op === '>=') return v >= threshold;
      if (op === '<') return v < threshold;
      if (op === '<=') return v <= threshold;
      if (op === '==') return v === threshold;
      return false;
    });
    if (!active) continue;
    for (const [chan, [min, max]] of Object.entries(rule.then ?? {})) {
      const v = sampled[chan];
      if (v !== undefined && (v < min || v > max)) violations.push(chan);
    }
  }
  return violations;
}

function meanOriginX(joints) {
  const xs = Object.values(joints).map((joint) => joint.origin[0]);
  return xs.length ? xs.reduce((sum, value) => sum + value, 0) / xs.length : 0;
}

/**
 * @param {object} params.clip      a validated `makewatch.motionClip/1`
 * @param {object} params.targetRig `{ characterId, characterRevision, skeleton:{bones}, validDomain, validDomainCombined? }`
 * @param {object} [params.options] `{ fps, timeScale, bendSigns:{l,r} }`
 */
export function retargetMotionClip({ clip, targetRig, options = {} } = {}) {
  if (!clip || clip.schema !== 'makewatch.motionClip/1') fail('retarget needs a validated MotionClip');
  if (!targetRig || !targetRig.skeleton || !Array.isArray(targetRig.skeleton.bones) || targetRig.skeleton.bones.length < 1) {
    fail('retarget needs a targetRig with a skeleton');
  }

  const fps = Number.isInteger(options.fps) && options.fps > 0 ? options.fps : clip.fps;
  const timeScale = Number.isFinite(options.timeScale) && options.timeScale > 0 ? options.timeScale : 1;
  const validDomain = targetRig.validDomain ?? {};
  const combinedRules = Array.isArray(targetRig.validDomainCombined) ? targetRig.validDomainCombined : [];

  const sourceBones = boneMap(clip.skeleton);
  const targetBones = boneMap(targetRig.skeleton);

  const notes = [];
  const mappedBones = [];
  for (const boneId of Object.keys(clip.channels.bone)) {
    if (targetBones.has(boneId)) mappedBones.push(boneId);
    else notes.push({ code: 'missing_bone', bone: boneId });
  }

  // per-limb length scale (target / source); guards zero-length source bones
  const lengthScale = {};
  for (const boneId of mappedBones) {
    const srcLen = sourceBones.get(boneId)?.rest.len ?? 0;
    const dstLen = targetBones.get(boneId)?.rest.len ?? 0;
    lengthScale[boneId] = srcLen > 1e-6 ? dstLen / srcLen : 1;
  }
  const legScale = (() => {
    const legs = ['thigh_l', 'thigh_r', 'shin_l', 'shin_r']
      .map((id) => lengthScale[id])
      .filter((value) => Number.isFinite(value) && value > 0);
    return legs.length ? legs.reduce((sum, value) => sum + value, 0) / legs.length : 1;
  })();

  function sampleFrame(f) {
    const sampled = {};
    for (const boneId of Object.keys(clip.channels.bone)) {
      sampled[boneId] = sampleChannel(clip.channels.bone[boneId], 'deg', f);
    }
    return sampled;
  }

  // foot-plant windows: footPlant..(matching footLift | clip end) per bone
  const plantWindows = [];
  const openPlant = new Map();
  for (const event of clip.events) {
    if (event.kind === 'footPlant' && event.bone) {
      openPlant.set(event.bone, event.f);
    } else if (event.kind === 'footLift' && event.bone && openPlant.has(event.bone)) {
      plantWindows.push({ bone: event.bone, startF: openPlant.get(event.bone), endF: event.f });
      openPlant.delete(event.bone);
    }
  }
  for (const [bone, startF] of openPlant) plantWindows.push({ bone, startF, endF: clip.frameCount - 1 });

  // resolve each plant window's frozen ankle world position from the source pose at startF
  for (const window of plantWindows) {
    const joints = forwardKinematics(clip.skeleton, sampleFrame(window.startF));
    const ankle = joints[window.bone]?.origin ?? [0, 0];
    window.plantWorld = [ankle[0] * legScale, ankle[1] * legScale];
    window.side = window.bone.endsWith('_l') ? 'l' : window.bone.endsWith('_r') ? 'r' : null;
  }

  const boneCurves = {};
  for (const boneId of mappedBones) boneCurves[boneId] = [];
  const domainEscalations = [];

  const frameCount = clip.frameCount;
  for (let f = 0; f < frameCount; f += 1) {
    const sourceDeg = sampleFrame(f);
    const targetDeg = {};
    for (const boneId of mappedBones) targetDeg[boneId] = sourceDeg[boneId];

    // foot-lock: during a plant window drive that leg from hip->ankle IK on the target rig.
    // Retarget writes the *world* thigh angle back as a relative anim delta on top of the
    // thigh's rest pose (thigh parents off `hip`, so parentWorld carries no anim here).
    for (const window of plantWindows) {
      if (f < window.startF || f > window.endF || !window.side) continue;
      const side = window.side;
      const thighId = `thigh_${side}`;
      const shinId = `shin_${side}`;
      if (!targetBones.has(thighId) || !targetBones.has(shinId) || !targetBones.has('hip')) continue;
      const hipRest = forwardKinematics(targetRig.skeleton, {})[thighId]?.origin;
      if (!hipRest) continue;
      const thighLen = targetBones.get(thighId).rest.len;
      const shinLen = targetBones.get(shinId).rest.len;
      const bend = options.bendSigns?.[side] ?? 1;
      const solved = solveFootLock(hipRest, thighLen, shinLen, window.plantWorld, bend);
      const restThigh = targetBones.get(thighId).rest.rot;
      targetDeg[thighId] = solved.thighWorldDeg - restThigh;
      targetDeg[shinId] = solved.shinRelDeg;
      if (!solved.reached) notes.push({ code: 'foot_lock_unreached', bone: window.bone, frame: f });
    }

    const t = round6((f / clip.fps) * timeScale);
    for (const boneId of mappedBones) {
      const channel = `bone.${boneId}`;
      if (!checkDomain(channel, targetDeg[boneId], validDomain) && !checkDomain(boneId, targetDeg[boneId], validDomain)) {
        domainEscalations.push({ frame: f, t, channel, value: round6(targetDeg[boneId]) });
      }
      boneCurves[boneId].push({ t, deg: round6(targetDeg[boneId]) });
    }
    for (const chan of checkCombined(targetDeg, combinedRules)) {
      domainEscalations.push({ frame: f, t, channel: `combined.${chan}`, value: round6(targetDeg[chan] ?? 0) });
    }
  }

  // centre-of-mass hip shift, per rootMotion key: keep the retargeted body's weight over
  // the same ground x the source clip put it (ponytail: joint-origin mean, not true mass;
  // upgrade to segment-mass weighting if feet slide on heavy poses).
  function comShiftAtFrame(f) {
    const sourceDeg = sampleFrame(f);
    const targetDeg = {};
    for (const boneId of mappedBones) targetDeg[boneId] = sourceDeg[boneId];
    const srcComX = meanOriginX(forwardKinematics(clip.skeleton, sourceDeg)) * legScale;
    const dstComX = meanOriginX(forwardKinematics(targetRig.skeleton, targetDeg));
    return srcComX - dstComX;
  }

  // events -> seconds, drop channels the target lacks
  const events = clip.events.map((event) => {
    const out = { t: round6((event.f / clip.fps) * timeScale), kind: event.kind };
    if (event.bone) {
      if (targetBones.has(event.bone)) out.bone = event.bone;
      else notes.push({ code: 'event_bone_dropped', bone: event.bone, kind: event.kind });
    }
    return out;
  });

  // param channels pass straight through (retarget never touches face/eye/mouth)
  const paramCurves = {};
  for (const [param, keys] of Object.entries(clip.channels.param)) {
    paramCurves[param] = keys.map((key) => ({
      t: round6((key.f / clip.fps) * timeScale),
      v: round6(key.v),
      ...(key.ease ? { ease: key.ease } : {}),
    }));
  }

  // rootMotion translation scales with leg length; combine with the COM shift
  const rootMotion = clip.rootMotion.map((key) => ({
    t: round6((key.f / clip.fps) * timeScale),
    x: round6(key.x * legScale + comShiftAtFrame(key.f)),
    y: round6(key.y * legScale),
  }));

  return {
    characterId: targetRig.characterId ?? null,
    characterRevision: targetRig.characterRevision ?? null,
    clipId: clip.clipId,
    fps,
    durationSeconds: round6((clip.frameCount / clip.fps) * timeScale),
    boneCurves,
    paramCurves,
    events,
    rootMotion,
    domainEscalations,
    notes,
  };
}

export const motionRetargetLimits = Object.freeze({ legSides: LEG_SIDES });
