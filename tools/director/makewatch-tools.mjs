import { productionSchemaDigest } from './production-schema.mjs';

const NAMESPACE = 'makewatch';
const MAX_TOOL_COMMANDS = 64;
const MAX_QUERY_RESULTS = 100;
const MAX_REASON_CHARS = 600;
const MAX_RESULT_CHARS = 512_000;

const nodeKinds = [
  'series', 'episode', 'scene', 'shot', 'character',
  'location', 'asset', 'audio', 'generation',
];
const approvals = ['draft', 'review', 'approved', 'locked', 'invalidated', 'failed'];

const projectCommandSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'node'],
      properties: {
        type: { const: 'node.create' },
        node: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'kind', 'title', 'metadata', 'approval', 'locked', 'stale'],
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 160 },
            kind: { type: 'string', enum: nodeKinds },
            title: { type: 'string', minLength: 1, maxLength: 400 },
            metadata: { type: 'object', additionalProperties: { type: 'string', maxLength: 4000 } },
            approval: { type: 'string', enum: approvals },
            locked: { type: 'boolean' },
            stale: { type: 'boolean' },
          },
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'id'],
      properties: {
        type: { const: 'node.patch' },
        id: { type: 'string', minLength: 1, maxLength: 160 },
        expectedRevision: { type: 'integer', minimum: 0 },
        title: { type: 'string', minLength: 1, maxLength: 400 },
        approval: { type: 'string', enum: approvals },
        metadataUpdates: { type: 'object', additionalProperties: { type: 'string', maxLength: 4000 } },
        metadataRemovals: { type: 'array', maxItems: 128, items: { type: 'string', minLength: 1, maxLength: 160 } },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'id', 'locked'],
      properties: {
        type: { const: 'node.lock' },
        id: { type: 'string', minLength: 1, maxLength: 160 },
        locked: { type: 'boolean' },
        expectedRevision: { type: 'integer', minimum: 0 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'id'],
      properties: {
        type: { const: 'node.markFresh' },
        id: { type: 'string', minLength: 1, maxLength: 160 },
        expectedRevision: { type: 'integer', minimum: 0 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'dependent', 'dependency'],
      properties: {
        type: { enum: ['dependency.add', 'dependency.remove'] },
        dependent: { type: 'string', minLength: 1, maxLength: 160 },
        dependency: { type: 'string', minLength: 1, maxLength: 160 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'id'],
      properties: {
        type: { const: 'node.remove' },
        id: { type: 'string', minLength: 1, maxLength: 160 },
        expectedRevision: { type: 'integer', minimum: 0 },
      },
    },
  ],
};

const reasonProperty = {
  reason: {
    type: 'string',
    minLength: 3,
    maxLength: MAX_REASON_CHARS,
    description: 'Short durable reason describing why this project change is being made.',
  },
};

const functionTool = (name, description, inputSchema, deferLoading = false) => ({
  type: 'function',
  name,
  description,
  deferLoading,
  inputSchema,
});

