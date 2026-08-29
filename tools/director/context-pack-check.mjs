import assert from 'node:assert/strict';

import { buildDirectorContextPack } from './context-pack.mjs';

const nodes = Array.from({ length: 140 }, (_, index) => ({
  id: `scene.${String(index + 1).padStart(3, '0')}`,
  kind: 'scene',
  title: `Scene ${index + 1}`,
  metadata: {
    index: String(index + 1),
    durationSeconds: '42',
    ignoredLargeField: 'x'.repeat(1000),
  },
  revision: 1,
  approval: index === 0 ? 'review' : 'draft',
  locked: false,
  stale: false,
}));
const dependencies = nodes.slice(1).map((node, index) => ({
  dependent: node.id,
  dependency: nodes[index].id,
}));
const snapshot = {
  schemaVersion: 1,
  projectRevision: 17,
  nodes,
  dependencies,
};
const positions = Object.fromEntries(nodes.map((node, index) => [node.id, { x: index * 120, y: index * 40 }]));

const first = await buildDirectorContextPack({
  provider: 'codex',
  objective: 'Organize the episode workflow without changing semantic state.',
  mode: 'assist',
  snapshot,
  selectedId: 'scene.001',
  workspacePositions: positions,
});
const second = await buildDirectorContextPack({
  provider: 'codex',
  objective: 'Organize the episode workflow without changing semantic state.',
  mode: 'assist',
  snapshot,
  selectedId: 'scene.001',
  workspacePositions: positions,
});

assert.equal(first.hash, second.hash, 'identical live context must produce a deterministic hash');
assert.ok(first.chars <= 16_000, `context pack exceeded bound: ${first.chars}`);
assert.ok(first.estimatedTokens <= 4_000, `estimated token budget exceeded: ${first.estimatedTokens}`);
assert.equal(first.nodeCountIncluded, 72, 'node context must be capped');
assert.ok(first.dependencyCountIncluded <= 120, 'dependency context must be capped');
assert.ok(!first.prompt.includes('ignoredLargeField'), 'irrelevant metadata must not leak into compact context');
assert.ok(first.prompt.includes('MAKEWATCH DIRECTOR MODE'), 'Director mode marker must be present');
assert.ok(first.prompt.includes('scene.001'), 'selected/live project context must be present');
assert.ok(first.prompt.includes('policyHash'), 'canonical Director policy version must be observable without resending full policy');
assert.ok(!first.prompt.includes('# Make & Watch — AI Director Compact Context'), 'stable policy must not be duplicated in each request');

console.log('director context-pack check: passed');
