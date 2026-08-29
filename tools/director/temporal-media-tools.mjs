const NAMESPACE = 'makewatch_media';
const MAX_RESULT_BYTES = 384 * 1024;

const functionTool = (name, description, inputSchema, deferLoading = false) => ({
  type: 'function',
  name,
  description,
  deferLoading,
  inputSchema,
});

export function temporalMediaDynamicToolSpecs() {
  return [{
    type: 'namespace',
    name: NAMESPACE,
    description: 'Bounded local temporal-video operations for Make & Watch. Use these after authoring Shot semantics through makewatch project tools. Media execution is authoritative: never claim video exists without a successful job result.',
    tools: [
      functionTool(
        'temporal_providers',
        'Inspect installed/ready temporal video providers and actual local hardware readiness. Provider selection is explicit; do not invent an unavailable provider.',
        { type: 'object', additionalProperties: false, properties: {} },
      ),
      functionTool(
        'shot_temporal_plan',
        'Compile a read-only temporal execution plan for one Shot: strategy, hero/end frame Assets, Character/Location reference Assets, bounded segments and resource policy. Use this before starting expensive I2V/video generation.',
        {
          type: 'object',
          additionalProperties: false,
          required: ['shotId'],
          properties: {
            shotId: { type: 'string', minLength: 1, maxLength: 160 },
            maxSegmentSeconds: { type: 'number', minimum: 1, maximum: 10 },
          },
        },
        true,
      ),
      functionTool(
        'shot_generate_video',
        'Start real local temporal video generation for one already-authored Shot using an explicit ready provider. The Shot must use a temporal generationStrategy and have required frame/reference Assets. Returns a queued job; poll temporal_job. Do not fabricate Generation/Asset nodes: the media gateway writes provenance after validated output.',
        {
          type: 'object',
          additionalProperties: false,
          required: ['shotId', 'providerId'],
          properties: {
            shotId: { type: 'string', minLength: 1, maxLength: 160 },
            providerId: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z0-9][a-z0-9._-]*$' },
          },
        },
      ),
      functionTool(
        'temporal_job',
        'Read one temporal-video job including queued/running/completed/failed state, progress, provider, strategy, produced Asset metadata and failure reason.',
        {
          type: 'object',
          additionalProperties: false,
          required: ['jobId'],
          properties: { jobId: { type: 'string', minLength: 8, maxLength: 80 } },
        },
      ),
      functionTool(
        'temporal_jobs',
        'List recent temporal-video jobs for progress/recovery inspection. This is job state only; authoritative media provenance remains in the project graph.',
        {
          type: 'object',
          additionalProperties: false,
          properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } },
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

function boundedString(value, label, maximum) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label} is required`);
  if (text.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
  return text;
}

function boundedLimit(value) {
  if (value === undefined || value === null) return 20;
  if (!Number.isInteger(value) || value < 1 || value > 50) throw new Error('limit must be an integer between 1 and 50');
  return value;
}

function boundedSegmentSeconds(value) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isFinite(value) || value < 1 || value > 10) throw new Error('maxSegmentSeconds must be between 1 and 10');
  return value;
}

function boundedResult(value) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, 'utf8') > MAX_RESULT_BYTES) {
    throw new Error(`temporal media tool result exceeds ${MAX_RESULT_BYTES} bytes`);
  }
  return text;
}

export async function handleTemporalMediaToolCall(call, runtime) {
  if (!runtime) throw new Error('temporal media tool runtime is unavailable');
  if (!call || call.namespace !== NAMESPACE) throw new Error('unknown temporal media tool namespace');
  const input = objectArguments(call.arguments);
  let result;
  switch (call.tool) {
    case 'temporal_providers':
      result = await runtime.temporalProviders();
      break;
    case 'shot_temporal_plan':
      result = await runtime.temporalShotPlan({
        shotId: boundedString(input.shotId, 'shotId', 160),
        maxSegmentSeconds: boundedSegmentSeconds(input.maxSegmentSeconds),
      });
      break;
    case 'shot_generate_video':
      result = await runtime.startTemporalShotGeneration({
        shotId: boundedString(input.shotId, 'shotId', 160),
        providerId: boundedString(input.providerId, 'providerId', 64),
      });
      break;
    case 'temporal_job':
      result = await runtime.temporalJob({ jobId: boundedString(input.jobId, 'jobId', 80) });
      break;
    case 'temporal_jobs':
      result = await runtime.temporalJobs({ limit: boundedLimit(input.limit) });
      break;
    default:
      throw new Error(`unknown temporal media tool: ${String(call.tool)}`);
  }
  return boundedResult(result);
}

export const temporalMediaToolLimits = Object.freeze({
  namespace: NAMESPACE,
  maxResultBytes: MAX_RESULT_BYTES,
});
