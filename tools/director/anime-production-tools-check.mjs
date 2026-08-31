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
  characterRigPlan: async (input) => { calls.push(['rig-plan', input]); return { characterId: input.characterId, missingStates: [] }; },
  characterRigBuild: async (input) => { calls.push(['rig-build', input]); return { job: { id: 'job-rig', status: 'completed', rigAssetId: 'asset.rig' } }; },
  characterRigValidate: async (input) => { calls.push(['rig-validate', input]); return { reportAssetId: 'asset.report', passed: true, promoted: input.promote === true }; },
  locationPackagePlan: async (input) => { calls.push(['pkg-plan', input]); return { locationId: input.locationId, missingPlates: [] }; },
  locationPackageBuild: async (input) => { calls.push(['pkg-build', input]); return { job: { id: 'job-pkg', status: 'completed', packageAssetId: 'asset.pkg' } }; },
  locationPackageValidate: async (input) => { calls.push(['pkg-validate', input]); return { reportAssetId: 'asset.report', passed: true, promoted: input.promote === true }; },
};

const specs = animeProductionDynamicToolSpecs();
assert.equal(specs.length, 1);
assert.equal(specs[0].name, 'makewatch_anime');
assert.equal(animeProductionToolLimits.namespace, 'makewatch_anime');
assert.deepEqual(specs[0].tools.map(({ name }) => name), [
  'production_status', 'shot_anim_plan', 'shot_anim_compile',
  'character_rig_plan', 'character_rig_build', 'character_rig_validate',
  'location_package_plan', 'location_package_build', 'location_package_validate',
]);
for (const tool of specs[0].tools) {
  assert.equal(tool.inputSchema.additionalProperties, false);
}
assert.deepEqual(specs[0].tools[1].inputSchema.required, ['shotId']);
assert.equal(specs[0].tools[1].inputSchema.properties.shotId.maxLength, 160);
assert.equal(specs[0].tools[1].inputSchema.properties.shotId.pattern, '^[A-Za-z0-9._:-]+$');

const toolByName = Object.fromEntries(specs[0].tools.map((tool) => [tool.name, tool]));
assert.ok(toolByName.character_rig_build.inputSchema.required.includes('expectedRevision'));
assert.ok(toolByName.character_rig_validate.inputSchema.required.includes('expectedCharacterRevision'));
assert.ok(toolByName.location_package_build.inputSchema.required.includes('expectedRevision'));
assert.ok(toolByName.location_package_validate.inputSchema.required.includes('expectedLocationRevision'));
assert.equal(toolByName.character_rig_build.inputSchema.properties.states.maxItems, 128);
assert.equal(toolByName.location_package_build.inputSchema.properties.plates.minItems, 3);
for (const name of ['character_rig_plan', 'character_rig_build', 'character_rig_validate',
  'location_package_plan', 'location_package_build', 'location_package_validate']) {
  assert.equal(toolByName[name].deferLoading, true, `${name} should defer loading`);
}

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

const rigPlan = JSON.parse(await handleAnimeProductionToolCall({
  namespace: 'makewatch_anime', tool: 'character_rig_plan', arguments: { characterId: 'character.aya' },
}, runtime));
assert.equal(rigPlan.characterId, 'character.aya');
assert.deepEqual(calls.at(-1), ['rig-plan', { characterId: 'character.aya', outfitState: undefined }]);

const rigBuilt = JSON.parse(await handleAnimeProductionToolCall({
  namespace: 'makewatch_anime',
  tool: 'character_rig_build',
  arguments: {
    characterId: 'character.aya',
    expectedRevision: 7,
    outfitState: 'school-uniform',
    states: [{ id: 'face_base.DEFAULT', sourceAssetId: 'asset.face' }],
    validDomains: { headAngleZ: [-18, 18] },
  },
}, runtime));
assert.equal(rigBuilt.job.rigAssetId, 'asset.rig');
assert.equal(calls.at(-1)[0], 'rig-build');
assert.equal(calls.at(-1)[1].expectedRevision, 7);
assert.deepEqual(calls.at(-1)[1].validDomains, { headAngleZ: [-18, 18] });

const rigValidated = JSON.parse(await handleAnimeProductionToolCall({
  namespace: 'makewatch_anime',
  tool: 'character_rig_validate',
  arguments: { rigAssetId: 'asset.rig', expectedCharacterRevision: 7, promote: true },
}, runtime));
assert.equal(rigValidated.promoted, true);
assert.deepEqual(calls.at(-1), ['rig-validate', { rigAssetId: 'asset.rig', expectedCharacterRevision: 7, promote: true }]);

