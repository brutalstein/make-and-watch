import assert from 'node:assert/strict';

import { buildDirectorChatTurn } from './chat-context.mjs';

const nodes = Array.from({ length: 100 }, (_, index) => ({
  id: `scene.${String(index + 1).padStart(3, '0')}`,
  kind: index === 0 ? 'series' : index === 1 ? 'episode' : index < 7 ? 'character' : 'scene',
  title: `Entity ${index + 1}`,
  metadata: { index: String(index + 1), role: index < 7 ? 'cast' : '', ignoredLargeField: 'x'.repeat(2000) },
  revision: index + 1,
  approval: 'draft',
  locked: index < 7,
  stale: false,
}));
const dependencies = nodes.slice(1).map((node, index) => ({ dependent: node.id, dependency: nodes[index].id }));
const snapshot = { schemaVersion: 1, projectRevision: 31, nodes, dependencies };

const first = buildDirectorChatTurn({
  message: 'Help me preserve the cast across several episodes while we design the season.',
  snapshot,
  selectedId: 'scene.050',
  firstTurn: true,
});
const again = buildDirectorChatTurn({
  message: 'Help me preserve the cast across several episodes while we design the season.',
  snapshot,
  selectedId: 'scene.050',
  firstTurn: true,
});
const continuation = buildDirectorChatTurn({
  message: 'What should episode two remember from that decision?',
  snapshot,
  selectedId: 'scene.050',
  firstTurn: false,
});

assert.equal(first.hash, again.hash, 'same first-turn context must be deterministic');
assert.ok(first.chars <= 12_000, `first chat prompt exceeded hard budget: ${first.chars}`);
assert.ok(first.estimatedTokens <= 3_000, 'chat context estimate must stay bounded');
assert.ok(first.nodeCountIncluded <= 36);
assert.ok(first.dependencyCountIncluded <= 72);
assert.ok(first.prompt.includes('scene.050'), 'selected entity must be retained');
assert.equal(first.prompt.includes('ignoredLargeField'), false, 'irrelevant metadata must not leak');
assert.ok(continuation.chars < first.chars, 'continuation should rely on thread history instead of resending full project context');
assert.ok(continuation.prompt.includes('project revision is 31'));

console.log(`director chat-context check: passed (${first.nodeCountIncluded} first-turn nodes, ~${first.estimatedTokens} tokens)`);
