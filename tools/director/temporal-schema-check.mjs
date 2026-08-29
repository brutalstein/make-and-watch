import assert from 'node:assert/strict';

import { defaultMetadataForKind, productionSchemaDigest } from './production-schema.mjs';

const digest = productionSchemaDigest(['shot', 'character', 'location']);
assert.equal(digest.schemaVersion, 2);

const shot = digest.kinds.find((kind) => kind.kind === 'shot');
const strategy = shot.fields.find((field) => field.key === 'generationStrategy');
assert.ok(strategy.options.includes('FLF2V'));
assert.ok(shot.fields.some((field) => field.key === 'heroFrameAssetId'));
assert.ok(shot.fields.some((field) => field.key === 'endFrameAssetId'));
assert.ok(shot.fields.some((field) => field.key === 'temporalPrompt'));
assert.ok(shot.fields.some((field) => field.key === 'temporalProvider'));

const character = digest.kinds.find((kind) => kind.kind === 'character');
assert.ok(character.fields.some((field) => field.key === 'canonicalImageAssetIds'));
assert.ok(character.fields.some((field) => field.key === 'acceptedReferenceAssetIds'));
assert.equal(defaultMetadataForKind('character').continuityPolicy, 'prefer-reference');

const location = digest.kinds.find((kind) => kind.kind === 'location');
assert.equal(defaultMetadataForKind('location').continuityPolicy, 'prefer-reference');
assert.ok(location.invariants.some((value) => value.includes('reference Assets')));

console.log('temporal production schema checks passed');
