import type { ProjectNodeKind } from './index';
import capabilities from './nodeCapabilities.json';

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


// The capability table itself lives in ./nodeCapabilities.json so that the
// Node-side Director runtime (tools/) and the TypeScript Studio/contract layer
// read exactly the same production schema. Editing the JSON is the only way to
// change the semantic node model.
export const PROJECT_NODE_CAPABILITIES =
  capabilities as unknown as Record<ProjectNodeKind, ProjectNodeCapability>;

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
