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

const GRAPH_ID = '^[A-Za-z0-9._:-]+$';
const idProp = (maxLength = 180) => ({ type: 'string', minLength: 1, maxLength, pattern: GRAPH_ID });
const revisionProp = Object.freeze({ type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const numberPair = Object.freeze({ type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 });

const characterRigPlanInput = Object.freeze({
  type: 'object', additionalProperties: false, required: ['characterId'],
  properties: { characterId: idProp(), outfitState: { type: 'string', maxLength: 100 } },
});
const characterRigBuildInput = Object.freeze({
  type: 'object', additionalProperties: false,
  required: ['characterId', 'expectedRevision', 'outfitState', 'states'],
  properties: {
    characterId: idProp(),
    expectedRevision: revisionProp,
    outfitState: { type: 'string', minLength: 1, maxLength: 100 },
    states: {
      type: 'array', minItems: 1, maxItems: 128,
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'sourceAssetId'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 100 },
          sourceAssetId: idProp(),
          pivot: numberPair,
          z: { type: 'number' },
          attachTo: { type: 'string', maxLength: 100 },
        },
      },
    },
    validDomains: { type: 'object', additionalProperties: numberPair },
    canvas: {
      type: 'object', additionalProperties: false,
      properties: { width: { type: 'integer' }, height: { type: 'integer' } },
    },
  },
});
const characterRigValidateInput = Object.freeze({
  type: 'object', additionalProperties: false,
  required: ['rigAssetId', 'expectedCharacterRevision'],
  properties: { rigAssetId: idProp(), expectedCharacterRevision: revisionProp, promote: { type: 'boolean' } },
});
const locationPackagePlanInput = Object.freeze({
  type: 'object', additionalProperties: false, required: ['locationId'],
  properties: { locationId: idProp(), stateId: { type: 'string', maxLength: 100 } },
});
const locationPackageBuildInput = Object.freeze({
  type: 'object', additionalProperties: false,
  required: ['locationId', 'expectedRevision', 'stateId', 'plates', 'occlusionMaskAssetId', 'cameraSafeBounds'],
  properties: {
    locationId: idProp(),
    expectedRevision: revisionProp,
    stateId: { type: 'string', minLength: 1, maxLength: 100 },
    plates: {
      type: 'array', minItems: 3, maxItems: 16,
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'role', 'sourceAssetId', 'depth'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 100 },
          role: { type: 'string', maxLength: 80 },
          sourceAssetId: idProp(),
          depth: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
    occlusionMaskAssetId: idProp(),
    cameraSafeBounds: {
      type: 'object', additionalProperties: false, required: ['x', 'y'],
      properties: { x: numberPair, y: numberPair },
    },
    lightingStates: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 100 } },
    weatherStates: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 100 } },
  },
});
const locationPackageValidateInput = Object.freeze({
  type: 'object', additionalProperties: false,
  required: ['packageAssetId', 'expectedLocationRevision'],
  properties: { packageAssetId: idProp(), expectedLocationRevision: revisionProp, promote: { type: 'boolean' } },
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
      functionTool(
        'character_rig_plan',
        'Read a Character and report the required semantic rig states, which are already covered by approved source Assets, which are missing, and any reusable CharacterRig. Writes no project state.',
        characterRigPlanInput,
        true,
      ),
      functionTool(
        'character_rig_build',
        'Assemble approved semantic state Assets into a draft content-addressed makewatch.characterRig/1 Asset for one Character revision and outfit. Draft only; never establishes continuity.',
        characterRigBuildInput,
        true,
      ),
      functionTool(
        'character_rig_validate',
        'Run the deterministic seam/registration/palette QC worker on a draft CharacterRig, persist its report and contact sheet, and — only with promote:true and a matching expectedCharacterRevision — approve it and link it to the Character.',
        characterRigValidateInput,
        true,
      ),
      functionTool(
        'location_package_plan',
        'Read a Location and report the required depth plate roles, covered/missing source Assets and any reusable EnvironmentPackage. Writes no project state.',
        locationPackagePlanInput,
        true,
      ),
      functionTool(
        'location_package_build',
        'Assemble approved depth plate Assets plus an occlusion mask into a draft content-addressed makewatch.environmentPackage/1 Asset for one Location revision and lighting/weather state. Draft only.',
        locationPackageBuildInput,
        true,
      ),
      functionTool(
        'location_package_validate',
        'Run the deterministic registration/depth/parallax QC worker on a draft EnvironmentPackage, persist its report and contact sheet, and — only with promote:true and a matching expectedLocationRevision — approve it and link it to the Location.',
        locationPackageValidateInput,
        true,
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

function graphId(value, label) {
  const id = String(value ?? '').trim();
  if (!id) throw new Error(`${label} is required`);
  if (id.length > 180 || !/^[A-Za-z0-9._:-]+$/.test(id)) throw new Error(`${label} is invalid; use a project graph ID`);
  return id;
}

function revisionNumber(value, label) {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error(`${label} must be a non-negative integer`);
  return revision;
}

function requiredText(value, label, maximum) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label} is required`);
  if (text.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
  return text;
}

function boundedArray(value, label, minItems, maxItems) {
  if (!Array.isArray(value) || value.length < minItems || value.length > maxItems) {
    throw new Error(`${label} must contain ${minItems}..${maxItems} entries`);
  }
  return value;
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
    case 'character_rig_plan':
      result = await runtime.characterRigPlan({
        characterId: graphId(input.characterId, 'characterId'),
        outfitState: input.outfitState === undefined || input.outfitState === null || input.outfitState === ''
          ? undefined
          : requiredText(input.outfitState, 'outfitState', 100),
      });
      break;
    case 'character_rig_build':
      result = await runtime.characterRigBuild({
        characterId: graphId(input.characterId, 'characterId'),
        expectedRevision: revisionNumber(input.expectedRevision, 'expectedRevision'),
        outfitState: requiredText(input.outfitState, 'outfitState', 100),
        states: boundedArray(input.states, 'states', 1, 128),
        validDomains: input.validDomains ?? input.validDomain ?? {},
        ...(input.canvas === undefined || input.canvas === null ? {} : { canvas: input.canvas }),
      });
      break;
    case 'character_rig_validate':
      result = await runtime.characterRigValidate({
        rigAssetId: graphId(input.rigAssetId, 'rigAssetId'),
        expectedCharacterRevision: revisionNumber(input.expectedCharacterRevision, 'expectedCharacterRevision'),
        promote: input.promote === true,
      });
      break;
    case 'location_package_plan':
      result = await runtime.locationPackagePlan({
        locationId: graphId(input.locationId, 'locationId'),
        stateId: input.stateId === undefined || input.stateId === null || input.stateId === ''
          ? undefined
          : requiredText(input.stateId, 'stateId', 100),
      });
      break;
    case 'location_package_build':
      result = await runtime.locationPackageBuild({
        locationId: graphId(input.locationId, 'locationId'),
        expectedRevision: revisionNumber(input.expectedRevision, 'expectedRevision'),
        stateId: requiredText(input.stateId, 'stateId', 100),
        plates: boundedArray(input.plates, 'plates', 3, 16),
        occlusionMaskAssetId: graphId(input.occlusionMaskAssetId, 'occlusionMaskAssetId'),
        cameraSafeBounds: input.cameraSafeBounds ?? input.cameraSafeRegion ?? null,
        lightingStates: Array.isArray(input.lightingStates) ? input.lightingStates : [],
        weatherStates: Array.isArray(input.weatherStates) ? input.weatherStates : [],
      });
      break;
    case 'location_package_validate':
      result = await runtime.locationPackageValidate({
        packageAssetId: graphId(input.packageAssetId, 'packageAssetId'),
        expectedLocationRevision: revisionNumber(input.expectedLocationRevision, 'expectedLocationRevision'),
        promote: input.promote === true,
      });
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
