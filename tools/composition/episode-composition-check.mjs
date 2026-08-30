import assert from 'node:assert/strict';
import { compileEpisodeComposition } from './episode-composition.mjs';

const snapshot = {
  schemaVersion: 1,
  projectRevision: 42,
  nodes: [
    { id: 'series.1', kind: 'series', title: 'Series', metadata: { fps: '24', targetEpisodeMinutes: '20', language: 'tr' }, revision: 1, approval: 'approved', locked: false, stale: false },
    { id: 'episode.1', kind: 'episode', title: 'Pilot', metadata: { renderProfile: 'preview-720p', targetDurationSeconds: '1200' }, revision: 1, approval: 'approved', locked: false, stale: false },
    { id: 'scene.1', kind: 'scene', title: 'Opening', metadata: { index: '1', durationSeconds: '8', summary: 'Opening beat' }, revision: 1, approval: 'approved', locked: false, stale: false },
    { id: 'shot.1', kind: 'shot', title: 'Wide', metadata: { index: '1', durationSeconds: '5', generationStrategy: 'I2V' }, revision: 1, approval: 'approved', locked: false, stale: false },
    { id: 'generation.video.shot.1', kind: 'generation', title: 'Temporal visual', metadata: { status: 'ready', mediaType: 'video' }, revision: 2, approval: 'draft', locked: false, stale: false },
    { id: 'asset.video', kind: 'asset', title: 'Video', metadata: { mediaType: 'video', relativePath: 'artifacts/scenes/a.mp4', mimeType: 'video/mp4', sha256: 'abc', width: '768', height: '432', durationSeconds: '5.1' }, revision: 1, approval: 'draft', locked: false, stale: false },
    { id: 'audio.1', kind: 'audio', title: 'Line', metadata: { kind: 'dialogue', text: 'Merhaba.', language: 'tr', subtitle: 'true' }, revision: 1, approval: 'draft', locked: false, stale: false },
    { id: 'generation.audio.audio.1', kind: 'generation', title: 'Voice', metadata: { status: 'ready', mediaType: 'audio' }, revision: 2, approval: 'draft', locked: false, stale: false },
    { id: 'asset.audio', kind: 'asset', title: 'Audio', metadata: { mediaType: 'audio', relativePath: 'artifacts/audio/a.wav', mimeType: 'audio/wav', sha256: 'def', durationSeconds: '2.25' }, revision: 1, approval: 'draft', locked: false, stale: false },
  ],
  dependencies: [
    { dependent: 'episode.1', dependency: 'series.1' },
    { dependent: 'scene.1', dependency: 'episode.1' },
    { dependent: 'shot.1', dependency: 'scene.1' },
    { dependent: 'generation.video.shot.1', dependency: 'shot.1' },
    { dependent: 'asset.video', dependency: 'generation.video.shot.1' },
    { dependent: 'audio.1', dependency: 'scene.1' },
    { dependent: 'generation.audio.audio.1', dependency: 'audio.1' },
    { dependent: 'asset.audio', dependency: 'generation.audio.audio.1' },
  ],
};

const manifest = compileEpisodeComposition(snapshot, 'episode.1');
assert.equal(manifest.schemaVersion, 2);
assert.equal(manifest.profile.width, 1280);
assert.equal(manifest.profile.height, 720);
assert.equal(manifest.profile.fps, 24);
assert.equal(manifest.scenes.length, 1);
assert.equal(manifest.scenes[0].shots.length, 1);
assert.equal(manifest.scenes[0].shots[0].media.assetId, 'asset.video');
assert.equal(manifest.scenes[0].shots[0].media.mediaType, 'video');
assert.equal(manifest.scenes[0].shots[0].durationInFrames, 120);
assert.equal(manifest.scenes[0].audio[0].media.assetId, 'asset.audio');
assert.equal(manifest.scenes[0].audio[0].durationSeconds, 2.25);
assert.equal(manifest.scenes[0].durationSeconds, 8);
assert.equal(manifest.episode.durationSeconds, 8);
assert.equal(manifest.stats.generatedVisualCount, 1);
assert.equal(manifest.stats.generatedAudioCount, 1);
assert.equal(manifest.ready, true);
assert.ok(manifest.warnings.some((warning) => warning.includes('1200.0s')));

const missingVideo = structuredClone(snapshot);
missingVideo.nodes = missingVideo.nodes.filter((node) => node.id !== 'asset.video');
const missingVideoManifest = compileEpisodeComposition(missingVideo, 'episode.1');
assert.equal(missingVideoManifest.ready, false);
assert.ok(missingVideoManifest.issues.some((issue) => issue.includes('no ready temporal video Asset')));

const stillOnly = structuredClone(snapshot);
stillOnly.nodes = stillOnly.nodes.filter((node) => !['generation.video.shot.1', 'asset.video'].includes(node.id));
stillOnly.dependencies = stillOnly.dependencies.filter((edge) => !['generation.video.shot.1', 'asset.video'].includes(edge.dependent));
stillOnly.nodes.push(
  { id: 'generation.image.shot.1', kind: 'generation', title: 'Hero frame', metadata: { status: 'ready', mediaType: 'image' }, revision: 3, approval: 'draft', locked: false, stale: false },
  { id: 'asset.image', kind: 'asset', title: 'Hero frame', metadata: { mediaType: 'image', relativePath: 'artifacts/scenes/a.png', mimeType: 'image/png', sha256: 'still' }, revision: 1, approval: 'draft', locked: false, stale: false },
);
stillOnly.dependencies.push(
  { dependent: 'generation.image.shot.1', dependency: 'shot.1' },
  { dependent: 'asset.image', dependency: 'generation.image.shot.1' },
);
const stillManifest = compileEpisodeComposition(stillOnly, 'episode.1');
assert.equal(stillManifest.ready, false);
assert.equal(stillManifest.scenes[0].shots[0].media, null, 'hero images must never satisfy final Shot media');

const legacyStrategy = structuredClone(snapshot);
legacyStrategy.nodes = legacyStrategy.nodes.map((node) => node.id === 'shot.1'
  ? { ...node, metadata: { ...node.metadata, generationStrategy: 'STILL_MOTION' } }
  : node);
const legacyManifest = compileEpisodeComposition(legacyStrategy, 'episode.1');
assert.equal(legacyManifest.ready, false);
assert.ok(legacyManifest.issues.some((issue) => issue.includes('still-image Shot output was removed')));

const tooShort = structuredClone(snapshot);
tooShort.nodes = tooShort.nodes.map((node) => node.id === 'asset.video'
  ? { ...node, metadata: { ...node.metadata, durationSeconds: '3.0' } }
  : node);
const tooShortManifest = compileEpisodeComposition(tooShort, 'episode.1');
assert.equal(tooShortManifest.ready, false);
assert.ok(tooShortManifest.issues.some((issue) => issue.includes('regenerate the Shot instead of freezing frames')));

console.log('episode temporal composition compiler check: passed');
