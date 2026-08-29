import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Single source of truth shared with packages/contracts/src/nodeCapabilities.ts.
// The Studio properties editor and the Director tool surface must agree on the
// semantic node model, so both read this same JSON rather than each carrying a
// private copy that would silently drift.
const capabilitiesPath = fileURLToPath(
  new URL('../../packages/contracts/src/nodeCapabilities.json', import.meta.url),
);

let cached = null;

export function productionNodeCapabilities() {
  if (!cached) cached = JSON.parse(readFileSync(capabilitiesPath, 'utf8'));
  return cached;
}

export function productionNodeKinds() {
  return Object.keys(productionNodeCapabilities());
}

/**
 * Compact, prompt-friendly projection of one node kind.
 *
 * The full capability table is far larger than a Director turn should spend
 * context on, so field specs are flattened to the parts that actually change
 * what the model writes: the metadata key, its type/enum domain, whether the
 * generation pipeline requires it, and its default.
 */
function digestField(field) {
  return {
    key: field.key,
    type: field.type,
    scope: field.scope,
    description: field.description,
    ...(field.options ? { options: field.options } : {}),
    ...(field.defaultValue !== undefined ? { default: field.defaultValue } : {}),
    ...(field.requiredFor ? { requiredFor: field.requiredFor } : {}),
  };
}

export function productionSchemaDigest(kinds = null) {
  const capabilities = productionNodeCapabilities();
  const selected = Array.isArray(kinds) && kinds.length
    ? kinds.filter((kind) => Object.hasOwn(capabilities, kind))
    : Object.keys(capabilities);

  return {
    schemaVersion: 1,
    note: 'Metadata keys outside this schema are stored verbatim but are ignored by prompt compilation, timing and rendering.',
    kinds: selected.map((kind) => {
      const capability = capabilities[kind];
      return {
        kind: capability.kind,
        label: capability.label,
        role: capability.role,
        purpose: capability.purpose,
        consumes: capability.consumes,
        produces: capability.produces,
        invariants: capability.invariants,
        fields: capability.fields.map(digestField),
      };
    }),
  };
}

export function defaultMetadataForKind(kind) {
  const capability = productionNodeCapabilities()[kind];
  if (!capability) throw new Error(`unknown production node kind: ${kind}`);
  return Object.fromEntries(
    capability.fields
      .filter((field) => field.defaultValue !== undefined)
      .map((field) => [field.key, String(field.defaultValue)]),
  );
}
