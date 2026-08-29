import assert from 'node:assert/strict';

import { buildStoryboardWorkflow } from './comfyui-client.mjs';

const workflow = buildStoryboardWorkflow({
  checkpoint: 'model.safetensors',
  prompt: 'cinematic scene',
  negativePrompt: 'watermark',
  width: 777,
  height: 433,
  seed: 42,
  steps: 24,
  cfg: 7,
  sampler: 'euler',
  scheduler: 'normal',
  filenamePrefix: 'MakeWatch/test',
});

assert.equal(workflow['1'].class_type, 'CheckpointLoaderSimple');
assert.equal(workflow['1'].inputs.ckpt_name, 'model.safetensors');
assert.equal(workflow['4'].inputs.width % 8, 0);
assert.equal(workflow['4'].inputs.height % 8, 0);
assert.equal(workflow['5'].inputs.seed, 42);
assert.equal(workflow['5'].inputs.model[0], '1');
assert.equal(workflow['6'].inputs.samples[0], '5');
assert.equal(workflow['7'].inputs.images[0], '6');
assert.equal(workflow['7'].inputs.filename_prefix, 'MakeWatch/test');

console.log('comfyui client contract check: passed');
