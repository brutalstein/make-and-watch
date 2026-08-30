import type { ProjectNodeKind } from './index';
import capabilities from './nodeCapabilities.json';
import temporalOverlay from './temporalNodeCapabilities.json';

export type NodeExecutionRole = 'scope' | 'creative-anchor' | 'production-unit' | 'execution' | 'artifact';
export type NodeMetadataFieldType = 'text' | 'multiline' | 'number' | 'enum' | 'boolean' | 'duration' | 'seed' | 'language' | 'path';
export type NodeMetadataScope = 'creative' | 'production' | 'runtime' | 'provenance';

export interface NodeMetadataFieldSpec {
  key: string;
  label: string;
  type: NodeMetadataFieldType;
  scope: NodeMetadataScope;
  description: string;
  defaultValue?: string;
  placeholder?: string;
  options?: readonly string[];
  requiredFor?: 'preview' | 'final';
}

export interface ProjectNodeCapability {
  kind: ProjectNodeKind;
  label: string;
  role: NodeExecutionRole;
  purpose: string;
  primaryOutput: string;
  consumes: readonly ProjectNodeKind[];
  produces: readonly ProjectNodeKind[];
  invariants: readonly string[];
  fields: readonly NodeMetadataFieldSpec[];
}

type CapabilityOverlay = Partial<Pick<ProjectNodeCapability, 'purpose' | 'primaryOutput' | 'invariants' | 'fields'>>;

function mergeFields(
  baseFields: readonly NodeMetadataFieldSpec[],
  overlayFields: readonly NodeMetadataFieldSpec[] = [],
): NodeMetadataFieldSpec[] {
  const overlays = new Map(overlayFields.map((field) => [field.key, field]));
  const merged = baseFields.map((field) => ({ ...field, ...(overlays.get(field.key) ?? {}) }));
  const existing = new Set(baseFields.map((field) => field.key));
  for (const field of overlayFields) {
    if (!existing.has(field.key)) merged.push(field);
  }
  return merged;
}

function mergedCapabilities(): Record<ProjectNodeKind, ProjectNodeCapability> {
  const base = capabilities as unknown as Record<ProjectNodeKind, ProjectNodeCapability>;
  const overlay = temporalOverlay as unknown as Partial<Record<ProjectNodeKind, CapabilityOverlay>>;
  return Object.fromEntries(
    Object.entries(base).map(([kind, capability]) => {
      const patch = overlay[kind as ProjectNodeKind];
      if (!patch) return [kind, capability];
      return [kind, {
        ...capability,
        ...patch,
        invariants: [...capability.invariants, ...(patch.invariants ?? [])],
        fields: mergeFields(capability.fields, patch.fields),
      } satisfies ProjectNodeCapability];
    }),
  ) as Record<ProjectNodeKind, ProjectNodeCapability>;
}

// The base table preserves stable semantic field history for old project data.
// The temporal overlay is authoritative for current Studio/Director production
// semantics, including the removal of animated-still final Shot output.
export const PROJECT_NODE_CAPABILITIES = mergedCapabilities();

export function defaultMetadataForKind(kind: ProjectNodeKind): Record<string, string> {
  return Object.fromEntries(
    PROJECT_NODE_CAPABILITIES[kind].fields
      .filter((candidate) => candidate.defaultValue !== undefined)
      .map((candidate) => [candidate.key, candidate.defaultValue as string]),
  );
}

export function nodeCapability(kind: ProjectNodeKind): ProjectNodeCapability {
  return PROJECT_NODE_CAPABILITIES[kind];
}
