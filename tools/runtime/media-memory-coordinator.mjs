const DEFAULT_COMFY_URL = process.env.MAKEWATCH_COMFYUI_URL ?? 'http://127.0.0.1:8188';

function localHttpUrl(value) {
  const url = new URL(value || DEFAULT_COMFY_URL);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error('media memory coordinator only accepts localhost ComfyUI URLs');
  }
  return url.origin;
}

/**
 * Ask a local ComfyUI instance to unload resident models before another heavy
 * GPU runtime starts. This is best-effort: an absent ComfyUI is not an error,
 * while a reachable instance gets an explicit unload/free request.
 */
export async function releaseComfyGpu({ baseUrl = DEFAULT_COMFY_URL, timeoutMs = 5_000 } = {}) {
  const origin = localHttpUrl(baseUrl);
  try {
    const response = await fetch(`${origin}/free`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      signal: AbortSignal.timeout(Math.max(500, Math.min(15_000, Number(timeoutMs) || 5_000))),
    });
    if (!response.ok) {
      return { requested: true, released: false, detail: `ComfyUI /free returned HTTP ${response.status}` };
    }
    return { requested: true, released: true, detail: 'ComfyUI model/cache release requested' };
  } catch (error) {
    return {
      requested: false,
      released: false,
      detail: `ComfyUI not reachable for model release: ${error instanceof Error ? error.message : String(error)}`.slice(0, 400),
    };
  }
}
