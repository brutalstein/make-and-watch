import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FramePackTemporalProvider } from './framepack-temporal-provider.mjs';

const root = await mkdtemp(join(tmpdir(), 'makewatch-framepack-provider-'));
try {
  const makewatch = join(root, '.makewatch');
  await mkdir(join(makewatch, 'artifacts'), { recursive: true });
  await writeFile(join(makewatch, 'artifacts', 'hero.png'), Buffer.alloc(2048, 7));

  const runtimeResolver = async () => ({
    installed: true,
    selected: {
      root: join(root, 'FramePack'),
      kind: 'source',
      sourceEntry: join(root, 'FramePack', 'demo_gradio.py'),
      python: join(root, 'FramePack', '.venv', 'python'),
    },
    hardware: { readyForAttempt: true, totalVramMb: 8192 },
    detail: 'ready',
  });
  const workerRunner = async (_python, _workerPath, requestPath) => {
    const request = JSON.parse(await readFile(requestPath, 'utf8'));
    assert.equal(request.durationSeconds, 5);
    assert.equal(request.prompt, 'Alex turns toward the window.');
    await writeFile(request.outputFile, Buffer.alloc(4096, 9));
    return { payload: { teacache: true, steps: 25 } };
  };
  const videoProbe = async () => ({ durationSeconds: 5.02, width: 640, height: 360, fps: 30 });
  const provider = new FramePackTemporalProvider({
    projectRoot: root,
    workerPath: join(root, 'worker.py'),
    runtimeResolver,
    workerRunner,
    videoProbe,
  });

  const status = await provider.status({ hardware: { totalVramMb: 8192 } });
  assert.equal(status.ready, true);
  assert.deepEqual(provider.strategies, ['I2V']);

  const artifact = await provider.generate({
    shot: {
      id: 'shot.1',
      revision: 3,
      strategy: 'I2V',
      durationSeconds: 5,
      qualityTier: 'preview',
      temporalPrompt: 'Alex turns toward the window.',
      subjectAction: '',
      negativePrompt: '',
      seed: '',
    },
    inputs: {
      startFrame: { id: 'asset.hero', relativePath: 'artifacts/hero.png', sha256: 'hero' },
    },
  }, { hardware: { totalVramMb: 8192 } });

  assert.equal(artifact.mediaType, 'video');
  assert.equal(artifact.durationSeconds, 5.02);
  assert.equal(artifact.width, 640);
  assert.equal(artifact.height, 360);
  assert.equal(artifact.fps, 30);
  assert.equal(artifact.sha256.length, 64);
  assert.match(artifact.relativePath, /^artifacts\/video\/shot.1\//);
  assert.equal(artifact.providerMetadata.teacache, true);

  await assert.rejects(() => provider.generate({
    shot: { id: 'shot.long', strategy: 'I2V', durationSeconds: 9, temporalPrompt: 'move' },
    inputs: { startFrame: { relativePath: 'artifacts/hero.png' } },
  }), /1\.\.8s/);
  await assert.rejects(() => provider.generate({
    shot: { id: 'shot.video', strategy: 'VIDEO', durationSeconds: 5, temporalPrompt: 'move' },
    inputs: { startFrame: { relativePath: 'artifacts/hero.png' } },
  }), /supports I2V only/);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('FramePack temporal provider checks passed');
