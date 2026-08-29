import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const stableContextPath = resolve(root, 'project_brain', 'AI_DIRECTOR_CONTEXT.md');

const MAX_CONTEXT_CHARS = 16_000;
const MAX_OBJECTIVE_CHARS = 3_000;
const MAX_NODES = 72;
const MAX_DEPENDENCIES = 120;
const MAX_METADATA_VALUE_CHARS = 120;

const CORE_RUNTIME_DIRECTIVE = [
  'You are the Make & Watch creative Director, not a repository coding agent.',
  'Native C++ project truth, locks, revisions, dependency invalidation and resource admission are authoritative.',
  'Return only the smallest sufficient AutopilotPlan v1 JSON. Never edit files, run commands, bypass native policy, or expose hidden reasoning.',
  'Preserve locked/user-approved continuity. Prefer minimal incremental scope and explicit impact/checkpoints for risky semantic edits.',
].join(' ');

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

let policyHashPromise = null;

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

async function policyHash() {
  if (!policyHashPromise) {
    policyHashPromise = readFile(stableContextPath, 'utf8').then((text) =>
      createHash('sha256').update(text).digest('hex').slice(0, 16));
  }
  return policyHashPromise;
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

function compactNodes(snapshot, selectedId, maximum, includeMetadata) {
  const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
  const selected = selectedId ? nodes.find((node) => node.id === selectedId) : null;
  const ordered = selected ? [selected, ...nodes.filter((node) => node.id !== selected.id)] : nodes;

  return ordered.slice(0, maximum).map((node) => ({
    id: boundedText(node.id, 160),
    kind: node.kind,
    title: boundedText(node.title, 140),
    revision: node.revision,
    approval: node.approval,
    locked: Boolean(node.locked),
    stale: Boolean(node.stale),
    ...(includeMetadata ? { metadata: compactMetadata(node.metadata) } : {}),
  }));
}

function compactDependencies(snapshot, includedIds, maximum) {
  const dependencies = Array.isArray(snapshot?.dependencies) ? snapshot.dependencies : [];
  return dependencies
    .filter((edge) => includedIds.has(edge.dependent) && includedIds.has(edge.dependency))
    .slice(0, maximum)
    .map((edge) => ({ dependent: boundedText(edge.dependent, 160), dependency: boundedText(edge.dependency, 160) }));
}

function compactPositions(positions, allowedIds, maximum) {
  if (!positions || typeof positions !== 'object') return undefined;
  const result = {};
  let count = 0;
  for (const id of Object.keys(positions).sort()) {
    if (count >= maximum || !allowedIds.has(id)) continue;
    const point = positions[id];
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    result[id] = { x: Math.round(point.x), y: Math.round(point.y) };
    count += 1;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function renderPrompt(dynamic, provider, projectRevision, truncated) {
  return [
    'MAKEWATCH DIRECTOR MODE',
    CORE_RUNTIME_DIRECTIVE,
    '',
    'The official provider runtime already loaded project-scoped Director instructions. Do not re-read or restate them.',
    truncated ? 'Live bounded project context (deterministically reduced to stay within the context budget):' : 'Live bounded project context:',
    stableStringify(dynamic),
    '',
    'Return exactly one AutopilotPlan v1 JSON object. No Markdown fences, commentary, or reasoning transcript.',
    `Set provider=${provider}; expectedProjectRevision=${projectRevision}.`,
  ].join('\n');
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
  if (!['assist', 'guided', 'director'].includes(mode)) throw new Error('Director context mode must be assist, guided, or director');
  if (!['codex', 'claude'].includes(provider)) throw new Error('Director context provider must be codex or claude');

  const stablePolicyHash = await policyHash();
  let nodeLimit = MAX_NODES;
  let dependencyLimit = MAX_DEPENDENCIES;
  let objectiveLimit = MAX_OBJECTIVE_CHARS;
  let includeMetadata = true;
  let truncated = false;
  let dynamic = null;
  let prompt = '';

  for (let attempt = 0; attempt < 32; attempt += 1) {
    const nodes = compactNodes(snapshot, selectedId, nodeLimit, includeMetadata);
    const allowedIds = new Set(nodes.map((node) => node.id));
    const dependencies = compactDependencies(snapshot, allowedIds, dependencyLimit);
    dynamic = {
      policyHash: stablePolicyHash,
      provider,
      mode,
      expectedProjectRevision: snapshot.projectRevision,
      selectedId: selectedId && allowedIds.has(selectedId) ? selectedId : null,
      objective: boundedText(objective, objectiveLimit),
      project: {
        totalNodeCount: Array.isArray(snapshot.nodes) ? snapshot.nodes.length : 0,
        totalDependencyCount: Array.isArray(snapshot.dependencies) ? snapshot.dependencies.length : 0,
        nodes,
        dependencies,
        workspacePositions: compactPositions(workspacePositions, allowedIds, nodeLimit),
      },
    };
    prompt = renderPrompt(dynamic, provider, snapshot.projectRevision, truncated);
    if (prompt.length <= MAX_CONTEXT_CHARS) break;

    truncated = true;
    if (dependencyLimit > Math.max(24, nodeLimit * 2)) dependencyLimit = Math.max(24, dependencyLimit - 20);
    else if (nodeLimit > 16) nodeLimit = Math.max(16, nodeLimit - 8);
    else if (objectiveLimit > 800) objectiveLimit = Math.max(800, objectiveLimit - 400);
    else if (includeMetadata) includeMetadata = false;
    else if (nodeLimit > 4) nodeLimit = Math.max(4, nodeLimit - 4);
    else throw new Error('Director context cannot be represented inside the configured hard budget');
  }

  if (!dynamic || prompt.length > MAX_CONTEXT_CHARS) throw new Error('Director context compiler failed to satisfy its hard budget');
  const dynamicJson = stableStringify(dynamic);
  JSON.parse(dynamicJson);

  const hash = createHash('sha256').update(prompt).digest('hex');
  return {
    prompt,
    hash,
    chars: prompt.length,
    estimatedTokens: Math.ceil(prompt.length / 4),
    nodeCountIncluded: dynamic.project.nodes.length,
    dependencyCountIncluded: dynamic.project.dependencies.length,
  };
}
