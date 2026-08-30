const NAMESPACE = 'makewatch_media';
const MAX_RESULT_BYTES = 384 * 1024;
const REFERENCE_STYLE_PRESETS = ['live-action-cinematic', 'anime-cinematic', 'illustration', 'stylized-3d'];
const MEDIA_JOB_KINDS = ['visual', 'reference', 'audio', 'temporal', 'anime', 'render'];

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
    description: 'Bounded authoritative local media operations for Make & Watch: canonical Character/Location references and temporal Shot video. Use project tools for semantic authoring, then use these execution tools. Never claim media exists without a successful job result.',
    tools: [
      functionTool(
        'audio_provider',
        'Inspect the real local Chatterbox installation, model/runtime readiness and supported languages before starting Japanese performance generation.',
        { type: 'object', additionalProperties: false, properties: {} },
      ),
      functionTool(
        'reference_provider',
        'Inspect the real local canonical-reference image provider. Check this before promising Character/Location reference generation. It reports whether ComfyUI can perform text-to-image and reference-guided img2img.',
        { type: 'object', additionalProperties: false, properties: {} },
      ),
      functionTool(
        'reference_generate',
        'Generate and durably attach one canonical image reference to an existing Character or Location. sourceAssetId is optional: omit it for text-to-image design, or provide a durable image Asset for reference-guided img2img such as an anime adaptation. Returns a queued job; poll reference_job. The gateway writes Generation/Asset provenance and the target dependency itself.',
        {
          type: 'object',
          additionalProperties: false,
          required: ['targetId'],
          properties: {
            targetId: { type: 'string', minLength: 1, maxLength: 160 },
            sourceAssetId: { type: 'string', minLength: 1, maxLength: 160 },
            stylePreset: { type: 'string', enum: REFERENCE_STYLE_PRESETS },
            direction: { type: 'string', maxLength: 4000 },
            denoise: { type: 'number', minimum: 0.15, maximum: 0.9 },
          },
        },
      ),
      functionTool(
        'reference_job',
        'Read one canonical-reference generation job including target, source Asset, style, progress, produced Asset metadata and failure reason.',
        {
          type: 'object',
          additionalProperties: false,
          required: ['jobId'],
          properties: { jobId: { type: 'string', minLength: 8, maxLength: 80 } },
        },
      ),
      functionTool(
        'reference_jobs',
        'List recent canonical Character/Location reference-generation jobs. Authoritative provenance remains in the native project graph.',
        {
          type: 'object',
          additionalProperties: false,
          properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } },
        },
      ),
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
      functionTool(
        'media_job_cancel',
        'Cancel one queued or running bounded media job. Running cancellation returns only after the owned worker or FFmpeg process has stopped; completed, failed and already-cancelled jobs are unchanged.',
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'jobId'],
          properties: {
            kind: { type: 'string', enum: MEDIA_JOB_KINDS },
            jobId: { type: 'string', minLength: 1, maxLength: 180, pattern: '^[A-Za-z0-9._:-]+$' },
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

function boundedString(value, label, maximum) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label} is required`);
  if (text.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
  return text;
}

function optionalString(value, label, maximum) {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value).trim();
  if (text.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
  return text || undefined;
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

function boundedDenoise(value) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isFinite(value) || value < 0.15 || value > 0.9) throw new Error('denoise must be between 0.15 and 0.9');
  return value;
}

function boundedReferenceStyle(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const style = String(value);
  if (!REFERENCE_STYLE_PRESETS.includes(style)) throw new Error(`stylePreset must be one of ${REFERENCE_STYLE_PRESETS.join(', ')}`);
  return style;
}

function boundedJobKind(value) {
  const kind = String(value ?? '');
  if (!MEDIA_JOB_KINDS.includes(kind)) throw new Error(`kind must be one of ${MEDIA_JOB_KINDS.join(', ')}`);
  return kind;
}

function boundedJobId(value) {
  const id = boundedString(value, 'jobId', 180);
  if (!/^[A-Za-z0-9._:-]+$/.test(id)) throw new Error('jobId is invalid; use the ID returned by the media start tool');
  return id;
}

function boundedResult(value) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, 'utf8') > MAX_RESULT_BYTES) {
    throw new Error(`media tool result exceeds ${MAX_RESULT_BYTES} bytes`);
  }
  return text;
}

export async function handleTemporalMediaToolCall(call, runtime) {
  if (!runtime) throw new Error('media tool runtime is unavailable');
  if (!call || call.namespace !== NAMESPACE) throw new Error('unknown media tool namespace');
  const input = objectArguments(call.arguments);
  let result;
  switch (call.tool) {
    case 'audio_provider':
      result = await runtime.audioProvider();
      break;
    case 'reference_provider':
      result = await runtime.referenceProvider();
      break;
    case 'reference_generate':
      result = await runtime.startReferenceGeneration({
        targetId: boundedString(input.targetId, 'targetId', 160),
        sourceAssetId: optionalString(input.sourceAssetId, 'sourceAssetId', 160),
        stylePreset: boundedReferenceStyle(input.stylePreset),
        direction: optionalString(input.direction, 'direction', 4000),
        denoise: boundedDenoise(input.denoise),
      });
      break;
    case 'reference_job':
      result = await runtime.referenceJob({ jobId: boundedString(input.jobId, 'jobId', 80) });
      break;
    case 'reference_jobs':
      result = await runtime.referenceJobs({ limit: boundedLimit(input.limit) });
      break;
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
    case 'media_job_cancel':
      result = await runtime.cancelMediaJob({
        kind: boundedJobKind(input.kind),
        jobId: boundedJobId(input.jobId),
      });
      break;
    default:
      throw new Error(`unknown media tool: ${String(call.tool)}`);
  }
  return boundedResult(result);
}

export const temporalMediaToolLimits = Object.freeze({
  namespace: NAMESPACE,
  maxResultBytes: MAX_RESULT_BYTES,
  referenceStylePresets: [...REFERENCE_STYLE_PRESETS],
  mediaJobKinds: [...MEDIA_JOB_KINDS],
});
