import assert from 'node:assert/strict';

import { GenerationGatewayClient } from '../generation/gateway-api-client.mjs';
import {
  animeProductionDynamicToolSpecs,
  animeProductionToolLimits,
  handleAnimeProductionToolCall,
} from './anime-production-tools.mjs';

const calls = [];
const runtime = {
  productionStatus: async () => ({ ready: true, compiler: { ready: true }, renderer: { ready: true } }),
  shotAnimPlan: async (input) => { calls.push(['plan', input]); return { ready: true, shotId: input.shotId }; },
  shotAnimCompile: async (input) => { calls.push(['compile', input]); return { assetNodeId: 'asset.compiled', shotId: input.shotId }; },
};

const specs = animeProductionDynamicToolSpecs();
assert.equal(specs.length, 1);
assert.equal(specs[0].name, 'makewatch_anime');
assert.equal(animeProductionToolLimits.namespace, 'makewatch_anime');
assert.deepEqual(specs[0].tools.map(({ name }) => name), ['production_status', 'shot_anim_plan', 'shot_anim_compile']);
for (const tool of specs[0].tools) {
  assert.equal(tool.inputSchema.additionalProperties, false);
}
assert.deepEqual(specs[0].tools[1].inputSchema.required, ['shotId']);
assert.equal(specs[0].tools[1].inputSchema.properties.shotId.maxLength, 160);
assert.equal(specs[0].tools[1].inputSchema.properties.shotId.pattern, '^[A-Za-z0-9._:-]+$');

const status = JSON.parse(await handleAnimeProductionToolCall({
  namespace: 'makewatch_anime', tool: 'production_status', arguments: {},
}, runtime));
assert.equal(status.ready, true);

const plan = JSON.parse(await handleAnimeProductionToolCall({
  namespace: 'makewatch_anime', tool: 'shot_anim_plan', arguments: { shotId: 'shot.1' },
}, runtime));
assert.equal(plan.shotId, 'shot.1');
assert.deepEqual(calls.at(-1), ['plan', { shotId: 'shot.1' }]);

const compiled = JSON.parse(await handleAnimeProductionToolCall({
  namespace: 'makewatch_anime', tool: 'shot_anim_compile', arguments: { shotId: 'shot.1' },
}, runtime));
assert.equal(compiled.assetNodeId, 'asset.compiled');
assert.deepEqual(calls.at(-1), ['compile', { shotId: 'shot.1' }]);

await assert.rejects(
  handleAnimeProductionToolCall({ namespace: 'makewatch_anime', tool: 'shot_anim_plan', arguments: { shotId: '' } }, runtime),
  /shotId is required/,
);
await assert.rejects(
  handleAnimeProductionToolCall({ namespace: 'makewatch_anime', tool: 'shot_anim_plan', arguments: { shotId: 'shot/1' } }, runtime),
  /shotId is invalid/,
);
await assert.rejects(
  handleAnimeProductionToolCall({ namespace: 'makewatch_media', tool: 'production_status', arguments: {} }, runtime),
  /unknown anime tool namespace/,
);
await assert.rejects(
  handleAnimeProductionToolCall({ namespace: 'makewatch_anime', tool: 'unknown', arguments: {} }, runtime),
  /unknown anime tool/,
);

class CaptureClient extends GenerationGatewayClient {
  constructor() {
    super({ baseUrl: 'http://127.0.0.1:4178/api' });
    this.calls = [];
  }

  async request(pathname, init = {}) {
    this.calls.push({ pathname, init });
    return { ok: true };
  }
}

const client = new CaptureClient();
await client.animeProductionStatus();
assert.equal(client.calls.at(-1).pathname, '/anime/status');
await client.shotAnimPlan('shot:1');
assert.equal(client.calls.at(-1).pathname, '/anime/shots/shot%3A1/plan');
await client.shotAnimCompile('shot:1');
assert.equal(client.calls.at(-1).pathname, '/anime/shots/shot%3A1/compile');
assert.equal(client.calls.at(-1).init.method, 'POST');

console.log('anime production tools check passed');
