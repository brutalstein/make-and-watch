import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NativeAnimeTemporalProvider } from './native-anime-provider.mjs';

const root = await mkdtemp(join(tmpdir(), 'makewatch-native-anime-'));
try {
  const media = join(root, '.makewatch', 'anime', 'slice');
  await mkdir(media, { recursive: true });
  await mkdir(join(root, '.makewatch', 'artifacts', 'scenes', 's'), { recursive: true });
  for (const name of ['bg.png', 'body.png', 'eyes.png', 'mouth.png', 'hair.png']) {
    await writeFile(join(media, name), Buffer.alloc(4096, 3));
  }
  await writeFile(join(media, 'line.wav'), Buffer.alloc(8192, 5));
  await writeFile(join(root, '.makewatch', 'artifacts', 'scenes', 's', 'hero.png'), Buffer.alloc(4096, 7));

  const pythonResolver = async () => ({ python: 'python', launcher: 'python', numpy: '2.4.4', pillow: '12.2.0', opencv: '5.0.0' });
  const ffmpegResolver = async () => ({ ffmpeg: '/x/ffmpeg', ffprobe: '/x/ffprobe' });
  let workerRequest = null;
  const workerRunner = async (_python, _workerPath, requestPath, options) => {
    assert.equal(options.signal.aborted, false);
    workerRequest = JSON.parse(await readFile(requestPath, 'utf8'));
    await writeFile(workerRequest.outputFile, Buffer.alloc(64 * 1024, 9));
    return { payload: { framesSha256: 'f'.repeat(64), frameCount: workerRequest.shotAnim.frameCount, persistedIntermediateFrames: 0 } };
  };
  const videoProbe = async () => ({ durationSeconds: 4.0, width: 1920, height: 1080, fps: 24, hasAudio: true });

  const provider = new NativeAnimeTemporalProvider({
    projectRoot: root,
    workerPath: join(root, 'worker.py'),
    pythonResolver, ffmpegResolver, workerRunner, videoProbe,
    acceptsProductionRequests: true,
  });

  assert.deepEqual(provider.strategies, ['I2V']);
  const status = await provider.status();
  assert.equal(status.installed, true);
  assert.equal(status.ready, true);
  assert.equal(status.runtime.residentVideoModel, false);

  const shotAnim = {
    schema: 'makewatch.shotAnim/1',
    shotId: 'shot.slice.01',
    durationSeconds: 4,
    fps: 24,
    resolution: [1920, 1080],
    layers: [
      { id: 'bg', part: 'plate', path: 'anime/slice/bg.png', z: 0, parallax: 0.2 },
      { id: 'body', part: 'torso', path: 'anime/slice/body.png', z: 10 },
      { id: 'eyes', part: 'eyes', path: 'anime/slice/eyes.png', z: 20 },
      { id: 'mouth', part: 'mouth', path: 'anime/slice/mouth.png', z: 21, pivot: [0.5, 0.1] },
      { id: 'front_hair', part: 'front_hair', path: 'anime/slice/hair.png', z: 30, pivot: [0.5, 0.1], dynamic: { segments: 3 } },
    ],
    dialogue: [{ id: 'dlg.01', startSeconds: 0.6, audioPath: 'anime/slice/line.wav', mouthSource: 'vad' }],
    subtitles: [{ text: 'Yağmur yağıyor.', startSeconds: 0.6, endSeconds: 3.4 }],
    grain: 0.04,
  };

  const artifact = await provider.generate(
    { shot: { id: 'shot.slice.01', strategy: 'I2V', durationSeconds: 4 }, shotAnim },
    { signal: new AbortController().signal },
  );
  assert.equal(artifact.mediaType, 'video');
  assert.equal(artifact.sha256.length, 64);
  assert.equal(artifact.durationSeconds, 4.0);
  assert.equal(artifact.width, 1920);
  assert.match(artifact.relativePath, /^artifacts\/video\/shot.slice.01\//);
  assert.equal(artifact.providerMetadata.engine, 'native-anime');
  assert.equal(artifact.providerMetadata.residentVideoModel, false);
  assert.equal(artifact.providerMetadata.frameCachePersisted, false);
  assert.equal(artifact.providerMetadata.layerCount, 5);
  assert.equal(artifact.providerMetadata.dynamicChains, 1);
  assert.equal(artifact.providerMetadata.framesSha256, 'f'.repeat(64));
  assert.equal(artifact.providerMetadata.hasAudio, true);
  assert.equal(workerRequest.shotAnim.frameCount, 96, 'worker gets a normalized ShotAnim');

  await assert.rejects(() => provider.generate({
    shot: { id: 'shot.hold', strategy: 'I2V', durationSeconds: 5 },
    inputs: { startFrame: { relativePath: 'artifacts/scenes/s/hero.png' } },
  }), /requires an authored ShotAnim/);

  await assert.rejects(() => provider.generate({ shot: { id: 's', strategy: 'VIDEO', durationSeconds: 4 }, shotAnim }), /supports I2V only/);
  await assert.rejects(() => provider.generate({ shot: { id: 's', strategy: 'I2V', durationSeconds: 99 }, shotAnim }), /1\.\.20s/);
  await assert.rejects(() => provider.generate({
    shot: { id: 's', strategy: 'I2V', durationSeconds: 4 },
    shotAnim: { ...shotAnim, layers: [{ id: 'x', part: 'torso', path: 'anime/slice/missing.png' }] },
  }), /input asset is missing/);
  await assert.rejects(() => provider.generate({ shot: { id: 's', strategy: 'I2V', durationSeconds: 4 } }), /requires an authored ShotAnim/);

  const productionBlocked = new NativeAnimeTemporalProvider({
    projectRoot: root, workerPath: join(root, 'worker.py'),
    pythonResolver, ffmpegResolver, workerRunner, videoProbe,
  });
  const blockedStatus = await productionBlocked.status();
  assert.equal(blockedStatus.installed, true);
  assert.equal(blockedStatus.ready, false);
  assert.equal(blockedStatus.runtime.rendererReady, true);
  assert.equal(blockedStatus.runtime.shotAnimCompilerReady, false);
  assert.match(blockedStatus.detail, /ShotAnim compiler is not wired/);

  const offline = new NativeAnimeTemporalProvider({
    projectRoot: root, workerPath: join(root, 'worker.py'),
    pythonResolver: async () => null, ffmpegResolver, workerRunner, videoProbe,
  });
  assert.equal((await offline.status()).ready, false);
  await assert.rejects(() => offline.generate({ shot: { id: 's', strategy: 'I2V', durationSeconds: 4 }, shotAnim }), /numpy, Pillow and OpenCV/);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('native anime provider checks passed');