export function makeWatchDynamicToolSpecs() {
  return [{
    type: 'namespace',
    name: NAMESPACE,
    description: 'Authoritative Make & Watch project and workflow operations. Use these tools instead of editing project files or claiming a change happened.',
    tools: [
      functionTool(
        'project_snapshot',
        'Read the complete authoritative live project graph and current project revision. Prefer project_query when only part of a large workflow is needed.',
        { type: 'object', additionalProperties: false, properties: {} },
      ),
      functionTool(
        'project_query',
        'Query a bounded subset of live project nodes by id, kind, or title text. Returns matching dependencies whose endpoints are both included.',
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            ids: { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 160 } },
            kinds: { type: 'array', maxItems: nodeKinds.length, items: { type: 'string', enum: nodeKinds } },
            text: { type: 'string', maxLength: 160 },
            limit: { type: 'integer', minimum: 1, maximum: MAX_QUERY_RESULTS },
          },
        },
      ),
      functionTool(
        'project_history',
        'Read recent durable native project transactions including actor, reason and event provenance.',
        {
          type: 'object',
          additionalProperties: false,
          properties: { limit: { type: 'integer', minimum: 1, maximum: 24 } },
        },
      ),
      functionTool(
        'project_impact',
        'Preview every downstream node affected by changing a source node, including locked and already-stale nodes.',
        {
          type: 'object',
          additionalProperties: false,
          required: ['source'],
          properties: { source: { type: 'string', minLength: 1, maxLength: 160 } },
        },
      ),
      functionTool(
        'project_apply',
        'Atomically mutate the live project through native typed commands. Always use the project revision you actually inspected. Locked nodes can only be changed after an explicit node.lock false command in the same or a prior transaction.',
        {
          type: 'object',
          additionalProperties: false,
          required: ['expectedProjectRevision', 'commands', 'reason'],
          properties: {
            expectedProjectRevision: { type: 'integer', minimum: 0 },
            commands: { type: 'array', minItems: 1, maxItems: MAX_TOOL_COMMANDS, items: projectCommandSchema },
            ...reasonProperty,
          },
        },
      ),
      functionTool(
        'workflow_new',
        'Replace the active project with a clean empty workflow. This is destructive to the active graph, so use it only when the user explicitly wants a new/clean workflow. Make & Watch automatically creates a recovery checkpoint first.',
        {
          type: 'object',
          additionalProperties: false,
          required: ['expectedProjectRevision', 'reason'],
          properties: {
            expectedProjectRevision: { type: 'integer', minimum: 0 },
            ...reasonProperty,
          },
        },
      ),
      functionTool(
        'workflow_save',
        'Save the current authoritative workflow as a durable named snapshot without changing the active project.',
        {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 120 },
            description: { type: 'string', maxLength: 800 },
          },
        },
      ),
      functionTool(
        'workflow_list',
        'List saved workflows and optional automatic recovery checkpoints. Metadata only; snapshots are loaded only when requested.',
        {
          type: 'object',
          additionalProperties: false,
          properties: { includeRecovery: { type: 'boolean' } },
        },
      ),
      functionTool(
        'workflow_load',
        'Load a saved workflow into the active native project. This replaces the active graph, advances the live revision, journals the restore, and automatically saves a recovery checkpoint first.',
        {
          type: 'object',
          additionalProperties: false,
          required: ['workflowId', 'expectedProjectRevision', 'reason'],
          properties: {
            workflowId: { type: 'string', minLength: 8, maxLength: 100 },
            expectedProjectRevision: { type: 'integer', minimum: 0 },
            ...reasonProperty,
          },
        },
      ),
      functionTool(
        'production_schema',
        'Read the authoritative Make & Watch production node schema: what each node kind means, which metadata keys the generation and rendering pipeline actually reads, their enum domains and defaults. Call this before authoring Series/Episode/Scene/Shot/Character/Location metadata so keys are not invented.',
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            kinds: { type: 'array', maxItems: nodeKinds.length, items: { type: 'string', enum: nodeKinds } },
          },
        },
        true,
      ),
      functionTool(
        'generation_provider',
        'Read local media runtime status (ComfyUI storyboard preview and Chatterbox voice). Check this before promising visual or voice output; when a runtime is offline, say so instead of claiming generation succeeded.',
        { type: 'object', additionalProperties: false, properties: {} },
      ),
      functionTool(
        'scene_generate',
        'Start real local storyboard preview image generation for every Shot linked to a Scene. Returns a queued job immediately; poll generation_job for progress. Make & Watch writes generation provenance and Asset nodes back into the authoritative project itself, so do not fabricate those nodes.',
        {
          type: 'object',
          additionalProperties: false,
          required: ['sceneId'],
          properties: { sceneId: { type: 'string', minLength: 1, maxLength: 160 } },
        },
      ),
      functionTool(
        'audio_generate',
        'Start real local voice synthesis for one Audio node. Returns a queued job; poll generation_job with kind audio.',
        {
          type: 'object',
          additionalProperties: false,
          required: ['audioId'],
          properties: { audioId: { type: 'string', minLength: 1, maxLength: 160 } },
        },
      ),
      functionTool(
        'episode_compose',
        'Compile the render manifest for one Episode without rendering anything: the ordered Scenes and Shots, which visuals and voice lines are actually generated, the resolved timeline, and every issue that still blocks a render. Read-only. Call this before episode_render and report its issues instead of starting a render that cannot succeed.',
        {
          type: 'object',
          additionalProperties: false,
          required: ['episodeId'],
          properties: { episodeId: { type: 'string', minLength: 1, maxLength: 160 } },
        },
        true,
      ),
      functionTool(
        'episode_render',
        'Assemble one Episode into a real video file from its already generated Shot visuals and audio, applying each Shot camera move and the authored transitions between Shots. Returns a queued job immediately; poll generation_job with kind render. Requires the Shots to be generated first, so check episode_compose is ready before calling this.',
        {
          type: 'object',
          additionalProperties: false,
          required: ['episodeId'],
          properties: { episodeId: { type: 'string', minLength: 1, maxLength: 160 } },
        },
      ),
      functionTool(
        'generation_job',
        'Read one media generation job by id, including status, progress, produced artifacts and any failure reason. Use kind render for an episode assembly job.',
        {
          type: 'object',
          additionalProperties: false,
          required: ['jobId'],
          properties: {
            jobId: { type: 'string', minLength: 8, maxLength: 80 },
            kind: { type: 'string', enum: ['visual', 'audio', 'render'] },
          },
        },
      ),
      functionTool(
        'generation_jobs',
        'List recent media generation jobs so progress can be reported without guessing.',
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['visual', 'audio', 'render'] },
            limit: { type: 'integer', minimum: 1, maximum: 50 },
          },
        },
      ),
      functionTool(
        'workflow_delete',
        'Delete one saved workflow snapshot. Use only when the user explicitly asks to delete that saved copy. This never deletes the active project.',
        {
          type: 'object',
          additionalProperties: false,
          required: ['workflowId', 'confirm'],
          properties: {
            workflowId: { type: 'string', minLength: 8, maxLength: 100 },
            confirm: { const: true },
          },
        },
      ),
    ],
  }];
}

