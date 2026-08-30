import assert from 'node:assert/strict';

import { defaultMetadataForKind, productionSchemaDigest } from './production-schema.mjs';

const digest = productionSchemaDigest(['scene', 'shot', 'character', 'location']);
assert.equal(digest.schemaVersion, 2);

const scene = digest.kinds.find((kind) => kind.kind === 'scene');
const policy = scene.fields.find((field) => field.key === 'generationPolicy');
assert.deepEqual(policy.options, ['i2v-first', 'keyframe-controlled', 'provider-native-video']);
assert.equal(policy.default, 'i2v-first');
assert.equal(defaultMetadataForKind('scene').generationPolicy, 'i2v-first');

const shot = digest.kinds.find((kind) => kind.kind === 'shot');
const strategy = shot.fields.find((field) => field.key === 'generationStrategy');
assert.deepEqual(strategy.options, ['I2V', 'FLF2V', 'VIDEO']);
assert.equal(strategy.default, 'I2V');
assert.equal(strategy.options.includes('STILL_MOTION'), false);
assert.equal(strategy.options.includes('T2I'), false);
assert.ok(shot.fields.some((field) => field.key === 'heroFrameAssetId'));
assert.ok(shot.fields.some((field) => field.key === 'endFrameAssetId'));
assert.ok(shot.fields.some((field) => field.key === 'temporalPrompt'));
assert.ok(shot.fields.some((field) => field.key === 'temporalProvider'));
assert.equal(defaultMetadataForKind('shot').generationStrategy, 'I2V');

const character = digest.kinds.find((kind) => kind.kind === 'character');
assert.ok(character.fields.some((field) => field.key === 'canonicalImageAssetIds'));
assert.ok(character.fields.some((field) => field.key === 'acceptedReferenceAssetIds'));
assert.equal(defaultMetadataForKind('character').continuityPolicy, 'prefer-reference');

const location = digest.kinds.find((kind) => kind.kind === 'location');
assert.equal(defaultMetadataForKind('location').continuityPolicy, 'prefer-reference');
assert.ok(location.invariants.some((value) => value.includes('reference Assets')));

console.log('temporal-only production schema checks passed');
