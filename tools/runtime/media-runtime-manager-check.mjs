import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  discoverComfyUiInstallations,
  managedMediaRuntimePaths,
  mediaRuntimeConstants,
} from './media-runtime-manager.mjs';

const temporary = await mkdtemp(join(tmpdir(), 'makewatch-media-runtime-'));
const previousRuntimeHome = process.env.MAKEWATCH_RUNTIME_HOME;
const previousComfyHome = process.env.MAKEWATCH_COMFYUI_HOME;

try {
  process.env.MAKEWATCH_RUNTIME_HOME = join(temporary, 'managed');
  const managed = managedMediaRuntimePaths();
  assert.equal(managed.base, join(temporary, 'managed'));
  assert.equal(mediaRuntimeConstants.comfyPort, 8188);

  const fake = join(temporary, 'existing-ComfyUI');
  await mkdir(fake, { recursive: true });
  await writeFile(join(fake, 'main.py'), 'print("fake")\n', 'utf8');
  process.env.MAKEWATCH_COMFYUI_HOME = fake;

  const candidates = await discoverComfyUiInstallations();
  assert.ok(candidates.some((candidate) => candidate.root === fake));
  const selected = candidates.find((candidate) => candidate.root === fake);
  assert.ok(selected.command);
  assert.ok(selected.args.includes('--disable-auto-launch'));
  assert.ok(selected.args.includes('8188'));

  console.log('media runtime manager check: passed');
} finally {
  if (previousRuntimeHome === undefined) delete process.env.MAKEWATCH_RUNTIME_HOME;
  else process.env.MAKEWATCH_RUNTIME_HOME = previousRuntimeHome;
  if (previousComfyHome === undefined) delete process.env.MAKEWATCH_COMFYUI_HOME;
  else process.env.MAKEWATCH_COMFYUI_HOME = previousComfyHome;
  await rm(temporary, { recursive: true, force: true });
}
