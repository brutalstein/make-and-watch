import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EpisodeRenderService } from './episode-render-service.mjs';

const root = await mkdtemp(join(tmpdir(), 'makewatch-render-cancel-'));
try {
  await mkdir(join(root, '.makewatch', 'artifacts'), { recursive: true });
  await writeFile(join(root, '.makewatch', 'artifacts', 'shot.mp4'), Buffer.alloc(2048));
  const manifest = {
    ready: true,
    issues: [],
    episode: { id: 'episode.1', title: 'Episode 1', revision: 1, durationSeconds: 4 },
    profile: { width: 1280, height: 720, fps: 24 },
    scenes: [{
      id: 'scene.1', startSeconds: 0, durationSeconds: 4, transitionIn: 'cut', transitionOut: 'cut',
      shots: [{
        id: 'shot.1', durationSeconds: 4, strategy: 'I2V', transitionOut: 'cut',
        media: { mediaType: 'video', relativePath: 'artifacts/shot.mp4', sha256: 'a'.repeat(64), durationSeconds: 4 },
      }],
      audio: [],
    }],
  };
  const applies = [];
  let processSignal;
  const service = new EpisodeRenderService({
    bridge: {
      snapshot: async () => ({ projectRevision: 1, nodes: [], dependencies: [] }),
      apply: async (...args) => { applies.push(args); },
    },
    projectRoot: root,
    artifactRoot: join(root, '.makewatch', 'artifacts', 'episodes'),
    cacheRoot: join(root, '.makewatch', 'cache'),
    compositionCompiler: () => structuredClone(manifest),
    ffmpegResolver: async () => ({ ffmpeg: 'fixture-ffmpeg' }),
    processRunner: async (_command, _args, { signal }) => {
      processSignal = signal;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  });
  assert.equal(typeof service.cancel, 'function');

  service.activeJobId = 'fixture-held';
  const queued = await service.startEpisode('episode.1');
  const queuedCancelled = await service.cancel(queued.id);
  assert.equal(queuedCancelled.status, 'cancelled');
  assert.equal(service.pending.includes(queued.id), false);
  service.activeJobId = null;

  const running = await service.startEpisode('episode.1');
  for (let attempt = 0; attempt < 100 && !processSignal; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(processSignal?.aborted, false);
  const runningCancelled = await service.cancel(running.id);
  assert.equal(runningCancelled.status, 'cancelled');
  assert.equal(applies.length, 0, 'cancelled render cannot commit success provenance');
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('episode render service checks passed');
