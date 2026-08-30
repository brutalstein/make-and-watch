const SHA256 = /^[a-f0-9]{64}$/;
const MOUTH_STATES = Object.freeze(['CLOSED', 'SMALL', 'A', 'I', 'U', 'E', 'O', 'WIDE']);
const EYE_STATES = Object.freeze(['OPEN', 'HALF', 'CLOSED']);
const GATE_STATES = new Set(['ready', 'blocked', 'running', 'passed', 'failed', 'needs_human_review']);

export const nativeAnimeAssetSchemas = Object.freeze({
  characterRig: 'makewatch.characterRig/1',
  environmentPackage: 'makewatch.environmentPackage/1',
  alignment: 'makewatch.alignment/1',
  qcReport: 'makewatch.animeQcReport/1',
  acceptanceReport: 'makewatch.animeAcceptanceReport/1',
});

function invalid(message) {
  throw Object.assign(new Error(message), { code: 'invalid_argument' });
}
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`);
  return value;
}

function text(value, label, maximum = 160) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > maximum || /[\r\n\0]/.test(normalized)) invalid(`${label} is missing or invalid`);
  return normalized;
}

function number(value, label, minimum = -Infinity, maximum = Infinity) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < minimum || normalized > maximum) {
    invalid(`${label} must be a finite number in ${minimum}..${maximum}`);
  }
  return normalized;
}

function integer(value, label, minimum, maximum) {
  const normalized = number(value, label, minimum, maximum);
  if (!Number.isInteger(normalized)) invalid(`${label} must be an integer`);
  return normalized;
}

function sha256(value, label) {
  const normalized = String(value ?? '');
  if (!SHA256.test(normalized)) invalid(`${label} must be a lowercase SHA-256`);
  return normalized;
}

function path(value, label) {
  const normalized = text(value, label, 1024).replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) invalid(`${label} must be a project-relative path`);
  if (normalized.split('/').some((segment) => !segment || segment === '..')) invalid(`${label} must not contain path traversal`);
  return normalized;
}

function stringArray(value, label, maximum = 128) {
  if (!Array.isArray(value) || value.length > maximum) invalid(`${label} must be a bounded array`);
  return value.map((entry, index) => text(entry, `${label}[${index}]`, 240));
}

function canvas(value, label) {
  const input = object(value, label);
  return {
    width: integer(input.width, `${label}.width`, 64, 8192),
    height: integer(input.height, `${label}.height`, 64, 8192),
  };
}

function pair(value, label, minimum, maximum) {
  if (!Array.isArray(value) || value.length !== 2) invalid(`${label} must contain two numbers`);
  return [number(value[0], `${label}[0]`, minimum, maximum), number(value[1], `${label}[1]`, minimum, maximum)];
}

function unique(values, label) {
  if (new Set(values).size !== values.length) invalid(`${label} IDs must be unique`);
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function schema(value, name, label) {
  const input = object(value, label);
  if (input.schema !== name) invalid(`${label}.schema must be ${name}`);
  return input;
}

export function validateCharacterRig(value) {
  const input = schema(value, nativeAnimeAssetSchemas.characterRig, 'CharacterRig');
  if (!Array.isArray(input.states) || input.states.length < 1 || input.states.length > 128) {
    invalid('CharacterRig must contain 1..128 semantic states');
  }
  const states = input.states.map((raw, index) => {
    const state = object(raw, `CharacterRig.states[${index}]`);
    return {
      id: text(state.id, `CharacterRig.states[${index}].id`, 100),
      semanticPart: text(state.semanticPart, `CharacterRig.states[${index}].semanticPart`, 80),
      imageAssetId: text(state.imageAssetId, `CharacterRig.states[${index}].imageAssetId`),
      imageSha256: sha256(state.imageSha256, `CharacterRig.states[${index}].imageSha256`),
      path: path(state.path, `CharacterRig.states[${index}].path`),
      pivot: pair(state.pivot ?? [0.5, 0.5], `CharacterRig.states[${index}].pivot`, 0, 1),
      z: number(state.z ?? index, `CharacterRig.states[${index}].z`, -10000, 10000),
      attachTo: state.attachTo === undefined || state.attachTo === null ? null : text(state.attachTo, `CharacterRig.states[${index}].attachTo`, 100),
    };
  });
  unique(states.map(({ id }) => id), 'CharacterRig semantic state');
  const stateIds = new Set(states.map(({ id }) => id));
  const parts = new Set(states.map(({ semanticPart }) => semanticPart));
  if (!parts.has('body') && !parts.has('torso')) invalid('CharacterRig requires body or torso semantic state');
  if (!parts.has('face_base')) invalid('CharacterRig requires face_base semantic state');
  for (const side of ['eyes_l', 'eyes_r']) {
    for (const eyeState of EYE_STATES) {
      if (!stateIds.has(`${side}.${eyeState}`)) invalid(`CharacterRig requires ${side}.${eyeState}`);
    }
  }
  for (const mouthState of MOUTH_STATES) {
    if (!stateIds.has(`mouth.${mouthState}`)) invalid(`CharacterRig requires mouth.${mouthState}`);
  }
  if (!parts.has('front_hair')) invalid('CharacterRig requires front_hair semantic state');
  if (!parts.has('rear_hair') && !parts.has('hair')) invalid('CharacterRig requires rear_hair or documented single hair semantic state');

  const domainInput = object(input.validDomain ?? {}, 'CharacterRig.validDomain');
  const validDomain = {};
  for (const [key, range] of Object.entries(domainInput)) {
    if (key === 'combined') continue;
    const normalized = pair(range, `CharacterRig.validDomain.${key}`, -10000, 10000);
    if (normalized[1] < normalized[0]) invalid(`CharacterRig.validDomain.${key} must be ordered`);
    validDomain[text(key, 'CharacterRig valid-domain key', 80)] = normalized;
  }

  return freeze({
    schema: nativeAnimeAssetSchemas.characterRig,
    characterId: text(input.characterId, 'CharacterRig.characterId'),
    characterRevision: integer(input.characterRevision, 'CharacterRig.characterRevision', 0, Number.MAX_SAFE_INTEGER),
    outfitState: text(input.outfitState, 'CharacterRig.outfitState', 100),
    paletteFingerprint: sha256(input.paletteFingerprint, 'CharacterRig.paletteFingerprint'),
    canvas: canvas(input.canvas, 'CharacterRig.canvas'),
    states,
    validDomain,
  });
}

export function validateEnvironmentPackage(value) {
  const input = schema(value, nativeAnimeAssetSchemas.environmentPackage, 'EnvironmentPackage');
  if (!Array.isArray(input.plates) || input.plates.length < 3 || input.plates.length > 16) {
    invalid('EnvironmentPackage requires background, midground and foreground plates');
  }
  const plates = input.plates.map((raw, index) => {
    const plate = object(raw, `EnvironmentPackage.plates[${index}]`);
    return {
      id: text(plate.id, `EnvironmentPackage.plates[${index}].id`, 100),
      role: text(plate.role, `EnvironmentPackage.plates[${index}].role`, 80),
      imageAssetId: text(plate.imageAssetId, `EnvironmentPackage.plates[${index}].imageAssetId`),
      imageSha256: sha256(plate.imageSha256, `EnvironmentPackage.plates[${index}].imageSha256`),
      path: path(plate.path, `EnvironmentPackage.plates[${index}].path`),
      depth: number(plate.depth, `EnvironmentPackage.plates[${index}].depth`, 0, 1),
    };
  });
  unique(plates.map(({ id }) => id), 'EnvironmentPackage plate');
  const roles = new Set(plates.map(({ role }) => role));
  if (!['background', 'midground', 'foreground'].every((role) => roles.has(role))) {
    invalid('EnvironmentPackage requires background, midground and foreground plate roles');
  }
  return freeze({
    schema: nativeAnimeAssetSchemas.environmentPackage,
    locationId: text(input.locationId, 'EnvironmentPackage.locationId'),
    locationRevision: integer(input.locationRevision, 'EnvironmentPackage.locationRevision', 0, Number.MAX_SAFE_INTEGER),
    canvas: canvas(input.canvas, 'EnvironmentPackage.canvas'),
    plates,
    occlusionMaskAssetId: text(input.occlusionMaskAssetId, 'EnvironmentPackage.occlusionMaskAssetId'),
    occlusionMaskSha256: sha256(input.occlusionMaskSha256, 'EnvironmentPackage.occlusionMaskSha256'),
    cameraSafeRegion: {
      x: pair(object(input.cameraSafeRegion, 'EnvironmentPackage.cameraSafeRegion').x, 'EnvironmentPackage.cameraSafeRegion.x', 0, 1),
      y: pair(input.cameraSafeRegion.y, 'EnvironmentPackage.cameraSafeRegion.y', 0, 1),
    },
    lightingStates: stringArray(input.lightingStates ?? [], 'EnvironmentPackage.lightingStates', 32),
    weatherStates: stringArray(input.weatherStates ?? [], 'EnvironmentPackage.weatherStates', 32),
  });
}

export function validateAlignmentAsset(value) {
  const input = schema(value, nativeAnimeAssetSchemas.alignment, 'Alignment');
  const sampleRate = integer(input.sampleRate, 'Alignment.sampleRate', 8000, 384000);
  const speechStartSample = integer(input.speechStartSample, 'Alignment.speechStartSample', 0, Number.MAX_SAFE_INTEGER);
  const speechEndSample = integer(input.speechEndSample, 'Alignment.speechEndSample', 1, Number.MAX_SAFE_INTEGER);
  if (speechEndSample <= speechStartSample) invalid('Alignment speech bounds must be positive and ordered');
  if (!Array.isArray(input.tokens) || input.tokens.length < 1 || input.tokens.length > 4096) invalid('Alignment.tokens must be a non-empty bounded array');
  let priorEnd = speechStartSample;
  const tokens = input.tokens.map((raw, index) => {
    const token = object(raw, `Alignment.tokens[${index}]`);
    const startSample = integer(token.startSample, `Alignment.tokens[${index}].startSample`, speechStartSample, speechEndSample);
    const endSample = integer(token.endSample, `Alignment.tokens[${index}].endSample`, speechStartSample, speechEndSample);
    if (startSample < priorEnd || endSample <= startSample) invalid('Alignment tokens must be sorted with positive timing');
    priorEnd = endSample;
    return {
      text: text(token.text, `Alignment.tokens[${index}].text`, 120),
      readingKana: text(token.readingKana, `Alignment.tokens[${index}].readingKana`, 160),
      startSample,
      endSample,
      confidence: number(token.confidence, `Alignment.tokens[${index}].confidence`, 0, 1),
    };
  });
  const provider = object(input.provider, 'Alignment.provider');
  return freeze({
    schema: nativeAnimeAssetSchemas.alignment,
    dialogueUnitId: text(input.dialogueUnitId, 'Alignment.dialogueUnitId'),
    language: text(input.language, 'Alignment.language', 16),
    transcript: text(input.transcript, 'Alignment.transcript', 12000),
    audioAssetId: text(input.audioAssetId, 'Alignment.audioAssetId'),
    audioSha256: sha256(input.audioSha256, 'Alignment.audioSha256'),
    provider: { id: text(provider.id, 'Alignment.provider.id', 100), version: text(provider.version, 'Alignment.provider.version', 100) },
    normalization: text(input.normalization, 'Alignment.normalization', 100),
    sampleRate,
    speechStartSample,
    speechEndSample,
    confidence: number(input.confidence, 'Alignment.confidence', 0, 1),
    warnings: stringArray(input.warnings ?? [], 'Alignment.warnings', 128),
    tokens,
  });
}

export function validateAnimeQcReport(value) {
  const input = schema(value, nativeAnimeAssetSchemas.qcReport, 'AnimeQcReport');
  const failures = stringArray(input.failures ?? [], 'AnimeQcReport.failures', 256);
  const passed = Boolean(input.passed);
  if (passed && failures.length) invalid('A passing AnimeQcReport cannot contain failures');
  const thresholds = object(input.thresholds ?? {}, 'AnimeQcReport.thresholds');
  const normalizedThresholds = Object.fromEntries(Object.entries(thresholds).map(([key, entry]) => [text(key, 'AnimeQcReport threshold key', 100), number(entry, `AnimeQcReport.thresholds.${key}`)]));
  if (!Array.isArray(input.checks) || input.checks.length < 1 || input.checks.length > 256) invalid('AnimeQcReport.checks must be a non-empty bounded array');
  const checks = input.checks.map((raw, index) => {
    const check = object(raw, `AnimeQcReport.checks[${index}]`);
    return { id: text(check.id, `AnimeQcReport.checks[${index}].id`, 100), passed: Boolean(check.passed), value: number(check.value, `AnimeQcReport.checks[${index}].value`) };
  });
  const sampledFrames = (input.sampledFrames ?? []).map((raw, index) => {
    const frame = object(raw, `AnimeQcReport.sampledFrames[${index}]`);
    return { frame: integer(frame.frame, `AnimeQcReport.sampledFrames[${index}].frame`, 0, Number.MAX_SAFE_INTEGER), sha256: sha256(frame.sha256, `AnimeQcReport.sampledFrames[${index}].sha256`) };
  });
  if (sampledFrames.length > 256) invalid('AnimeQcReport.sampledFrames exceeds the limit');
  return freeze({ schema: nativeAnimeAssetSchemas.qcReport, shotId: text(input.shotId, 'AnimeQcReport.shotId'), videoAssetId: text(input.videoAssetId, 'AnimeQcReport.videoAssetId'), passed, promoted: Boolean(input.promoted), thresholds: normalizedThresholds, checks, sampledFrames, failures });
}

export function validateAnimeAcceptanceReport(value) {
  const input = schema(value, nativeAnimeAssetSchemas.acceptanceReport, 'AnimeAcceptanceReport');
  if (!Array.isArray(input.gates) || input.gates.length < 1 || input.gates.length > 128) invalid('AnimeAcceptanceReport.gates must be a non-empty bounded array');
  const gates = input.gates.map((raw, index) => {
    const gate = object(raw, `AnimeAcceptanceReport.gates[${index}]`);
    const state = text(gate.state, `AnimeAcceptanceReport.gates[${index}].state`, 40);
    if (!GATE_STATES.has(state)) invalid(`AnimeAcceptanceReport.gates[${index}].state is unknown`);
    return { id: text(gate.id, `AnimeAcceptanceReport.gates[${index}].id`, 100), state };
  });
  const passed = Boolean(input.passed);
  if (passed && gates.some(({ state }) => state !== 'passed')) invalid('AnimeAcceptanceReport passed requires every gate to pass');
  const runtime = object(input.runtime, 'AnimeAcceptanceReport.runtime');
  const storage = object(input.storage, 'AnimeAcceptanceReport.storage');
  return freeze({
    schema: nativeAnimeAssetSchemas.acceptanceReport,
    episodeId: text(input.episodeId, 'AnimeAcceptanceReport.episodeId'),
    finalAssetId: text(input.finalAssetId, 'AnimeAcceptanceReport.finalAssetId'),
    finalSha256: sha256(input.finalSha256, 'AnimeAcceptanceReport.finalSha256'),
    passed,
    gates,
    jobs: stringArray(input.jobs ?? [], 'AnimeAcceptanceReport.jobs', 2048),
    artifacts: stringArray(input.artifacts ?? [], 'AnimeAcceptanceReport.artifacts', 2048),
    runtime: { wallSeconds: number(runtime.wallSeconds, 'AnimeAcceptanceReport.runtime.wallSeconds', 0) },
    storage: {
      persistentBytes: integer(storage.persistentBytes, 'AnimeAcceptanceReport.storage.persistentBytes', 0, Number.MAX_SAFE_INTEGER),
      scratchBytesAfter: integer(storage.scratchBytesAfter, 'AnimeAcceptanceReport.storage.scratchBytesAfter', 0, Number.MAX_SAFE_INTEGER),
    },
    defects: stringArray(input.defects ?? [], 'AnimeAcceptanceReport.defects', 512),
  });
}
