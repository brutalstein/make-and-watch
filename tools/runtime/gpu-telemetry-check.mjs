import assert from 'node:assert/strict';

import { parseNvidiaSmiRow } from './gpu-telemetry.mjs';

assert.deepEqual(
  parseNvidiaSmiRow('NVIDIA GeForce RTX 5070 Laptop GPU, 8151, 6123, 2028'),
  {
    gpuName: 'NVIDIA GeForce RTX 5070 Laptop GPU',
    totalVramMb: 8151,
    freeVramMb: 6123,
    usedVramMb: 2028,
  },
);
assert.equal(parseNvidiaSmiRow('broken'), null);
assert.deepEqual(
  parseNvidiaSmiRow('NVIDIA RTX, bad, 100, 50'),
  { gpuName: 'NVIDIA RTX', totalVramMb: 0, freeVramMb: 100, usedVramMb: 50 },
);

console.log('GPU telemetry checks passed');
