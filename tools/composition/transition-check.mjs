import assert from 'node:assert/strict';

import { buildTransitionGraph, planSceneTransitions, sceneCacheKey } from './episode-render-service.mjs';

const shot = (durationSeconds, transitionOut) => ({ durationSeconds, transitionOut });

assert.equal(planSceneTransitions([shot(4, 'cut'), shot(4, 'cut')], 24), null);
assert.equal(planSceneTransitions([shot(4, 'match-cut'), shot(4, 'cut')], 24), null);
assert.equal(planSceneTransitions([shot(4, 'fade')], 24), null, 'a lone shot has nothing to dissolve into');

const plans = planSceneTransitions([shot(15, 'fade'), shot(15, 'dissolve'), shot(15, 'cut'), shot(15, 'cut')], 24);
assert.ok(plans);
assert.equal(plans[0].renderDuration, 15.5);
assert.equal(plans[1].renderDuration, 15.5);
assert.equal(plans[2].renderDuration, 15);
assert.equal(plans[3].renderDuration, 15);

const graph = buildTransitionGraph(plans);
assert.equal(Number(graph.totalSeconds.toFixed(6)), 60, 'assembled scene must equal the sum of authored durations');
assert.equal(graph.outputLabel, 'vout');
assert.ok(graph.filter.includes('xfade=transition=fade:duration=0.500000:offset=15.000000'));
assert.ok(graph.filter.includes('offset=30.000000'), 'later offsets must accumulate without drift');
assert.ok(graph.filter.includes('concat=n=2:v=1:a=0[vout]'));

const tight = planSceneTransitions([shot(0.4, 'fade'), shot(6, 'cut')], 24);
assert.equal(tight[0].overlap, 0.2);
assert.equal(Number(buildTransitionGraph(tight).totalSeconds.toFixed(6)), 6.4);
assert.equal(planSceneTransitions([shot(0.06, 'fade'), shot(6, 'cut')], 24), null);

const cacheManifest = { profile: { width: 1280, height: 720, fps: 24 } };
const cacheScene = {
  durationSeconds: 6,
  transitionIn: 'cut',
  transitionOut: 'cut',
  shots: [{
    id: 'shot.1', durationSeconds: 6, strategy: 'I2V', transitionOut: 'cut',
    media: { sha256: 'video-a', mediaType: 'video', durationSeconds: 6.1 },
  }],
  audio: [],
};
const baseKey = sceneCacheKey(cacheManifest, cacheScene);
assert.notEqual(sceneCacheKey(cacheManifest, {
  ...cacheScene,
  shots: [{ ...cacheScene.shots[0], transitionOut: 'fade' }],
}), baseKey);
assert.notEqual(sceneCacheKey(cacheManifest, {
  ...cacheScene,
  shots: [{ ...cacheScene.shots[0], media: { ...cacheScene.shots[0].media, sha256: 'video-b' } }],
}), baseKey);
assert.notEqual(sceneCacheKey(cacheManifest, {
  ...cacheScene,
  shots: [{ ...cacheScene.shots[0], media: { ...cacheScene.shots[0].media, durationSeconds: 6.8 } }],
}), baseKey);

console.log('temporal video transition + scene cache check: passed');
