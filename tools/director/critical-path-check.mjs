import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  clearMakeWatchToolRuntime,
  configureMakeWatchToolRuntime,
  configuredMakeWatchDynamicToolSpecs,
} from './makewatch-tool-runtime.mjs';

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

function constantMs(source, name) {
  // Matches both a literal budget and an env-overridable `?? <default>` budget.
  const pattern = new RegExp(String.raw`const ${name}\s*=\s*(?:[^;]*\?\?\s*)?([0-9_]+)`);
  const match = pattern.exec(source);
  assert.ok(match, `could not read ${name}`);
  return Number(match[1].replaceAll('_', ''));
}

// --- Timeout hierarchy -------------------------------------------------------
// Regression guard for "Local Make & Watch bridge is unavailable: signal timed
// out". The Studio client used one 20s budget for every request, including
// Director chat, so any turn that did real work was aborted by the browser
// while the server was still running it. Each layer's deadline must stay
// strictly inside the deadline of the layer that is waiting on it, so a stuck
// operation is reported by the layer that knows why it is stuck.
const engineClient = read('../../apps/studio/src/engineClient.ts');
const chatSession = read('./codex-chat-session.mjs');
const appServer = read('./codex-app-server.mjs');
const bridgeServer = read('../dev-bridge/server.mjs');

const clientTurnBudget = constantMs(engineClient, 'DIRECTOR_TURN_TIMEOUT_MS');
const serverTurnBudget = constantMs(chatSession, 'CHAT_TURN_TIMEOUT_MS');
const toolBudget = constantMs(appServer, 'TOOL_TIMEOUT_MS');
const nativeBudget = constantMs(bridgeServer, 'NATIVE_RPC_TIMEOUT_MS');

assert.ok(
  clientTurnBudget > serverTurnBudget,
  `Studio Director budget (${clientTurnBudget} ms) must exceed the server turn budget (${serverTurnBudget} ms)`,
);
assert.ok(
  serverTurnBudget > toolBudget,
  `server turn budget (${serverTurnBudget} ms) must exceed the tool budget (${toolBudget} ms)`,
);
assert.ok(
  toolBudget > nativeBudget,
  `tool budget (${toolBudget} ms) must exceed the native RPC budget (${nativeBudget} ms)`,
);
assert.ok(
  serverTurnBudget >= 300_000,
  'a Director turn that builds a full scene needs at least a 5 minute budget',
);

// The generic 20s budget must no longer be what a Director chat turn uses.
assert.match(
  engineClient,
  new RegExp(String.raw`/director/chat.{0,120}timeoutMs: DIRECTOR_TURN_TIMEOUT_MS`, 's'),
  'Director chat must not fall back to the generic bridge request budget',
);
// A client abort must not be reported to the user as a dead bridge.
assert.match(engineClient, /'bridge_timeout'/, 'timeouts must be distinguished from an unreachable bridge');

// --- Director tool runtime contract -----------------------------------------
// The Director can only operate the product through this runtime. If the bridge
// stops supplying a capability, that must fail at wiring time rather than
// silently removing tools the model was told it has.
const completeRuntime = Object.fromEntries([
  'snapshot', 'history', 'impact', 'apply',
  'newWorkflow', 'saveWorkflow', 'listWorkflows', 'loadWorkflow', 'deleteWorkflow',
  'generationProvider', 'startSceneGeneration', 'startAudioGeneration',
  'generationJob', 'generationJobs',
].map((name) => [name, async () => ({})]));

const { generationJob, ...missingGeneration } = completeRuntime;
assert.throws(
  () => configureMakeWatchToolRuntime(missingGeneration),
  /missing generationJob/,
  'an incomplete runtime must be rejected at wiring time',
);

configureMakeWatchToolRuntime(completeRuntime);
const tools = configuredMakeWatchDynamicToolSpecs()[0].tools.map((tool) => tool.name);
for (const required of ['project_apply', 'production_schema', 'scene_generate', 'generation_job']) {
  assert.ok(tools.includes(required), `configured Director surface is missing ${required}`);
}
clearMakeWatchToolRuntime();
assert.deepEqual(configuredMakeWatchDynamicToolSpecs(), [], 'tools must disappear when no runtime is configured');

// --- Bridge wiring -----------------------------------------------------------
// The bridge must delegate media work to the generation gateway rather than
// answering generation tool calls itself.
assert.match(bridgeServer, /GenerationGatewayClient/, 'bridge must own a generation gateway client');
assert.match(bridgeServer, /startSceneGeneration:\s*\(\{ sceneId \}\) => generationGateway\.startScene/);

console.log('director critical path check: passed');
