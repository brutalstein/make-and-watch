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

/**
 * Bridge-side client for the local media generation gateway.
 *
 * The gateway owns GPU scheduling, artifact storage and provenance write-back;
 * the bridge only needs to start jobs and read their state so that the Director
 * can drive generation through the same authoritative tool path as the UI.
 */
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

  providerStatus() {
    return this.request('/provider');
  }

  audioProviderStatus() {
    return this.request('/audio/provider');
  }

  startScene(sceneId) {
    return this.request('/scenes', { method: 'POST', body: JSON.stringify({ sceneId }) });
  }

  startAudio(audioId) {
    return this.request('/audio', { method: 'POST', body: JSON.stringify({ audioId }) });
  }

  job(jobId) {
    return this.request(`/jobs/${encodeURIComponent(jobId)}`);
  }

  jobs(limit = 20) {
    return this.request(`/jobs?limit=${encodeURIComponent(String(limit))}`);
  }

  audioJob(jobId) {
    return this.request(`/audio/jobs/${encodeURIComponent(jobId)}`);
  }

  audioJobs(limit = 20) {
    return this.request(`/audio/jobs?limit=${encodeURIComponent(String(limit))}`);
  }
}
