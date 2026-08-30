import assert from 'node:assert/strict';

import { GpuExclusiveScheduler } from './gpu-scheduler.mjs';

let releaseFirst;
const scheduler = new GpuExclusiveScheduler();
const first = scheduler.run({ kind: 'first', id: '1' }, () => new Promise((resolve) => { releaseFirst = resolve; }));
for (let attempt = 0; attempt < 100 && !releaseFirst; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));

let cancelledOperationRan = false;
const controller = new AbortController();
const cancelled = scheduler.run({ kind: 'second', id: '2' }, () => { cancelledOperationRan = true; }, { signal: controller.signal });
controller.abort();
await assert.rejects(cancelled, (error) => error?.name === 'AbortError');
assert.equal(cancelledOperationRan, false);

let thirdRan = false;
const third = scheduler.run({ kind: 'third', id: '3' }, () => { thirdRan = true; });
await new Promise((resolve) => setTimeout(resolve, 5));
assert.equal(thirdRan, false, 'cancelling a waiter must not break exclusive ordering');
releaseFirst();
await Promise.all([first, third]);
assert.equal(thirdRan, true);
assert.equal(scheduler.status().active, null);

console.log('GPU scheduler cancellation checks passed');
