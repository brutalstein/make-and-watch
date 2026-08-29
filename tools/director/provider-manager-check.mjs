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
  assert.equal(typeof provider.loginAvailable, 'boolean');
  assert.equal(typeof provider.planningAvailable, 'boolean');
  assert.equal(typeof provider.chatAvailable, 'boolean');
  assert.equal(typeof provider.loginPending, 'boolean');
  assert.ok(Array.isArray(provider.capabilityIssues));
  assert.equal(typeof provider.detail, 'string');
  assert.ok(provider.detail.length <= 240, 'sanitized provider status detail must remain bounded');
  assert.equal(JSON.stringify(provider).includes('@'), false, 'sanitized provider status must not expose account email');
  assert.ok(
    ['supported_local_client', 'api_required', 'experimental_local_client'].includes(provider.policy),
    'provider policy must be explicit',
  );
}

const codex = result.providers.find((provider) => provider.provider === 'codex');
const claude = result.providers.find((provider) => provider.provider === 'claude');
assert.equal(codex?.policy, 'supported_local_client');
assert.equal(codex?.integration, 'codex_app_server');
assert.equal(
  claude?.policy,
  process.env.MAKEWATCH_ENABLE_EXPERIMENTAL_CLAUDE_CODE === '1'
    ? 'experimental_local_client'
    : 'api_required',
);
assert.equal(claude?.chatAvailable, false, 'Claude chat must stay unavailable until a supported product provider exists');
if (process.env.MAKEWATCH_ENABLE_EXPERIMENTAL_CLAUDE_CODE !== '1') {
  assert.equal(claude?.planningAvailable, false, 'public-product Claude Code bridge must not be actionable by default');
}

await shutdownDirectorProviders();
console.log('director provider-manager check: passed');
