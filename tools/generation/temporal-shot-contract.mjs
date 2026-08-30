const TEMPORAL_STRATEGIES = Object.freeze(['I2V', 'FLF2V', 'VIDEO']);
const TEMPORAL_STRATEGY_SET = new Set(TEMPORAL_STRATEGIES);

const MAX_REFERENCE_IDS_PER_ANCHOR = 8;
const MAX_REFERENCE_IDS_TOTAL = 24;
const DEFAULT_MAX_SEGMENT_SECONDS = 6;
const MAX_TEMPORAL_SHOT_SECONDS = 30;
const MAX_ENTITY_ID_CHARS = 160;

function contractError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cleanId(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > MAX_ENTITY_ID_CHARS || /[\r\n\0]/.test(text)) return '';
  return text;
}

export function parseReferenceAssetIds(value, limit = MAX_REFERENCE_IDS_PER_ANCHOR) {
  if (value === undefined || value === null || value === '') return [];
  let values;
  const text = String(value).trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    try {
      const decoded = JSON.parse(text);
      values = Array.isArray(decoded) ? decoded : [];
    } catch {
      values = [];
    }
  } else {
    values = text.split(/[\n,;]+/g);
  }
  const result = [];
  const seen = new Set();
  for (const candidate of values) {
    const id = cleanId(candidate);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    if (result.length >= Math.max(1, Math.min(MAX_REFERENCE_IDS_PER_ANCHOR, Number(limit) || 1))) break;
  }
  return result;
}

function indexSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.dependencies)) {
    throw contractError('invalid_argument', 'valid project snapshot is required');
  }
  const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const dependencies = new Map();
  const dependents = new Map();
  for (const edge of snapshot.dependencies) {
    if (!nodes.has(edge.dependent) || !nodes.has(edge.dependency)) continue;
    if (!dependencies.has(edge.dependent)) dependencies.set(edge.dependent, []);
    if (!dependents.has(edge.dependency)) dependents.set(edge.dependency, []);
    dependencies.get(edge.dependent).push(nodes.get(edge.dependency));
    dependents.get(edge.dependency).push(nodes.get(edge.dependent));
  }
  return { nodes, dependencies, dependents };
}

function uniqueNodes(nodes) {
  const seen = new Set();
  return nodes.filter((node) => {
    if (!node || seen.has(node.id)) return false;
    seen.add(node.id);
    return true;
  });
}

function dependenciesOf(index, id, kind) {
  const nodes = index.dependencies.get(id) ?? [];
  return kind ? nodes.filter((node) => node.kind === kind) : nodes;
}

function dependentsOf(index, id, kind) {
  const nodes = index.dependents.get(id) ?? [];
  return kind ? nodes.filter((node) => node.kind === kind) : nodes;
}

function assetDescriptor(asset) {
  if (!asset) return null;
  return {
    id: asset.id,
    mediaType: String(asset.metadata?.mediaType ?? ''),
    role: String(asset.metadata?.role ?? ''),
    relativePath: String(asset.metadata?.relativePath ?? ''),
    sha256: String(asset.metadata?.sha256 ?? ''),
    width: numeric(asset.metadata?.width, 0),
    height: numeric(asset.metadata?.height, 0),
    durationSeconds: numeric(asset.metadata?.durationSeconds, 0),
    revision: numeric(asset.revision, 0),
  };
}

function usableAsset(index, id, acceptedTypes = ['image']) {
  const asset = index.nodes.get(id);
  if (!asset || asset.kind !== 'asset' || asset.stale) return null;
  const mediaType = String(asset.metadata?.mediaType ?? '');
  return acceptedTypes.includes(mediaType) ? asset : null;
}

function latestReadyAsset(index, semanticId, mediaType) {
  const generations = dependentsOf(index, semanticId, 'generation')
    .filter((node) => node.metadata?.status === 'ready')
    .filter((node) => !mediaType || node.metadata?.mediaType === mediaType)
    .sort((left, right) => numeric(right.revision, 0) - numeric(left.revision, 0) || right.id.localeCompare(left.id));
  for (const generation of generations) {
    const asset = dependentsOf(index, generation.id, 'asset')
      .filter((node) => !node.stale)
      .filter((node) => !mediaType || node.metadata?.mediaType === mediaType)[0];
    if (asset) return asset;
  }
  return null;
}

