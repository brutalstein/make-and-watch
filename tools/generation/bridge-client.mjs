const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:4177/api';
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function localApiUrl(value) {
  const url = new URL(value || DEFAULT_BRIDGE_URL);
  if (url.protocol !== 'http:') throw new Error('generation bridge URL must use local http');
  const host = url.hostname.toLowerCase();
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error('generation bridge URL must point to localhost');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url;
}

async function boundedJson(response) {
  const length = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    throw new Error(`bridge response exceeded ${MAX_RESPONSE_BYTES} bytes`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error('bridge response exceeded bounded size');
  let payload;
  try { payload = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('bridge returned invalid JSON'); }
  if (!response.ok || payload?.ok !== true) {
    const error = new Error(payload?.error?.message ?? `bridge returned HTTP ${response.status}`);
    error.code = payload?.error?.code ?? 'bridge_error';
    throw error;
  }
  return payload.result;
}

export class GenerationBridgeClient {
  constructor({ baseUrl = process.env.MAKEWATCH_ENGINE_BRIDGE_URL ?? DEFAULT_BRIDGE_URL } = {}) {
    this.baseUrl = localApiUrl(baseUrl);
  }

  url(pathname) {
    return new URL(`${this.baseUrl.pathname}/${pathname.replace(/^\//, '')}`.replace(/\/+/g, '/'), this.baseUrl.origin);
  }

  async request(pathname, init = {}) {
    const response = await fetch(this.url(pathname), {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return boundedJson(response);
  }

  snapshot() {
    return this.request('/project');
  }

  apply(commands, context, expectedProjectRevision) {
    return this.request('/project/apply', {
      method: 'POST',
      body: JSON.stringify({ commands, context, expectedProjectRevision }),
    });
  }
}
