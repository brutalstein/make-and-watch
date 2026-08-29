import assert from 'node:assert/strict';

import {
  buildCameraMotionFilter,
  classifyCameraMove,
  motionAmplitude,
  resolveShotMotion,
} from './camera-motion.mjs';
import { buildTransitionGraph, planSceneTransitions, sceneCacheKey } from './episode-render-service.mjs';

// --- camera intent classification -------------------------------------------
// Free text authored by the Director has to land on the right move, and the
// ordering of the pattern table is what makes "dolly in" a push rather than a
// generic dolly. These are the cases that break if that order is disturbed.
for (const [camera, expected] of [
  ['slow push-in on her face', 'push'],
  ['dolly in', 'push'],
  ['pull back to reveal the city', 'pull'],
  ['dolly out', 'pull'],
  ['orbit around subject', 'orbit'],
  ['handheld, breathing', 'handheld'],
  ['pan left across the wreckage', 'pan-left'],
  ['whip right', 'pan-right'],
  ['tilt up to the sky', 'tilt-up'],
  ['crane down', 'tilt-down'],
  ['tracking shot', 'push'],
  ['locked off', 'static'],
  ['static', 'static'],
  ['', 'static'],
  [null, 'static'],
  ['something the schema never anticipated', 'static'],
]) {
  assert.equal(classifyCameraMove(camera), expected, `camera "${camera}" should classify as ${expected}`);
}

// An unknown motionLevel must not silently become the most aggressive move.
assert.equal(motionAmplitude('high') > motionAmplitude('medium'), true);
assert.equal(motionAmplitude('medium') > motionAmplitude('low'), true);
assert.equal(motionAmplitude('none'), 0);
assert.equal(motionAmplitude('nonsense'), motionAmplitude('low'));

// --- when a shot must stay locked off ---------------------------------------
assert.equal(resolveShotMotion({ camera: 'static', motionLevel: 'high', durationSeconds: 6 }).kind, 'static');
assert.equal(resolveShotMotion({ camera: 'push in', motionLevel: 'none', durationSeconds: 6 }).kind, 'static');
assert.equal(resolveShotMotion({ camera: 'push in', motionLevel: 'high', durationSeconds: 0.05 }).kind, 'static');
assert.equal(resolveShotMotion({ camera: 'push in', motionLevel: 'high', durationSeconds: NaN }).kind, 'static');

// A long take is damped and a short one is boosted, so the same authored intent
// does not read as a zoom stunt at 20s and as nothing at 1s.
const long = resolveShotMotion({ camera: 'push in', motionLevel: 'medium', durationSeconds: 20 });
const short = resolveShotMotion({ camera: 'push in', motionLevel: 'medium', durationSeconds: 1.5 });
const normal = resolveShotMotion({ camera: 'push in', motionLevel: 'medium', durationSeconds: 5 });
assert.equal(long.amplitude < normal.amplitude, true);
assert.equal(short.amplitude > normal.amplitude, true);

// --- filter construction ----------------------------------------------------
// A static shot returns null so the renderer keeps its cheaper still path.
assert.equal(
  buildCameraMotionFilter({ camera: 'locked off', motionLevel: 'high', durationSeconds: 5, fps: 24, width: 1024, height: 576 }),
  null,
);

const push = buildCameraMotionFilter({
  camera: 'slow push-in',
  motionLevel: 'medium',
  durationSeconds: 5,
  fps: 24,
  width: 1024,
  height: 576,
});
assert.equal(push.motion.kind, 'push');
assert.equal(push.frames, 120);
// Motion is computed on an oversampled canvas because zoompan quantises its
// crop origin to whole source pixels; losing that makes the move stair-step.
assert.equal(push.workWidth > 1024 && push.workHeight > 576, true);
assert.equal(push.workWidth % 2 === 0 && push.workHeight % 2 === 0, true);
assert.ok(push.filter.includes('zoompan='));
assert.ok(push.filter.includes('fps=24'));
// The chain must end back at the delivery size and in a pixel format x264 takes.
assert.ok(push.filter.endsWith('scale=1024:576:flags=bicubic,format=yuv420p'));
// Easing, not a straight ramp.
assert.ok(push.filter.includes('(3-2*'));