function anchorReferenceAssets(index, anchor) {
  const requested = [
    ...parseReferenceAssetIds(anchor.metadata?.canonicalImageAssetIds),
    ...parseReferenceAssetIds(anchor.metadata?.acceptedReferenceAssetIds),
  ];
  for (const dependency of dependenciesOf(index, anchor.id, 'asset')) requested.push(dependency.id);

  const resolved = [];
  const seen = new Set();
  for (const id of requested) {
    if (resolved.length >= MAX_REFERENCE_IDS_PER_ANCHOR) break;
    const asset = usableAsset(index, id, ['image', 'video']);
    if (!asset || seen.has(asset.id)) continue;
    seen.add(asset.id);
    resolved.push(assetDescriptor(asset));
  }
  return resolved;
}

function resolveAnchors(index, scene, shot, kind) {
  return uniqueNodes([
    ...dependenciesOf(index, shot.id, kind),
    ...dependenciesOf(index, scene.id, kind),
  ]).map((anchor) => ({
    id: anchor.id,
    title: anchor.title,
    locked: Boolean(anchor.locked),
    stale: Boolean(anchor.stale),
    approval: anchor.approval,
    continuityPolicy: String(anchor.metadata?.continuityPolicy ?? anchor.metadata?.referencePolicy ?? 'prefer-reference'),
    references: anchorReferenceAssets(index, anchor),
  }));
}

function explicitFrameAsset(index, shot, keys) {
  for (const key of keys) {
    const id = cleanId(shot.metadata?.[key]);
    if (!id) continue;
    const asset = usableAsset(index, id, ['image']);
    if (!asset) throw contractError('invalid_argument', `Shot ${shot.id} references unusable ${key} asset ${id}`);
    return asset;
  }
  return null;
}

export function planTemporalSegments(durationSeconds, maxSegmentSeconds = DEFAULT_MAX_SEGMENT_SECONDS) {
  const duration = Number(durationSeconds);
  const maximum = Math.max(1, Math.min(10, Number(maxSegmentSeconds) || DEFAULT_MAX_SEGMENT_SECONDS));
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_TEMPORAL_SHOT_SECONDS) {
    throw contractError('invalid_argument', `temporal shot duration must be > 0 and <= ${MAX_TEMPORAL_SHOT_SECONDS}s`);
  }
  const count = Math.max(1, Math.ceil(duration / maximum));
  const segments = [];
  let cursor = 0;
  for (let index = 0; index < count; index += 1) {
    const remaining = duration - cursor;
    const segmentDuration = index === count - 1 ? remaining : Math.min(maximum, remaining);
    segments.push({
      index,
      startSeconds: Number(cursor.toFixed(6)),
      durationSeconds: Number(segmentDuration.toFixed(6)),
      inputFramePolicy: index === 0 ? 'hero-frame' : 'previous-tail-frame',
    });
    cursor += segmentDuration;
  }
  return segments;
}

export function temporalResourcePolicy({ qualityTier = 'preview', totalVramMb = 8192 } = {}) {
  const vram = Math.max(0, Number(totalVramMb) || 0);
  const reserveVramMb = vram > 0 && vram <= 10_000 ? 1536 : 2048;
  const usableVramMb = Math.max(0, vram - reserveVramMb);
  return {
    exclusiveGpu: true,
    oneTemporalJobAtATime: true,
    releaseOtherGpuModelsBeforeLaunch: true,
    reserveVramMb,
    usableVramMb,
    maxVramFraction: qualityTier === 'final' ? 0.92 : 0.86,
    preferredCpuThreads: qualityTier === 'draft' ? 2 : 4,
    preferredRamMb: qualityTier === 'final' ? 16_384 : 12_288,
    maxSegmentSeconds: qualityTier === 'draft' ? 4 : DEFAULT_MAX_SEGMENT_SECONDS,
  };
}

