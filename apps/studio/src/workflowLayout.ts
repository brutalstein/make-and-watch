import type { ProjectGraphSnapshot, ProjectNode, ProjectNodeKind } from '@makewatch/contracts';

export interface CanvasPoint {
  x: number;
  y: number;
}

export type WorkflowPositions = Record<string, CanvasPoint>;

interface StoredWorkflowLayout {
  schemaVersion: 1;
  positions: WorkflowPositions;
}

const STORAGE_PREFIX = 'makewatch.workflow-layout.v1';
const COLUMN_GAP = 305;
const ROW_GAP = 132;

const KIND_RANK: Record<ProjectNodeKind, number> = {
  series: 0,
  episode: 1,
  character: 2,
  location: 3,
  scene: 4,
  shot: 5,
  asset: 6,
  audio: 7,
  generation: 8,
};

function finitePoint(value: unknown): value is CanvasPoint {
  if (!value || typeof value !== 'object') return false;
  const point = value as Partial<CanvasPoint>;
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function storageKey(projectKey: string) {
  return `${STORAGE_PREFIX}:${projectKey}`;
}

function numericMetadata(node: ProjectNode, key: string) {
  const value = Number(node.metadata[key]);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function compareNodes(left: ProjectNode, right: ProjectNode) {
  const kindDelta = KIND_RANK[left.kind] - KIND_RANK[right.kind];
  if (kindDelta !== 0) return kindDelta;

  if (left.kind === 'scene' && right.kind === 'scene') {
    const indexDelta = numericMetadata(left, 'index') - numericMetadata(right, 'index');
    if (indexDelta !== 0) return indexDelta;
  }
  if (left.kind === 'shot' && right.kind === 'shot') {
    const sceneDelta = numericMetadata(left, 'sceneIndex') - numericMetadata(right, 'sceneIndex');
    if (sceneDelta !== 0) return sceneDelta;
  }
  return left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
}

function dependencyDepths(snapshot: ProjectGraphSnapshot) {
  const dependencies = new Map<string, string[]>();
  for (const node of snapshot.nodes) dependencies.set(node.id, []);
  for (const edge of snapshot.dependencies) {
    dependencies.get(edge.dependent)?.push(edge.dependency);
  }

  const memo = new Map<string, number>();
  const visiting = new Set<string>();

  const depthOf = (id: string): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;

    visiting.add(id);
    const parents = dependencies.get(id) ?? [];
    const depth = parents.length === 0
      ? 0
      : 1 + Math.max(...parents.map((parent) => depthOf(parent)));
    visiting.delete(id);
    memo.set(id, depth);
    return depth;
  };

  for (const node of snapshot.nodes) depthOf(node.id);
  return memo;
}

export function workflowProjectKey(snapshot: ProjectGraphSnapshot) {
  const series = snapshot.nodes.find((node) => node.kind === 'series');
  const episode = snapshot.nodes.find((node) => node.kind === 'episode');
  return `${series?.id ?? 'series'}::${episode?.id ?? 'episode'}`;
}

export function defaultWorkflowPositions(snapshot: ProjectGraphSnapshot): WorkflowPositions {
  const depths = dependencyDepths(snapshot);
  const columns = new Map<number, ProjectNode[]>();

  for (const node of snapshot.nodes) {
    const depth = depths.get(node.id) ?? 0;
    const column = columns.get(depth) ?? [];
    column.push(node);
    columns.set(depth, column);
  }

  const positions: WorkflowPositions = {};
  const orderedDepths = [...columns.keys()].sort((left, right) => left - right);

  for (const depth of orderedDepths) {
    const nodes = [...(columns.get(depth) ?? [])].sort(compareNodes);
    nodes.forEach((node, row) => {
      positions[node.id] = {
        x: depth * COLUMN_GAP,
        y: row * ROW_GAP,
      };
    });
  }

  return positions;
}

export function loadWorkflowLayout(projectKey: string): WorkflowPositions {
  try {
    const raw = window.localStorage.getItem(storageKey(projectKey));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<StoredWorkflowLayout>;
    if (parsed.schemaVersion !== 1 || !parsed.positions || typeof parsed.positions !== 'object') return {};

    const positions: WorkflowPositions = {};
    for (const [id, position] of Object.entries(parsed.positions)) {
      if (finitePoint(position)) positions[id] = position;
    }
    return positions;
  } catch {
    return {};
  }
}

export function resolveWorkflowPositions(snapshot: ProjectGraphSnapshot, projectKey: string): WorkflowPositions {
  const defaults = defaultWorkflowPositions(snapshot);
  const saved = loadWorkflowLayout(projectKey);
  const positions: WorkflowPositions = {};

  for (const node of snapshot.nodes) {
    positions[node.id] = saved[node.id] ?? defaults[node.id] ?? { x: 0, y: 0 };
  }
  return positions;
}

export function saveWorkflowLayout(projectKey: string, positions: WorkflowPositions) {
  const safe: WorkflowPositions = {};
  for (const [id, position] of Object.entries(positions)) {
    if (finitePoint(position)) safe[id] = position;
  }

  try {
    const payload: StoredWorkflowLayout = { schemaVersion: 1, positions: safe };
    window.localStorage.setItem(storageKey(projectKey), JSON.stringify(payload));
  } catch {
    // Presentation state is intentionally best-effort and never blocks project edits.
  }
}

export function clearWorkflowLayout(projectKey: string) {
  try {
    window.localStorage.removeItem(storageKey(projectKey));
  } catch {
    // Presentation state is intentionally best-effort.
  }
}
