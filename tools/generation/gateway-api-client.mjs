const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:4178/api';
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function localApiUrl(value) {
  const url = new URL(value || DEFAULT_GATEWAY_URL);
  if (url.protocol !== 'http:') throw new Error('generation gateway URL must use local http');
  const host = url.hostname.toLowerCase();
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error('generation gateway URL must point to localhost');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url;
}

function gatewayError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export class GenerationGatewayClient {
  constructor({ baseUrl = process.env.MAKEWATCH_GENERATION_GATEWAY_URL ?? DEFAULT_GATEWAY_URL } = {}) {
    this.baseUrl = localApiUrl(baseUrl);
  }

  url(pathname) {
    return new URL(
      `${this.baseUrl.pathname}/${pathname.replace(/^\//, '')}`.replace(/\/+/g, '/'),
      this.baseUrl.origin,
    );
  }

  async request(pathname, init = {}) {
    let response;
    try {
      response = await fetch(this.url(pathname), {
        ...init,
        headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
        signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw gatewayError(
        'gateway_unavailable',
        `local media generation gateway is unreachable at ${this.baseUrl.origin}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_RESPONSE_BYTES) throw gatewayError('gateway_error', 'generation gateway response exceeded bounded size');
    let payload;
    try { payload = JSON.parse(bytes.toString('utf8')); } catch { throw gatewayError('gateway_error', 'generation gateway returned invalid JSON'); }
    if (!response.ok || payload?.ok !== true) {
      throw gatewayError(
        payload?.error?.code ?? 'gateway_error',
        payload?.error?.message ?? `generation gateway returned HTTP ${response.status}`,
      );
    }
    return payload.result;
  }

  providerStatus() { return this.request('/provider'); }
  referenceProviderStatus() { return this.request('/reference/provider'); }
  audioProviderStatus() { return this.request('/audio/provider'); }
  temporalProviders() { return this.request('/temporal/providers'); }
  animeProductionStatus() { return this.request('/anime/status'); }

  startReferenceGeneration({ targetId, sourceAssetId = null, stylePreset = '', direction = '', denoise } = {}) {
    return this.request('/reference/generate', {
      method: 'POST',
      body: JSON.stringify({ targetId, sourceAssetId, stylePreset, direction, denoise }),
    });
  }

  referenceJob(jobId) { return this.request(`/reference/jobs/${encodeURIComponent(jobId)}`); }
  referenceJobs(limit = 20) { return this.request(`/reference/jobs?limit=${encodeURIComponent(String(limit))}`); }

  temporalShotPlan(shotId, { totalVramMb, maxSegmentSeconds } = {}) {
    const query = new URLSearchParams();
    if (Number.isFinite(Number(totalVramMb))) query.set('vramMb', String(Number(totalVramMb)));
    if (Number.isFinite(Number(maxSegmentSeconds))) query.set('maxSegmentSeconds', String(Number(maxSegmentSeconds)));
    const suffix = query.size ? `?${query.toString()}` : '';
    return this.request(`/temporal/shots/${encodeURIComponent(shotId)}/plan${suffix}`);
  }

  startTemporalShot(shotId, providerId) {
    return this.request('/temporal/shots', {
      method: 'POST',
      body: JSON.stringify({ shotId, providerId }),
    });
  }

  temporalJob(jobId) { return this.request(`/temporal/jobs/${encodeURIComponent(jobId)}`); }
  temporalJobs(limit = 20) { return this.request(`/temporal/jobs?limit=${encodeURIComponent(String(limit))}`); }
  cancelMediaJob(kind, jobId) {
    return this.request(`/jobs/${encodeURIComponent(kind)}/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
  }

  shotAnimPlan(shotId) { return this.request(`/anime/shots/${encodeURIComponent(shotId)}/plan`); }
  shotAnimCompile(shotId) {
    return this.request(`/anime/shots/${encodeURIComponent(shotId)}/compile`, { method: 'POST' });
  }

  characterRigPlan({ characterId, outfitState } = {}) {
    const suffix = outfitState ? `?outfitState=${encodeURIComponent(outfitState)}` : '';
    return this.request(`/anime/characters/${encodeURIComponent(characterId)}/rig-plan${suffix}`);
  }
  characterRigBuild(body = {}) {
    return this.request('/anime/character-rigs', { method: 'POST', body: JSON.stringify(body) });
  }
  characterRigValidate({ rigAssetId, expectedCharacterRevision, promote } = {}) {
    return this.request(`/anime/character-rigs/${encodeURIComponent(rigAssetId)}/validate`, {
      method: 'POST',
      body: JSON.stringify({ expectedCharacterRevision, promote: promote === true }),
    });
  }
  locationPackagePlan({ locationId, stateId } = {}) {
    const suffix = stateId ? `?stateId=${encodeURIComponent(stateId)}` : '';
    return this.request(`/anime/locations/${encodeURIComponent(locationId)}/package-plan${suffix}`);
  }
  locationPackageBuild(body = {}) {
    return this.request('/anime/environment-packages', { method: 'POST', body: JSON.stringify(body) });
  }
  locationPackageValidate({ packageAssetId, expectedLocationRevision, promote } = {}) {
    return this.request(`/anime/environment-packages/${encodeURIComponent(packageAssetId)}/validate`, {
      method: 'POST',
      body: JSON.stringify({ expectedLocationRevision, promote: promote === true }),
    });
  }

  startScene(sceneId) { return this.request('/scenes', { method: 'POST', body: JSON.stringify({ sceneId }) }); }
  startAudio(audioId) { return this.request('/audio', { method: 'POST', body: JSON.stringify({ audioId }) }); }
  job(jobId) { return this.request(`/jobs/${encodeURIComponent(jobId)}`); }
  jobs(limit = 20) { return this.request(`/jobs?limit=${encodeURIComponent(String(limit))}`); }
  audioJob(jobId) { return this.request(`/audio/jobs/${encodeURIComponent(jobId)}`); }
  audioJobs(limit = 20) { return this.request(`/audio/jobs?limit=${encodeURIComponent(String(limit))}`); }
  episodeComposition(episodeId) { return this.request(`/composition/episodes/${encodeURIComponent(episodeId)}`); }
  startEpisodeRender(episodeId) { return this.request(`/render/episodes/${encodeURIComponent(episodeId)}`, { method: 'POST' }); }
  renderJob(jobId) { return this.request(`/render/jobs/${encodeURIComponent(jobId)}`); }
  renderJobs(limit = 20) { return this.request(`/render/jobs?limit=${encodeURIComponent(String(limit))}`); }
}

export const generationGatewayClientLimits = Object.freeze({
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  maxResponseBytes: MAX_RESPONSE_BYTES,
});
