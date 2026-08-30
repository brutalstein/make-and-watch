import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AudioGenerationService } from './audio-generation-service.mjs';

const snapshot = {
  projectRevision: 1,
  nodes: [{
    id: 'audio.1', kind: 'audio', title: 'Japanese line', revision: 1,
    approval: 'approved', locked: false, stale: false,
    metadata: { kind: 'dialogue', text: 'こんにちは', language: 'ja' },
  }],
  dependencies: [],
};

const root = await mkdtemp(join(tmpdir(), 'makewatch-audio-cancel-'));
try {
  const applies = [];
  let workerSignal;
  const service = new AudioGenerationService({
    bridge: {
      snapshot: async () => structuredClone(snapshot),
      apply: async (...args) => { applies.push(args); return { projectRevision: 2 }; },
    },
    scheduler: { run: async (_lease, operation) => operation() },
    projectRoot: root,
    artifactRoot: join(root, '.makewatch', 'artifacts', 'audio'),
    workerPath: join(root, 'worker.py'),
    runtimeResolver: async () => ({ python: 'python' }),
    gpuReleaser: async () => undefined,
    workerRunner: async (_python, _workerPath, _requestPath, _resultPath, { signal }) => {
      workerSignal = signal;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  });
  assert.equal(typeof service.cancel, 'function');

  service.activeJobId = 'fixture-held';
  const queued = await service.startAudio('audio.1');
  const queuedCancelled = await service.cancel(queued.id);
  assert.equal(queuedCancelled.status, 'cancelled');
  assert.equal(service.pending.includes(queued.id), false);
  service.activeJobId = null;

  const running = await service.startAudio('audio.1');
  for (let attempt = 0; attempt < 100 && !workerSignal; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(workerSignal?.aborted, false);
  const runningCancelled = await service.cancel(running.id);
  assert.equal(runningCancelled.status, 'cancelled');
  assert.equal(applies.some(([commands]) => commands.some((command) => command.node?.metadata?.status === 'ready' || command.metadataUpdates?.status === 'ready')), false);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('audio generation service checks passed');
