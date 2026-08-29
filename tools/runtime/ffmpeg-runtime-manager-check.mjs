import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { discoverFfmpegRuntime, managedFfmpegPaths } from './ffmpeg-runtime-manager.mjs';

const previousFfmpeg = process.env.MAKEWATCH_FFMPEG;
const previousRuntimeHome = process.env.MAKEWATCH_RUNTIME_HOME;
try {
  process.env.MAKEWATCH_FFMPEG = process.execPath;
  process.env.MAKEWATCH_RUNTIME_HOME = join(tmpdir(), 'makewatch-ffmpeg-runtime-check');
  const discovered = await discoverFfmpegRuntime();
  assert.ok(discovered);
  assert.equal(discovered.ffmpeg, process.execPath);
  assert.equal(discovered.ownership, 'external');
  assert.equal(discovered.source, 'MAKEWATCH_FFMPEG');
  assert.equal(dirname(managedFfmpegPaths().base), process.env.MAKEWATCH_RUNTIME_HOME);
  console.log('ffmpeg runtime manager check: passed');
} finally {
  if (previousFfmpeg === undefined) delete process.env.MAKEWATCH_FFMPEG;
  else process.env.MAKEWATCH_FFMPEG = previousFfmpeg;
  if (previousRuntimeHome === undefined) delete process.env.MAKEWATCH_RUNTIME_HOME;
  else process.env.MAKEWATCH_RUNTIME_HOME = previousRuntimeHome;
}