function objectArguments(value) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('tool arguments must be an object');
  return value;
}

// Job queues are kept separate per media kind, so an unrecognised kind must
// fall back to the visual queue rather than reaching a queue that has no such id.
const JOB_KINDS = new Set(['visual', 'audio', 'render']);

function jobKind(value) {
  const kind = String(value ?? '').trim();
  return JOB_KINDS.has(kind) ? kind : 'visual';
}

function safeInteger(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER, fallback = null } = {}) {
  if (value === undefined && fallback !== null) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function boundedString(value, label, maximum, { required = false } = {}) {
  const text = String(value ?? '').trim();
  if (required && !text) throw new Error(`${label} is required`);
  if (text.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
  return text;
}

function querySnapshot(snapshot, input) {
  const ids = Array.isArray(input.ids) ? new Set(input.ids.map((value) => String(value))) : null;
  const kinds = Array.isArray(input.kinds) ? new Set(input.kinds.map((value) => String(value))) : null;
  const text = boundedString(input.text, 'text', 160).toLocaleLowerCase();
  const limit = safeInteger(input.limit, 'limit', { minimum: 1, maximum: MAX_QUERY_RESULTS, fallback: 40 });
  const nodes = snapshot.nodes
    .filter((node) => (!ids || ids.has(node.id)) && (!kinds || kinds.has(node.kind)))
    .filter((node) => !text || node.id.toLocaleLowerCase().includes(text) || node.title.toLocaleLowerCase().includes(text))
    .slice(0, limit);
  const included = new Set(nodes.map((node) => node.id));
  return {
    schemaVersion: 1,
    projectRevision: snapshot.projectRevision,
    totalNodeCount: snapshot.nodes.length,
    matchedNodeCount: nodes.length,
    nodes,
    dependencies: snapshot.dependencies.filter((edge) => included.has(edge.dependent) && included.has(edge.dependency)),
  };
}

function boundedToolResult(value) {
  const text = JSON.stringify(value);
  if (text.length > MAX_RESULT_CHARS) {
    throw new Error(`tool result exceeds ${MAX_RESULT_CHARS} characters; query a smaller project subset`);
  }
  return text;
}

export async function handleMakeWatchToolCall(call, runtime) {
  if (!runtime) throw new Error('Make & Watch project tool runtime is unavailable');
  if (!call || call.namespace !== NAMESPACE) throw new Error('unknown dynamic tool namespace');
  const input = objectArguments(call.arguments);

  let result;
  switch (call.tool) {
    case 'project_snapshot':
      result = await runtime.snapshot();
      break;
    case 'project_query':
      result = querySnapshot(await runtime.snapshot(), input);
      break;
    case 'project_history':
      result = await runtime.history(safeInteger(input.limit, 'limit', { minimum: 1, maximum: 24, fallback: 10 }));
      break;
    case 'project_impact':
      result = await runtime.impact(boundedString(input.source, 'source', 160, { required: true }));
      break;
    case 'project_apply': {
      const expectedProjectRevision = safeInteger(input.expectedProjectRevision, 'expectedProjectRevision');
      if (!Array.isArray(input.commands) || input.commands.length < 1 || input.commands.length > MAX_TOOL_COMMANDS) {
        throw new Error(`commands must contain between 1 and ${MAX_TOOL_COMMANDS} items`);
      }
      const reason = boundedString(input.reason, 'reason', MAX_REASON_CHARS, { required: true });
      result = await runtime.apply({
        expectedProjectRevision,
        commands: input.commands,
        reason,
        callId: call.callId,
      });
      break;
    }
    case 'workflow_new':
      result = await runtime.newWorkflow({
        expectedProjectRevision: safeInteger(input.expectedProjectRevision, 'expectedProjectRevision'),
        reason: boundedString(input.reason, 'reason', MAX_REASON_CHARS, { required: true }),
        callId: call.callId,
      });
      break;
    case 'workflow_save':
      result = await runtime.saveWorkflow({
        name: boundedString(input.name, 'name', 120, { required: true }),
        description: boundedString(input.description, 'description', 800),
      });
      break;
    case 'workflow_list':
      result = await runtime.listWorkflows({ includeRecovery: input.includeRecovery !== false });
      break;
    case 'workflow_load':
      result = await runtime.loadWorkflow({
        workflowId: boundedString(input.workflowId, 'workflowId', 100, { required: true }),
        expectedProjectRevision: safeInteger(input.expectedProjectRevision, 'expectedProjectRevision'),
        reason: boundedString(input.reason, 'reason', MAX_REASON_CHARS, { required: true }),
        callId: call.callId,
      });
      break;
    case 'production_schema': {
      const kinds = Array.isArray(input.kinds) ? input.kinds.map((value) => String(value)) : null;
      result = productionSchemaDigest(kinds);
      break;
    }
    case 'generation_provider':
      result = await runtime.generationProvider();
      break;
    case 'scene_generate':
      result = await runtime.startSceneGeneration({
        sceneId: boundedString(input.sceneId, 'sceneId', 160, { required: true }),
      });
      break;
    case 'audio_generate':
      result = await runtime.startAudioGeneration({
        audioId: boundedString(input.audioId, 'audioId', 160, { required: true }),
      });
      break;
    case 'episode_compose':
      result = await runtime.episodeComposition({
        episodeId: boundedString(input.episodeId, 'episodeId', 160, { required: true }),
      });
      break;
    case 'episode_render':
      result = await runtime.startEpisodeRender({
        episodeId: boundedString(input.episodeId, 'episodeId', 160, { required: true }),
      });
      break;
    case 'generation_job':
      result = await runtime.generationJob({
        jobId: boundedString(input.jobId, 'jobId', 80, { required: true }),
        kind: jobKind(input.kind),
      });
      break;
    case 'generation_jobs':
      result = await runtime.generationJobs({
        kind: jobKind(input.kind),
        limit: safeInteger(input.limit, 'limit', { minimum: 1, maximum: 50, fallback: 20 }),
      });
      break;
    case 'workflow_delete':
      if (input.confirm !== true) throw new Error('workflow_delete requires confirm=true');
      result = await runtime.deleteWorkflow({
        workflowId: boundedString(input.workflowId, 'workflowId', 100, { required: true }),
      });
      break;
    default:
      throw new Error(`unknown Make & Watch tool: ${String(call.tool)}`);
  }

  return boundedToolResult(result);
}

export const makeWatchToolLimits = Object.freeze({
  namespace: NAMESPACE,
  maxCommands: MAX_TOOL_COMMANDS,
  maxQueryResults: MAX_QUERY_RESULTS,
  maxResultChars: MAX_RESULT_CHARS,
});
