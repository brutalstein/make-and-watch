import { createHash } from 'node:crypto';

const MAX_PROMPT_CHARS = 12_000;
const MAX_MESSAGE_CHARS = 6_000;
const MAX_NODES = 36;
const MAX_DEPENDENCIES = 72;
const MAX_METADATA_VALUE_CHARS = 120;

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

const CHAT_DIRECTIVE = [
  'You are the Make & Watch creative Director chat.',
  'Discuss story, episode structure, character continuity, shot design and production choices with the user.',
  'Native project state is authoritative. Do not edit files, run commands, claim media was generated, or mutate project state from chat.',
  'When the user wants a decision applied, explain the intended change clearly so Studio can later convert it into a validated plan.',
  'Keep answers useful and concise unless the user asks for detail.',
].join(' ');

function boundedText(value, maximum) {
  const text = String(value ?? '').trim();
  return text.length <= maximum ? text : `${text.slice(0, Math.max(0, maximum - 1))}…`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
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

function priorityNodes(snapshot, selectedId) {
  const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
  const selected = selectedId ? nodes.find((node) => node.id === selectedId) : null;
  const anchors = nodes.filter((node) => node.kind === 'series' || node.kind === 'episode' || node.kind === 'character');
  const seen = new Set();
  return [selected, ...anchors, ...nodes]
    .filter(Boolean)
    .filter((node) => {
      if (seen.has(node.id)) return false;
      seen.add(node.id);
      return true;
    });
}

function compactNodes(snapshot, selectedId, limit) {
  return priorityNodes(snapshot, selectedId).slice(0, limit).map((node) => ({
    id: boundedText(node.id, 160),
    kind: node.kind,
    title: boundedText(node.title, 140),
    revision: node.revision,
    approval: node.approval,
    locked: Boolean(node.locked),
    stale: Boolean(node.stale),
    metadata: compactMetadata(node.metadata),
  }));
}

function compactDependencies(snapshot, allowedIds, limit) {
  const dependencies = Array.isArray(snapshot?.dependencies) ? snapshot.dependencies : [];
  return dependencies
    .filter((edge) => allowedIds.has(edge.dependent) && allowedIds.has(edge.dependency))
    .slice(0, limit)
    .map((edge) => ({ dependent: boundedText(edge.dependent, 160), dependency: boundedText(edge.dependency, 160) }));
}

function makePrompt({ message, snapshot, selectedId, firstTurn, nodeLimit, dependencyLimit }) {
  const nodes = compactNodes(snapshot, selectedId, nodeLimit);
  const ids = new Set(nodes.map((node) => node.id));
  const dependencies = compactDependencies(snapshot, ids, dependencyLimit);
  const liveContext = {
    projectRevision: snapshot.projectRevision,
    selectedId: selectedId && ids.has(selectedId) ? selectedId : null,
    nodes,
    dependencies,
  };

  const sections = [CHAT_DIRECTIVE];
  if (firstTurn) {
    sections.push('This is the first turn in this Director conversation. Use this bounded live project context as the shared starting point:');
    sections.push(stableStringify(liveContext));
  } else {
    sections.push(`Live project revision is ${snapshot.projectRevision}.${selectedId ? ` Current Studio selection: ${boundedText(selectedId, 160)}.` : ''}`);
    sections.push('Continue from the existing conversation history. Do not assume project state changed merely because it was discussed.');
  }
  sections.push('User message:');
  sections.push(boundedText(message, MAX_MESSAGE_CHARS));
  return { prompt: sections.join('\n\n'), nodes, dependencies };
}

export function buildDirectorChatTurn({ message, snapshot, selectedId = null, firstTurn = false }) {
  if (!snapshot || snapshot.schemaVersion !== 1 || !Number.isInteger(snapshot.projectRevision)) {
    throw new Error('Director chat requires a valid project snapshot');
  }
  if (typeof message !== 'string' || !message.trim()) throw new Error('Director chat message is required');

  let nodeLimit = firstTurn ? MAX_NODES : Math.min(12, MAX_NODES);
  let dependencyLimit = firstTurn ? MAX_DEPENDENCIES : 24;
  let result = makePrompt({ message, snapshot, selectedId, firstTurn, nodeLimit, dependencyLimit });

  while (result.prompt.length > MAX_PROMPT_CHARS && (nodeLimit > 4 || dependencyLimit > 0)) {
    if (dependencyLimit > 0) dependencyLimit = Math.max(0, dependencyLimit - 12);
    else nodeLimit = Math.max(4, nodeLimit - 4);
    result = makePrompt({ message, snapshot, selectedId, firstTurn, nodeLimit, dependencyLimit });
  }
  if (result.prompt.length > MAX_PROMPT_CHARS) throw new Error('Director chat context cannot fit the hard prompt budget');

  return {
    prompt: result.prompt,
    hash: createHash('sha256').update(result.prompt).digest('hex'),
    chars: result.prompt.length,
    estimatedTokens: Math.ceil(result.prompt.length / 4),
    nodeCountIncluded: result.nodes.length,
    dependencyCountIncluded: result.dependencies.length,
  };
}
