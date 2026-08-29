import assert from 'node:assert/strict';
import { compileEpisodeComposition } from './episode-composition.mjs';

const snapshot = {
  schemaVersion: 1,
  projectRevision: 42,
  nodes: [
    { id: 'series.1', kind: 'series', title: 'Series', metadata: { fps: '24', targetEpisodeMinutes: '20', language: 'tr' }, revision: 1, approval: 'approved', locked: false, stale: false },
    { id: 'episode.1', kind: 'episode', title: 'Pilot', metadata: { renderProfile: 'preview-720p', targetDurationSeconds: '1200' }, revision: 1, approval: 'approved', locked: false, stale: false },
    { id: 'scene.1', kind: 'scene', title: 'Opening', metadata: { index: '1', durationSeconds: '8', summary: 'Opening beat' }, revision: 1, approval: 'approved', locked: false, stale: false },
    { id: 'shot.1', kind: 'shot', title: 'Wide', metadata: { index: '1', durationSeconds: '5', generationStrategy: 'STILL_MOTION' }, revision: 1, approval: 'approved', locked: false, stale: false },
    { id: 'generation.preview.shot.1', kind: 'generation', title: 'Visual', metadata: { status: 'ready', mediaType: 'image' }, revision: 2, approval: 'draft', locked: false, stale: false },
    { id: 'asset.image', kind: 'asset', title: 'Image', metadata: { mediaType: 'image', relativePath: 'artifacts/scenes/a.png', mimeType: 'image/png', sha256: 'abc', width: '768', height: '432' }, revision: 1, approval: 'draft', locked: false, stale: false },
    { id: 'audio.1', kind: 'audio', title: 'Line', metadata: { kind: 'dialogue', text: 'Merhaba.', language: 'tr', subtitle: 'true' }, revision: 1, approval: 'draft', locked: false, stale: false },
    { id: 'generation.audio.audio.1', kind: 'generation', title: 'Voice', metadata: { status: 'ready', mediaType: 'audio' }, revision: 2, approval: 'draft', locked: false, stale: false },
    { id: 'asset.audio', kind: 'asset', title: 'Audio', metadata: { mediaType: 'audio', relativePath: 'artifacts/audio/a.wav', mimeType: 'audio/wav', sha256: 'def', durationSeconds: '2.25' }, revision: 1, approval: 'draft', locked: false, stale: false },
  ],
  dependencies: [
    { dependent: 'episode.1', dependency: 'series.1' },
    { dependent: 'scene.1', dependency: 'episode.1' },
    { dependent: 'shot.1', dependency: 'scene.1' },
    { dependent: 'generation.preview.shot.1', dependency: 'shot.1' },
    { dependent: 'asset.image', dependency: 'generation.preview.shot.1' },
    { dependent: 'audio.1', dependency: 'scene.1' },
    { dependent: 'generation.audio.audio.1', dependency: 'audio.1' },
    { dependent: 'asset.audio', dependency: 'generation.audio.audio.1' },
  ],
};

const manifest = compileEpisodeComposition(snapshot, 'episode.1');
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.profile.width, 1280);
assert.equal(manifest.profile.height, 720);
assert.equal(manifest.profile.fps, 24);
assert.equal(manifest.scenes.length, 1);
assert.equal(manifest.scenes[0].shots.length, 1);
assert.equal(manifest.scenes[0].shots[0].media.assetId, 'asset.image');
assert.equal(manifest.scenes[0].shots[0].durationInFrames, 120);
assert.equal(manifest.scenes[0].audio[0].media.assetId, 'asset.audio');
assert.equal(manifest.scenes[0].audio[0].durationSeconds, 2.25);
assert.equal(manifest.scenes[0].durationSeconds, 8);
assert.equal(manifest.episode.durationSeconds, 8);
assert.equal(manifest.stats.generatedVisualCount, 1);
assert.equal(manifest.stats.generatedAudioCount, 1);
assert.equal(manifest.ready, true);
assert.ok(manifest.warnings.some((warning) => warning.includes('1200.0s')));

const broken = structuredClone(snapshot);
broken.nodes = broken.nodes.filter((node) => node.id !== 'asset.image');
const brokenManifest = compileEpisodeComposition(broken, 'episode.1');
assert.equal(brokenManifest.ready, false);
assert.ok(brokenManifest.issues.some((issue) => issue.includes('no ready generated visual Asset')));

console.log('episode composition compiler check: passed');