const pkgPlan = JSON.parse(await handleAnimeProductionToolCall({
  namespace: 'makewatch_anime', tool: 'location_package_plan', arguments: { locationId: 'location.cafe' },
}, runtime));
assert.equal(pkgPlan.locationId, 'location.cafe');
assert.deepEqual(calls.at(-1), ['pkg-plan', { locationId: 'location.cafe', stateId: undefined }]);

const pkgBuilt = JSON.parse(await handleAnimeProductionToolCall({
  namespace: 'makewatch_anime',
  tool: 'location_package_build',
  arguments: {
    locationId: 'location.cafe',
    expectedRevision: 3,
    stateId: 'night-rain',
    plates: [
      { id: 'p.bg', role: 'background', sourceAssetId: 'asset.bg', depth: 0.1 },
      { id: 'p.mg', role: 'midground', sourceAssetId: 'asset.mg', depth: 0.5 },
      { id: 'p.fg', role: 'foreground', sourceAssetId: 'asset.fg', depth: 0.9 },
    ],
    occlusionMaskAssetId: 'asset.mask',
    cameraSafeBounds: { x: [0.06, 0.94], y: [0.06, 0.94] },
  },
}, runtime));
assert.equal(pkgBuilt.job.packageAssetId, 'asset.pkg');
assert.equal(calls.at(-1)[0], 'pkg-build');
assert.equal(calls.at(-1)[1].expectedRevision, 3);

const pkgValidated = JSON.parse(await handleAnimeProductionToolCall({
  namespace: 'makewatch_anime',
  tool: 'location_package_validate',
  arguments: { packageAssetId: 'asset.pkg', expectedLocationRevision: 3, promote: false },
}, runtime));
assert.equal(pkgValidated.promoted, false);
assert.deepEqual(calls.at(-1), ['pkg-validate', { packageAssetId: 'asset.pkg', expectedLocationRevision: 3, promote: false }]);

await assert.rejects(
  handleAnimeProductionToolCall({
    namespace: 'makewatch_anime', tool: 'character_rig_build',
    arguments: { characterId: 'character.aya', outfitState: 'default', states: [{ id: 'face_base.DEFAULT', sourceAssetId: 'asset.face' }] },
  }, runtime),
  /expectedRevision must be a non-negative integer/,
);
await assert.rejects(
  handleAnimeProductionToolCall({
    namespace: 'makewatch_anime', tool: 'character_rig_validate',
    arguments: { rigAssetId: 'asset.rig', expectedCharacterRevision: -1 },
  }, runtime),
  /expectedCharacterRevision must be a non-negative integer/,
);

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

await client.characterRigPlan({ characterId: 'character.aya', outfitState: 'school uniform' });
assert.equal(client.calls.at(-1).pathname, '/anime/characters/character.aya/rig-plan?outfitState=school%20uniform');
await client.characterRigPlan({ characterId: 'character.aya' });
assert.equal(client.calls.at(-1).pathname, '/anime/characters/character.aya/rig-plan');
await client.characterRigBuild({ characterId: 'character.aya', expectedRevision: 7 });
assert.equal(client.calls.at(-1).pathname, '/anime/character-rigs');
assert.equal(client.calls.at(-1).init.method, 'POST');
await client.characterRigValidate({ rigAssetId: 'asset.rig', expectedCharacterRevision: 7, promote: true });
assert.equal(client.calls.at(-1).pathname, '/anime/character-rigs/asset.rig/validate');
assert.equal(JSON.parse(client.calls.at(-1).init.body).promote, true);

await client.locationPackagePlan({ locationId: 'location.cafe', stateId: 'night-rain' });
assert.equal(client.calls.at(-1).pathname, '/anime/locations/location.cafe/package-plan?stateId=night-rain');
await client.locationPackageBuild({ locationId: 'location.cafe', expectedRevision: 3 });
assert.equal(client.calls.at(-1).pathname, '/anime/environment-packages');
await client.locationPackageValidate({ packageAssetId: 'asset.pkg', expectedLocationRevision: 3 });
assert.equal(client.calls.at(-1).pathname, '/anime/environment-packages/asset.pkg/validate');
assert.equal(JSON.parse(client.calls.at(-1).init.body).promote, false);

console.log('anime production tools check passed');
