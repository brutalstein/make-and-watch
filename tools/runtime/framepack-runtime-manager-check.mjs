import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  discoverFramePackInstallations,
  framePackHardwareAssessment,
  framePackRuntimeStatus,
} from './framepack-runtime-manager.mjs';

const priorHome = process.env.MAKEWATCH_FRAMEPACK_HOME;
const root = await mkdtemp(join(tmpdir(), 'makewatch-framepack-'));
try {
  await mkdir(join(root, 'diffusers_helper'), { recursive: true });
  await writeFile(join(root, 'demo_gradio.py'), '# fixture\n', 'utf8');
  process.env.MAKEWATCH_FRAMEPACK_HOME = root;

  const installations = await discoverFramePackInstallations();
  assert.equal(installations[0].root, root);
  assert.equal(installations[0].kind, 'source');

  const eightGb = framePackHardwareAssessment({ gpuName: 'NVIDIA GeForce RTX 5070 Laptop GPU', totalVramMb: 8192 });
  assert.equal(eightGb.readyForAttempt, true);
  assert.equal(eightGb.minimumVramMb, 6144);
  assert.equal(eightGb.recommendedExclusiveGpu, true);
  assert.equal(eightGb.recommendedReserveVramMb, 1536);

  const insufficient = framePackHardwareAssessment({ gpuName: 'NVIDIA RTX', totalVramMb: 4096 });
  assert.equal(insufficient.readyForAttempt, false);

  const status = await framePackRuntimeStatus({ gpuName: 'NVIDIA RTX 5070', totalVramMb: 8192 });
  assert.equal(status.installed, true);
  assert.equal(status.automaticBootstrap, false);
  assert.equal(status.bootstrapPolicy, 'explicit-only');
  assert.ok(status.modelDownloadWarningGb >= 30);
} finally {
  if (priorHome === undefined) delete process.env.MAKEWATCH_FRAMEPACK_HOME;
  else process.env.MAKEWATCH_FRAMEPACK_HOME = priorHome;
  await rm(root, { recursive: true, force: true });
}

console.log('FramePack runtime manager checks passed');