// Every non-static move must produce a syntactically complete zoompan with all
// three driven expressions, or ffmpeg fails at render time rather than here.
for (const camera of ['push in', 'pull out', 'pan left', 'pan right', 'tilt up', 'tilt down', 'orbit', 'handheld']) {
  const built = buildCameraMotionFilter({
    camera,
    motionLevel: 'medium',
    durationSeconds: 4,
    fps: 24,
    width: 1024,
    height: 576,
  });
  assert.ok(built, `${camera} should produce a motion filter`);
  const zoompan = built.filter.split(',').find((part) => part.startsWith('zoompan='));
  assert.ok(zoompan, `${camera} should emit a zoompan stage`);
  for (const key of ["z='", "x='", "y='"]) {
    assert.ok(zoompan.includes(key), `${camera} zoompan should drive ${key[0]}`);
  }
  // A quote left open would silently swallow the rest of the chain.
  assert.equal((zoompan.match(/'/g) ?? []).length % 2, 0, `${camera} zoompan quoting must be balanced`);
}

// Pans and tilts hold a constant crop and travel inside it; a changing zoom
// there would read as a push wearing a pan's name.
const pan = buildCameraMotionFilter({
  camera: 'pan right',
  motionLevel: 'medium',
  durationSeconds: 4,
  fps: 24,
  width: 1024,
  height: 576,
});
assert.ok(/zoompan=z='[\d.]+'/.test(pan.filter), 'a pan should hold a fixed zoom');

// --- scene transition planning ----------------------------------------------
const shot = (durationSeconds, transitionOut) => ({ durationSeconds, transitionOut });

// An all-cut scene keeps the cheap stream-copy concat path.
assert.equal(planSceneTransitions([shot(4, 'cut'), shot(4, 'cut')], 24), null);
assert.equal(planSceneTransitions([shot(4, 'match-cut'), shot(4, 'cut')], 24), null);
assert.equal(planSceneTransitions([shot(4, 'fade')], 24), null, 'a lone shot has nothing to dissolve into');

const plans = planSceneTransitions([shot(15, 'fade'), shot(15, 'dissolve'), shot(15, 'cut'), shot(15, 'cut')], 24);
assert.ok(plans);
// An xfade eats time from both sides, so each giving shot renders longer by
// exactly its overlap. Without this the episode timeline drifts short.
assert.equal(plans[0].renderDuration, 15.5);
assert.equal(plans[1].renderDuration, 15.5);
assert.equal(plans[2].renderDuration, 15);
assert.equal(plans[3].renderDuration, 15);

const graph = buildTransitionGraph(plans);
assert.equal(Number(graph.totalSeconds.toFixed(6)), 60, 'assembled scene must equal the sum of authored durations');
assert.equal(graph.outputLabel, 'vout');
assert.ok(graph.filter.includes('xfade=transition=fade:duration=0.500000:offset=15.000000'));
assert.ok(graph.filter.includes('offset=30.000000'), 'later offsets must accumulate without drift');
// A hard cut inside an otherwise dissolved scene still has to route through the
// graph, or the segments after it are dropped from the output.
assert.ok(graph.filter.includes('concat=n=2:v=1:a=0[vout]'));

// An overlap may never eat more than half of either side.
const tight = planSceneTransitions([shot(0.4, 'fade'), shot(6, 'cut')], 24);
assert.equal(tight[0].overlap, 0.2);
assert.equal(Number(buildTransitionGraph(tight).totalSeconds.toFixed(6)), 6.4);

// Below one frame there is nothing for xfade to interpolate across, so the join
// degrades to a cut rather than emitting an impossible duration.
assert.equal(planSceneTransitions([shot(0.06, 'fade'), shot(6, 'cut')], 24), null);

// Render-affecting edits must invalidate the scene cache; otherwise a new
// camera direction or transition can return an older frozen master.
const cacheManifest = { profile: { width: 1280, height: 720, fps: 24 } };
const cacheScene = {
  durationSeconds: 6,
  transitionIn: 'cut',
  transitionOut: 'cut',
  shots: [{
    id: 'shot.1', durationSeconds: 6, strategy: 'STILL_MOTION', camera: 'static',
    motionLevel: 'low', transitionOut: 'cut', media: { sha256: 'abc', mediaType: 'image' },
  }],
  audio: [],
};
const staticKey = sceneCacheKey(cacheManifest, cacheScene);
assert.notEqual(sceneCacheKey(cacheManifest, {
  ...cacheScene,
  shots: [{ ...cacheScene.shots[0], camera: 'push in' }],
}), staticKey);
assert.notEqual(sceneCacheKey(cacheManifest, {
  ...cacheScene,
  shots: [{ ...cacheScene.shots[0], motionLevel: 'high' }],
}), staticKey);
assert.notEqual(sceneCacheKey(cacheManifest, {
  ...cacheScene,
  shots: [{ ...cacheScene.shots[0], transitionOut: 'fade' }],
}), staticKey);

console.log('camera motion + scene transition check: passed');