export function buildTemporalShotRequest(snapshot, shotId, options = {}) {
  const index = indexSnapshot(snapshot);
  const id = cleanId(shotId);
  const shot = index.nodes.get(id);
  if (!shot || shot.kind !== 'shot') throw contractError('not_found', 'shot node was not found');

  const strategy = String(shot.metadata?.generationStrategy ?? '').trim();
  if (!TEMPORAL_STRATEGY_SET.has(strategy)) {
    throw contractError(
      'invalid_argument',
      `Shot ${shot.id} must use one of ${TEMPORAL_STRATEGIES.join(', ')}; still-image output strategies were removed`,
    );
  }

  const sceneOwners = dependenciesOf(index, shot.id, 'scene');
  if (sceneOwners.length !== 1) {
    throw contractError('invalid_argument', `Shot ${shot.id} must depend on exactly one Scene`);
  }
  const scene = sceneOwners[0];
  const durationSeconds = numeric(shot.metadata?.durationSeconds, 0);
  const qualityTier = String(shot.metadata?.qualityTier ?? 'preview');
  const resourcePolicy = temporalResourcePolicy({ qualityTier, totalVramMb: options.totalVramMb ?? 8192 });

  const explicitStart = explicitFrameAsset(index, shot, ['startFrameAssetId', 'heroFrameAssetId']);
  const generatedStart = latestReadyAsset(index, shot.id, 'image');
  const startFrame = explicitStart ?? generatedStart;
  const endFrame = explicitFrameAsset(index, shot, ['endFrameAssetId']);

  const startFrameOptional = strategy === 'I2V' && options.allowMissingStartFrame === true;
  if ((strategy === 'I2V' || strategy === 'FLF2V') && !startFrame && !startFrameOptional) {
    throw contractError('not_ready', `Shot ${shot.id} needs a ready hero/start image Asset before ${strategy}`);
  }
  if (strategy === 'FLF2V' && !endFrame) {
    throw contractError('not_ready', `Shot ${shot.id} needs an endFrameAssetId before FLF2V`);
  }

  const characters = resolveAnchors(index, scene, shot, 'character');
  const locations = resolveAnchors(index, scene, shot, 'location');
  const flattenedReferences = [...characters, ...locations].flatMap((anchor) => anchor.references).slice(0, MAX_REFERENCE_IDS_TOTAL);

  return {
    schemaVersion: 2,
    projectRevision: snapshot.projectRevision,
    shot: {
      id: shot.id,
      title: shot.title,
      revision: shot.revision,
      sceneId: scene.id,
      durationSeconds,
      strategy,
      qualityTier,
      continuityPriority: String(shot.metadata?.continuityPriority ?? 'high'),
      motionLevel: String(shot.metadata?.motionLevel ?? 'low'),
      framing: String(shot.metadata?.framing ?? ''),
      camera: String(shot.metadata?.camera ?? ''),
      subjectAction: String(shot.metadata?.subjectAction ?? ''),
      temporalPrompt: String(shot.metadata?.temporalPrompt ?? shot.metadata?.subjectAction ?? ''),
      negativePrompt: String(shot.metadata?.negativePrompt ?? ''),
      seed: String(shot.metadata?.seed ?? ''),
    },
    inputs: {
      startFrame: assetDescriptor(startFrame),
      endFrame: assetDescriptor(endFrame),
      characters,
      locations,
      referenceAssets: flattenedReferences,
    },
    segments: planTemporalSegments(durationSeconds, options.maxSegmentSeconds ?? resourcePolicy.maxSegmentSeconds),
    resourcePolicy,
    providerContract: {
      mustReturnMediaType: 'video',
      mustReportDuration: true,
      mustReportContentHash: true,
      mustPreserveInputFrameIdentity: strategy !== 'VIDEO' && Boolean(startFrame),
      tailFrameHandoffRequired: durationSeconds > resourcePolicy.maxSegmentSeconds,
      stillImageFallbackAllowed: false,
    },
  };
}

export const temporalShotContract = Object.freeze({
  strategies: TEMPORAL_STRATEGIES,
  temporalStrategies: TEMPORAL_STRATEGIES,
  stillImageFallbackAllowed: false,
  maxReferenceIdsPerAnchor: MAX_REFERENCE_IDS_PER_ANCHOR,
  maxReferenceIdsTotal: MAX_REFERENCE_IDS_TOTAL,
  maxTemporalShotSeconds: MAX_TEMPORAL_SHOT_SECONDS,
  defaultMaxSegmentSeconds: DEFAULT_MAX_SEGMENT_SECONDS,
});
