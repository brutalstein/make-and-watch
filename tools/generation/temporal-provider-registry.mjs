import { temporalShotContract } from './temporal-shot-contract.mjs';

const MAX_PROVIDERS = 8;
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const TEMPORAL_STRATEGIES = new Set(temporalShotContract.temporalStrategies);

function registryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizedStrategies(values) {
  if (!Array.isArray(values)) throw registryError('invalid_argument', 'temporal provider strategies must be an array');
  const result = [];
  const seen = new Set();
  for (const value of values) {
    const strategy = String(value ?? '').trim();
    if (!TEMPORAL_STRATEGIES.has(strategy)) {
      throw registryError('invalid_argument', `unsupported temporal provider strategy ${strategy || '<empty>'}`);
    }
    if (!seen.has(strategy)) {
      seen.add(strategy);
      result.push(strategy);
    }
  }
  if (!result.length) throw registryError('invalid_argument', 'temporal provider must support at least one strategy');
  return result;
}

function validateProvider(provider) {
  if (!provider || typeof provider !== 'object') throw registryError('invalid_argument', 'temporal provider must be an object');
  const id = String(provider.id ?? '').trim();
  if (!PROVIDER_ID.test(id)) throw registryError('invalid_argument', 'temporal provider id is invalid');
  if (typeof provider.status !== 'function') throw registryError('invalid_argument', `temporal provider ${id} is missing status()`);
  if (typeof provider.generate !== 'function') throw registryError('invalid_argument', `temporal provider ${id} is missing generate()`);
  return {
    ...provider,
    id,
    displayName: String(provider.displayName ?? id).trim().slice(0, 120) || id,
    strategies: normalizedStrategies(provider.strategies),
  };
}

function normalizeStatus(provider, value) {
  const raw = value && typeof value === 'object' ? value : {};
  return {
    id: provider.id,
    displayName: provider.displayName,
    strategies: [...provider.strategies],
    installed: Boolean(raw.installed),
    ready: Boolean(raw.ready),
    busy: Boolean(raw.busy),
    detail: String(raw.detail ?? '').slice(0, 800),
    runtime: raw.runtime && typeof raw.runtime === 'object' ? raw.runtime : null,
    hardware: raw.hardware && typeof raw.hardware === 'object' ? raw.hardware : null,
  };
}

function validateArtifact(request, artifact) {
  if (!artifact || typeof artifact !== 'object') {
    throw registryError('provider_error', 'temporal provider returned no artifact');
  }
  if (artifact.mediaType !== 'video') {
    throw registryError('provider_error', 'temporal provider must return mediaType=video');
  }
  const relativePath = String(artifact.relativePath ?? '').trim();
  if (!relativePath || relativePath.length > 2048 || relativePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(relativePath) || relativePath.includes('\0')) {
    throw registryError('provider_error', 'temporal provider returned an invalid project-relative artifact path');
  }
  const sha256 = String(artifact.sha256 ?? '').trim();
  if (!SHA256.test(sha256)) throw registryError('provider_error', 'temporal provider must return a SHA-256 content hash');
  const durationSeconds = Number(artifact.durationSeconds);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > Number(request.shot.durationSeconds) + 1) {
    throw registryError('provider_error', 'temporal provider returned an invalid duration');
  }
  const width = Math.max(0, Math.round(Number(artifact.width) || 0));
  const height = Math.max(0, Math.round(Number(artifact.height) || 0));
  return {
    mediaType: 'video',
    relativePath,
    sha256: sha256.toLowerCase(),
    mimeType: String(artifact.mimeType ?? 'video/mp4').slice(0, 160),
    durationSeconds,
    width,
    height,
    fps: Math.max(0, Number(artifact.fps) || 0),
    providerMetadata: artifact.providerMetadata && typeof artifact.providerMetadata === 'object'
      ? artifact.providerMetadata
      : {},
    tailFrame: artifact.tailFrame && typeof artifact.tailFrame === 'object' ? artifact.tailFrame : null,
  };
}

export class TemporalProviderRegistry {
  constructor() {
    this.providers = new Map();
  }

  register(provider) {
    if (this.providers.size >= MAX_PROVIDERS) throw registryError('resource_exhausted', `temporal provider registry is limited to ${MAX_PROVIDERS} providers`);
    const normalized = validateProvider(provider);
    if (this.providers.has(normalized.id)) throw registryError('invalid_argument', `temporal provider ${normalized.id} is already registered`);
    this.providers.set(normalized.id, normalized);
    return this;
  }

  ids() {
    return [...this.providers.keys()];
  }

  async statuses(context = {}) {
    const rows = [];
    for (const provider of this.providers.values()) {
      try {
        rows.push(normalizeStatus(provider, await provider.status(context)));
      } catch (error) {
        rows.push(normalizeStatus(provider, {
          installed: false,
          ready: false,
          detail: error instanceof Error ? error.message : String(error),
        }));
      }
    }
    return rows;
  }

  resolve(providerId, strategy) {
    const id = String(providerId ?? '').trim();
    if (!id) throw registryError('invalid_argument', 'temporal provider selection must be explicit');
    const provider = this.providers.get(id);
    if (!provider) throw registryError('not_found', `temporal provider ${id} is not registered`);
    if (!provider.strategies.includes(strategy)) {
      throw registryError('invalid_argument', `temporal provider ${id} does not support ${strategy}`);
    }
    return provider;
  }

  async generate(providerId, request, context = {}) {
    const strategy = request?.shot?.strategy;
    if (!TEMPORAL_STRATEGIES.has(strategy)) throw registryError('invalid_argument', 'valid temporal Shot request is required');
    const provider = this.resolve(providerId, strategy);
    const status = normalizeStatus(provider, await provider.status(context));
    if (!status.installed || !status.ready) {
      throw registryError('not_ready', status.detail || `temporal provider ${provider.id} is not ready`);
    }
    if (status.busy) throw registryError('busy', `temporal provider ${provider.id} is busy`);
    const artifact = validateArtifact(request, await provider.generate(request, context));
    return {
      provider: provider.id,
      strategy,
      artifact,
    };
  }
}

export const temporalProviderRegistryLimits = Object.freeze({
  maxProviders: MAX_PROVIDERS,
});
