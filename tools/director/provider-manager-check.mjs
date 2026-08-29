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
  assert.equal(typeof provider.executableName, 'string');
  assert.equal(typeof provider.discovery, 'string');
  assert.ok(
    ['', 'override', 'path', 'known-user-bin'].includes(provider.discovery),
    'provider discovery source must remain bounded and sanitized',
  );
  assert.ok(
    ['supported_local_client', 'api_required', 'experimental_local_client'].includes(provider.policy),
    'provider policy must be explicit',
  );
  assert.ok(provider.detail.length <= 180, 'sanitized provider status detail must remain bounded');
  assert.ok(!/[\\/]/.test(provider.executableName), 'React must receive only executable basename, never a local path');
}

const codex = result.providers.find((provider) => provider.provider === 'codex');
const claude = result.providers.find((provider) => provider.provider === 'claude');
assert.equal(codex?.policy, 'supported_local_client', 'Codex local client is the supported subscription bridge');
assert.equal(
  claude?.policy,
  process.env.MAKEWATCH_ENABLE_EXPERIMENTAL_CLAUDE_CODE === '1'
    ? 'experimental_local_client'
    : 'api_required',
  'Claude Code must be policy-gated by default',
);
if (process.env.MAKEWATCH_ENABLE_EXPERIMENTAL_CLAUDE_CODE !== '1') {
  assert.equal(claude?.capable, false, 'public-product Claude Code bridge must not be actionable by default');
}

await shutdownDirectorProviders();
console.log('director provider-manager check: passed');
