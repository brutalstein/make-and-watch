import assert from 'node:assert/strict';

import { buildReferenceImageWorkflow, buildStoryboardWorkflow, ComfyUiClient } from './comfyui-client.mjs';

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

const reference = buildReferenceImageWorkflow({
  checkpoint: 'anime-xl.safetensors',
  uploadedImage: 'MakeWatch/references/mira.png',
  prompt: 'anime cinematic portrait, preserve recognizable facial proportions',
  negativePrompt: 'identity drift, text, watermark',
  seed: 1337,
  steps: 30,
  cfg: 5.5,
  denoise: 0.62,
  sampler: 'euler',
  scheduler: 'normal',
  filenamePrefix: 'MakeWatch/reference/mira',
});
assert.equal(reference['4'].class_type, 'LoadImage');
assert.equal(reference['4'].inputs.image, 'MakeWatch/references/mira.png');
assert.equal(reference['5'].class_type, 'VAEEncode');
assert.deepEqual(reference['5'].inputs.pixels, ['4', 0]);
assert.deepEqual(reference['5'].inputs.vae, ['1', 2]);
assert.equal(reference['6'].class_type, 'KSampler');
assert.deepEqual(reference['6'].inputs.latent_image, ['5', 0]);
assert.equal(reference['6'].inputs.denoise, 0.62);
assert.equal(reference['6'].inputs.seed, 1337);
assert.deepEqual(reference['7'].inputs.samples, ['6', 0]);
assert.deepEqual(reference['8'].inputs.images, ['7', 0]);
assert.equal(reference['8'].inputs.filename_prefix, 'MakeWatch/reference/mira');

const cancellable = new ComfyUiClient({ timeoutMs: 10_000, pollMs: 100 });
cancellable.json = async () => ({});
const controller = new AbortController();
const waiting = cancellable.waitForHistory('prompt-1', { signal: controller.signal });
controller.abort();
await assert.rejects(waiting, (error) => error?.name === 'AbortError');

console.log('comfyui client contract check: passed');
