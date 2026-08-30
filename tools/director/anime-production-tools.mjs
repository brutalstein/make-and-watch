const NAMESPACE = 'makewatch_anime';
const MAX_RESULT_BYTES = 512 * 1024;

const functionTool = (name, description, inputSchema, deferLoading = false) => ({
  type: 'function', name, description, inputSchema, deferLoading,
});

const shotInput = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['shotId'],
  properties: { shotId: { type: 'string', minLength: 1, maxLength: 160, pattern: '^[A-Za-z0-9._:-]+$' } },
});

export function animeProductionDynamicToolSpecs() {
  return [{
    type: 'namespace',
    name: NAMESPACE,
    description: 'Typed native-anime production operations. Inspect readiness, diagnose a graph-backed ShotAnim plan, then explicitly compile a content-addressed ShotAnim Asset before native rendering.',
    tools: [
      functionTool(
        'production_status',
        'Report connected native-anime compiler, deterministic renderer and Japanese audio readiness. Planned rig, alignment and acceptance subsystems remain explicit blockers until implemented.',
        { type: 'object', additionalProperties: false, properties: {} },
      ),
      functionTool(
        'shot_anim_plan',
        'Read and validate one Shot against its approved CharacterRig, EnvironmentPackage, Audio, Alignment, acting curves and rig domain without writing project state.',
        shotInput,
        true,
      ),
      functionTool(
        'shot_anim_compile',
        'Compile one ready Shot into a content-addressed makewatch.shotAnim/1 Asset with exact native graph revisions, input hashes and Generation provenance.',
        shotInput,
      ),
    ],
  }];
}

function objectArguments(value) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('tool arguments must be an object');
  return value;
}

function shotId(value) {
  const id = String(value ?? '').trim();
  if (!id) throw new Error('shotId is required');
  if (id.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(id)) throw new Error('shotId is invalid; use a project graph ID such as shot.1');
  return id;
}

function boundedResult(value) {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_RESULT_BYTES) {
    throw new Error(`anime tool result exceeds ${MAX_RESULT_BYTES} bytes`);
  }
  return serialized;
}

export async function handleAnimeProductionToolCall(call, runtime) {
  if (!runtime) throw new Error('anime production runtime is unavailable');
  if (!call || call.namespace !== NAMESPACE) throw new Error('unknown anime tool namespace');
  const input = objectArguments(call.arguments);
  let result;
  switch (call.tool) {
    case 'production_status':
      result = await runtime.productionStatus();
      break;
    case 'shot_anim_plan':
      result = await runtime.shotAnimPlan({ shotId: shotId(input.shotId) });
      break;
    case 'shot_anim_compile':
      result = await runtime.shotAnimCompile({ shotId: shotId(input.shotId) });
      break;
    default:
      throw new Error(`unknown anime tool: ${String(call.tool)}`);
  }
  return boundedResult(result);
}

export const animeProductionToolLimits = Object.freeze({
  namespace: NAMESPACE,
  maxResultBytes: MAX_RESULT_BYTES,
});
