import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Stable/base production semantics and additive temporal-video semantics are
// separate files but are merged identically here and in packages/contracts.
// This keeps Studio and Director on one effective schema without rewriting the
// historical base table every time the temporal runtime evolves.
const capabilitiesPath = fileURLToPath(
  new URL('../../packages/contracts/src/nodeCapabilities.json', import.meta.url),
);
const temporalOverlayPath = fileURLToPath(
  new URL('../../packages/contracts/src/temporalNodeCapabilities.json', import.meta.url),
);

let cached = null;

function mergeFields(baseFields, overlayFields = []) {
  const overlays = new Map(overlayFields.map((field) => [field.key, field]));
  const merged = baseFields.map((field) => ({ ...field, ...(overlays.get(field.key) ?? {}) }));
  const existing = new Set(baseFields.map((field) => field.key));
  for (const field of overlayFields) {
    if (!existing.has(field.key)) merged.push(field);
  }
  return merged;
}

function mergeCapabilities(base, overlay) {
  return Object.fromEntries(Object.entries(base).map(([kind, capability]) => {
    const patch = overlay[kind];
    if (!patch) return [kind, capability];
    return [kind, {
      ...capability,
      ...patch,
      invariants: [...capability.invariants, ...(patch.invariants ?? [])],
      fields: mergeFields(capability.fields, patch.fields),
    }];
  }));
}

export function productionNodeCapabilities() {
  if (!cached) {
    const base = JSON.parse(readFileSync(capabilitiesPath, 'utf8'));
    const temporal = JSON.parse(readFileSync(temporalOverlayPath, 'utf8'));
    cached = mergeCapabilities(base, temporal);
  }
  return cached;
}

export function productionNodeKinds() {
  return Object.keys(productionNodeCapabilities());
}

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
    schemaVersion: 2,
    note: 'Use only metadata keys present in this effective base+temporal schema for authored production behavior. Runtime/provenance services may attach additional system-owned metadata.',
    kinds: selected.map((kind) => {
      const capability = capabilities[kind];
      return {
        kind: capability.kind,
        label: capability.label,
        role: capability.role,
        purpose: capability.purpose,
        primaryOutput: capability.primaryOutput,
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
