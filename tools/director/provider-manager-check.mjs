import assert from 'node:assert/strict';

import { providerStatuses, shutdownDirectorProviders } from './provider-manager.mjs';

const result = await providerStatuses();
assert.equal(result.providers.length, 2, 'provider status must always report Codex and Claude slots');
assert.deepEqual(
  result.providers.map((provider) => provider.provider).sort(),
  ['claude', 'codex'],
  'provider IDs must remain stable',
);
for (const provider of result.providers) {
  assert.equal(typeof provider.installed, 'boolean');
  assert.equal(typeof provider.authenticated, 'boolean');
  assert.equal(typeof provider.capable, 'boolean');
  assert.equal(typeof provider.detail, 'string');
  assert.ok(provider.detail.length <= 160, 'sanitized provider status detail must remain bounded');
}
shutdownDirectorProviders();
console.log('director provider-manager check: passed');
