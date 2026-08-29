import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const stableContextPath = resolve(root, 'project_brain', 'AI_DIRECTOR_CONTEXT.md');

const MAX_CONTEXT_CHARS = 24_000;
const MAX_OBJECTIVE_CHARS = 4_000;
const MAX_NODES = 96;
const MAX_DEPENDENCIES = 160;
const MAX_METADATA_VALUE_CHARS = 160;

const USEFUL_METADATA_KEYS = new Set([
  'index',
  'episodeNumber',
  'targetDurationSeconds',
  'durationSeconds',
  'role',
  'status',
  'generationStrategy',
  'city',
  'time',
  'mode',
]);

let stableContextPromise = null;

function boundedText(value, maximum) {
  const text = String(value ?? '').trim();
  if (text.length <= maximum) return text;
  return `${text.slice(0, Math.max(0, maximum - 1))}…`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function stableContext() {
  if (!stableContextPromise) {
    stableContextPromise = readFile(stableContextPath, 'utf8').then((text) => text.trim());
  }
  return stableContextPromise;
}

function compactMetadata(metadata) {
  const result = {};
  if (!metadata || typeof metadata !== 'object') return result;
  for (const key of Object.keys(metadata).sort()) {
    if (!USEFUL_METADATA_KEYS.has(key)) continue;
    result[key] = boundedText(metadata[key], MAX_METADATA_VALUE_CHARS);
  }
  return result;
}

function compactNodes(snapshot, selectedId) {
  const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
  const selected = selectedId ? nodes.find((node) => node.id === selectedId) : null;
  const ordered = selected
    ? [selected, ...nodes.filter((node) => node.id !== selected.id)]
    : nodes;

  return ordered.slice(0, MAX_NODES).map((node) => ({
    id: boundedText(node.id, 180),
    kind: node.kind,
    title: boundedText(node.title, 180),
    revision: node.revision,
    approval: node.approval,
    locked: Boolean(node.locked),
    stale: Boolean(node.stale),
    metadata: compactMetadata(node.metadata),
  }));
}

function compactDependencies(snapshot) {
  const dependencies = Array.isArray(snapshot?.dependencies) ? snapshot.dependencies : [];
  return dependencies.slice(0, MAX_DEPENDENCIES).map((edge) => ({
    dependent: boundedText(edge.dependent, 180),
    dependency: boundedText(edge.dependency, 180),
  }));
}

function compactPositions(positions, allowedIds) {
  if (!positions || typeof positions !== 'object') return undefined;
  const result = {};
  let count = 0;
  for (const id of Object.keys(positions).sort()) {
    if (count >= MAX_NODES || !allowedIds.has(id)) continue;
    const point = positions[id];
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    result[id] = { x: Math.round(point.x), y: Math.round(point.y) };
    count += 1;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export async function buildDirectorContextPack({
  provider,
  objective,
  mode,
  snapshot,
  selectedId = null,
  workspacePositions = null,
}) {
  if (!snapshot || snapshot.schemaVersion !== 1 || !Number.isInteger(snapshot.projectRevision)) {
    throw new Error('Director context requires a valid project snapshot');
  }
  if (!['assist', 'guided', 'director'].includes(mode)) {
    throw new Error('Director context mode must be assist, guided, or director');
  }
  if (!['codex', 'claude'].includes(provider)) {
    throw new Error('Director context provider must be codex or claude');
  }

  const nodes = compactNodes(snapshot, selectedId);
  const allowedIds = new Set(nodes.map((node) => node.id));
  const dynamic = {
    provider,
    mode,
    expectedProjectRevision: snapshot.projectRevision,
    selectedId: selectedId && allowedIds.has(selectedId) ? selectedId : null,
    objective: boundedText(objective, MAX_OBJECTIVE_CHARS),
    project: {
      nodeCount: Array.isArray(snapshot.nodes) ? snapshot.nodes.length : 0,
      dependencyCount: Array.isArray(snapshot.dependencies) ? snapshot.dependencies.length : 0,
      nodes,
      dependencies: compactDependencies(snapshot),
      workspacePositions: compactPositions(workspacePositions, allowedIds),
    },
  };

  const stable = await stableContext();
  const dynamicJson = stableStringify(dynamic);
  let prompt = [
    'MAKEWATCH DIRECTOR MODE',
    '',
    stable,
    '',
    '## Live bounded context',
    dynamicJson,
    '',
    '## Required response',
    'Return exactly one AutopilotPlan v1 JSON object. No Markdown fences, commentary, or hidden reasoning.',
    `Set provider to ${provider} and expectedProjectRevision to ${snapshot.projectRevision}.`,
    'Use the smallest sufficient ordered step list. The Studio validator and native engine remain authoritative.',
  ].join('\n');

  if (prompt.length > MAX_CONTEXT_CHARS) {
    const overflow = prompt.length - MAX_CONTEXT_CHARS;
    const reducedDynamic = dynamicJson.slice(0, Math.max(0, dynamicJson.length - overflow - 80));
    prompt = [
      'MAKEWATCH DIRECTOR MODE',
      '',
      stable,
      '',
      '## Live bounded context',
      `${reducedDynamic}\n[context truncated by bounded compiler]`,
      '',
      '## Required response',
      'Return exactly one AutopilotPlan v1 JSON object. No Markdown fences or commentary.',
      `Set provider to ${provider} and expectedProjectRevision to ${snapshot.projectRevision}.`,
    ].join('\n');
  }

  const hash = createHash('sha256').update(prompt).digest('hex');
  return {
    prompt,
    hash,
    chars: prompt.length,
    estimatedTokens: Math.ceil(prompt.length / 4),
    nodeCountIncluded: nodes.length,
    dependencyCountIncluded: Math.min(snapshot.dependencies.length, MAX_DEPENDENCIES),
  };
}
