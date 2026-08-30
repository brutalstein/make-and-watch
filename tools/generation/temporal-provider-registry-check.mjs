import assert from 'node:assert/strict';

import { TemporalProviderRegistry } from './temporal-provider-registry.mjs';

const request = {
  shot: {
    id: 'shot.1',
    strategy: 'I2V',
    durationSeconds: 5,
  },
};

const registry = new TemporalProviderRegistry();
registry.register({
  id: 'fixture',
  displayName: 'Fixture Provider',
  strategies: ['I2V', 'FLF2V'],
  status: async () => ({ installed: true, ready: true, busy: false, detail: 'ready' }),
  generate: async () => ({
    mediaType: 'video',
    relativePath: 'artifacts/video/shot-1.mp4',
    sha256: 'a'.repeat(64),
    mimeType: 'video/mp4',
    durationSeconds: 5,
    width: 960,
    height: 540,
    fps: 24,
    providerMetadata: { fixture: true },
  }),
});

assert.deepEqual(registry.ids(), ['fixture']);
assert.equal((await registry.statuses())[0].ready, true);
const result = await registry.generate('fixture', request);
assert.equal(result.provider, 'fixture');
assert.equal(result.strategy, 'I2V');
assert.equal(result.artifact.mediaType, 'video');
assert.equal(result.artifact.sha256.length, 64);

assert.throws(() => registry.resolve('', 'I2V'), /explicit/);
assert.throws(() => registry.resolve('fixture', 'VIDEO'), /does not support/);
assert.throws(() => registry.register({
  id: 'fixture',
  strategies: ['I2V'],
  status: async () => ({}),
  generate: async () => ({}),
}), /already registered/);

const bad = new TemporalProviderRegistry().register({
  id: 'bad-output',
  strategies: ['I2V'],
  status: async () => ({ installed: true, ready: true }),
  generate: async () => ({ mediaType: 'image', relativePath: 'x', sha256: 'a'.repeat(64), durationSeconds: 5 }),
});
await assert.rejects(() => bad.generate('bad-output', request), /mediaType=video/);

const notReady = new TemporalProviderRegistry().register({
  id: 'offline',
  strategies: ['I2V'],
  status: async () => ({ installed: false, ready: false, detail: 'not installed' }),
  generate: async () => { throw new Error('must not run'); },
});
await assert.rejects(() => notReady.generate('offline', request), /not installed/);

// Regression: class-based providers (FramePack, native anime engine) define
// status()/generate() on the prototype. Spreading the instance used to drop them.
class ClassProvider {
  constructor() {
    this.id = 'class-provider';
    this.displayName = 'Class Provider';
    this.strategies = ['I2V'];
    this.readyValue = true;
  }
  async status() { return { installed: true, ready: this.readyValue, busy: false, detail: 'class ok' }; }
  async generate() {
    return {
      mediaType: 'video',
      relativePath: 'artifacts/video/class.mp4',
      sha256: 'b'.repeat(64),
      durationSeconds: 5,
      width: 1920,
      height: 1080,
      fps: 24,
    };
  }
}
const classRegistry = new TemporalProviderRegistry().register(new ClassProvider());
assert.equal((await classRegistry.statuses())[0].ready, true, 'class provider status() must survive registration');
const classResult = await classRegistry.generate('class-provider', request);
assert.equal(classResult.artifact.sha256, 'b'.repeat(64), 'class provider generate() must survive registration');

console.log('temporal provider registry checks passed');
