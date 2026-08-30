import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8188';
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_POLL_MS = 750;
// ComfyUI serves HTTP from the same thread that loads checkpoints, so it stops
// answering while a multi-gigabyte SDXL model is read off disk. A 15s cap made
// the first generation after a checkpoint change fail as "unreachable" even
// though the server was healthy and simply busy.
const DEFAULT_REQUEST_TIMEOUT_MS = Number(process.env.MAKEWATCH_COMFYUI_REQUEST_TIMEOUT_MS ?? 120_000);
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

function boundedSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function localBaseUrl(value) {
  const url = new URL(value || DEFAULT_BASE_URL);
  if (url.protocol !== 'http:') throw new Error('ComfyUI URL must use local http');
  const host = url.hostname.toLowerCase();
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error('ComfyUI URL must point to localhost');
  }
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url;
}

async function boundedResponse(response, maximumBytes) {
  const length = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(length) && length > maximumBytes) {
    throw new Error(`ComfyUI response exceeded ${maximumBytes} bytes`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > maximumBytes) {
    throw new Error(`ComfyUI response exceeded ${maximumBytes} bytes`);
  }
  return bytes;
}

function parseJsonBytes(bytes, pathname) {
  const text = bytes.toString('utf8');
  if (!text) return null;
  try { return JSON.parse(text); } catch { throw new Error(`ComfyUI returned invalid JSON from ${pathname}`); }
}

function preferredChoice(values, preferred) {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (preferred && values.includes(preferred)) return preferred;
  return values[0];
}

function requiredChoices(info, inputName) {
  const source = info?.input?.required?.[inputName];
  if (!Array.isArray(source) || !Array.isArray(source[0])) return [];
  return source[0].filter((value) => typeof value === 'string');
}

function clampDimension(value, fallback) {
  const number = Number(value);
  const finite = Number.isFinite(number) ? Math.round(number) : fallback;
  return Math.max(256, Math.min(1536, Math.round(finite / 8) * 8));
}

function clampInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(number)));
}

function clampNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

function safeUploadName(value) {
  const cleaned = String(value ?? 'reference.png')
    .replace(/[\\/\r\n\0]+/g, '_')
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .trim()
    .slice(0, 140);
  return cleaned || `reference-${randomUUID()}.png`;
}

export function buildStoryboardWorkflow({
  checkpoint,
  prompt,
  negativePrompt,
  width = 768,
  height = 432,
  seed,
  steps = 20,
  cfg = 6.5,
  sampler = 'euler',
  scheduler = 'normal',
  filenamePrefix = 'MakeWatch/scene-preview',
}) {
  if (!checkpoint) throw new Error('ComfyUI checkpoint is required');
  const safeWidth = clampDimension(width, 768);
  const safeHeight = clampDimension(height, 432);
  const safeSeed = Number.isSafeInteger(seed) && seed >= 0 ? seed : 1;
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpoint } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: String(prompt ?? '').slice(0, 12_000), clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: String(negativePrompt ?? '').slice(0, 6_000), clip: ['1', 1] } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width: safeWidth, height: safeHeight, batch_size: 1 } },
    '5': {
      class_type: 'KSampler',
      inputs: {
        seed: safeSeed,
        steps: clampInteger(steps, 20, 1, 80),
        cfg: clampNumber(cfg, 6.5, 1, 20),
        sampler_name: sampler,
        scheduler,
        denoise: 1,
        model: ['1', 0],
        positive: ['2', 0],
        negative: ['3', 0],
        latent_image: ['4', 0],
      },
    },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { filename_prefix: filenamePrefix, images: ['6', 0] } },
  };
}

export function buildReferenceImageWorkflow({
  checkpoint,
  uploadedImage,
  prompt,
  negativePrompt,
  seed,
  steps = 24,
  cfg = 6,
  denoise = 0.58,
  sampler = 'euler',
  scheduler = 'normal',
  filenamePrefix = 'MakeWatch/reference',
}) {
  if (!checkpoint) throw new Error('ComfyUI checkpoint is required');
  if (!uploadedImage) throw new Error('ComfyUI uploaded image name is required');
  const safeSeed = Number.isSafeInteger(seed) && seed >= 0 ? seed : 1;
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpoint } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: String(prompt ?? '').slice(0, 12_000), clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: String(negativePrompt ?? '').slice(0, 6_000), clip: ['1', 1] } },
    '4': { class_type: 'LoadImage', inputs: { image: uploadedImage } },
    '5': { class_type: 'VAEEncode', inputs: { pixels: ['4', 0], vae: ['1', 2] } },
    '6': {
      class_type: 'KSampler',
      inputs: {
        seed: safeSeed,
        steps: clampInteger(steps, 24, 1, 80),
        cfg: clampNumber(cfg, 6, 1, 20),
        sampler_name: sampler,
        scheduler,
        denoise: clampNumber(denoise, 0.58, 0.05, 1),
        model: ['1', 0],
        positive: ['2', 0],
        negative: ['3', 0],
        latent_image: ['5', 0],
      },
    },
    '7': { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['1', 2] } },
    '8': { class_type: 'SaveImage', inputs: { filename_prefix: filenamePrefix, images: ['7', 0] } },
  };
}

// ComfyUI reports a failure as its whole execution message log. Dumping that
// JSON reaches the user (and the Director) as the generation job error, which
// buries the one line that says what actually broke.
function firstLine(text) {
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 400);
}

function describeComfyFailure(messages) {
  const error = messages.find(([name]) => name === 'execution_error')?.[1];
  if (!error) {
    const raw = messages.length ? `: ${JSON.stringify(messages).slice(0, 400)}` : '';
    return `ComfyUI generation failed${raw}`;
  }
  const detail = String(error.exception_message ?? error.exception_type ?? 'unknown error').trim();
  const node = error.node_type ? ` in ${error.node_type}` : '';
  if (/no kernel image is available/i.test(detail)) {
    return `ComfyUI cannot run on this GPU${node}: the ComfyUI environment's PyTorch build does not include kernels for this card. `
      + 'Reinstall PyTorch in that ComfyUI virtual environment with a CUDA build that supports it, or run ComfyUI with --cpu.';
  }
  if (/out of memory/i.test(detail)) {
    return `ComfyUI ran out of VRAM${node}. Lower MAKEWATCH_PREVIEW_WIDTH/HEIGHT or close other GPU workloads.`;
  }
  return `ComfyUI generation failed${node}: ${firstLine(detail)}`;
}

export class ComfyUiClient {
  constructor({
    baseUrl = process.env.MAKEWATCH_COMFYUI_URL ?? DEFAULT_BASE_URL,
    timeoutMs = Number(process.env.MAKEWATCH_COMFYUI_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
    pollMs = DEFAULT_POLL_MS,
    checkpoint = process.env.MAKEWATCH_COMFYUI_CHECKPOINT ?? '',
  } = {}) {
    this.baseUrl = localBaseUrl(baseUrl);
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs >= 10_000 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    this.pollMs = Number.isFinite(pollMs) && pollMs >= 100 ? pollMs : DEFAULT_POLL_MS;
    this.preferredCheckpoint = checkpoint;
    this.cachedCapabilities = null;
    this.capabilitiesCachedAt = 0;
  }

  url(pathname, search = null) {
    const url = new URL(pathname.replace(/^\//, ''), this.baseUrl);
    if (search) for (const [key, value] of Object.entries(search)) url.searchParams.set(key, String(value));
    return url;
  }

  async json(pathname, init = {}) {
    let response;
    try {
      response = await fetch(this.url(pathname), {
        ...init,
        headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
        signal: boundedSignal(init.signal, Math.min(this.timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS)),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      const reason = error instanceof Error ? error.message : String(error);
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new Error(
          `ComfyUI at ${this.baseUrl.origin} stopped responding for ${Math.round(Math.min(this.timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS) / 1000)}s. `
          + 'It is usually still loading a large checkpoint; retry once the model is resident.',
        );
      }
      throw new Error(`ComfyUI is not reachable at ${this.baseUrl.origin} (${reason}). Start the local image runtime, or wait for Make & Watch to finish preparing it.`);
    }
    const bytes = await boundedResponse(response, MAX_JSON_BYTES);
    const payload = parseJsonBytes(bytes, pathname);
    if (!response.ok) {
      const detail = payload?.error?.message ?? payload?.error ?? payload?.message ?? `HTTP ${response.status}`;
      throw new Error(`ComfyUI ${pathname} failed: ${String(detail).slice(0, 800)}`);
    }
    return payload;
  }

  async uploadImage({ bytes, filename = 'reference.png', contentType = 'image/png', signal }) {
    const payloadBytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
    if (!payloadBytes.length || payloadBytes.length > MAX_IMAGE_BYTES) throw new Error('ComfyUI reference upload is empty or exceeds the bounded image limit');
    const form = new FormData();
    form.append('image', new Blob([payloadBytes], { type: String(contentType || 'image/png') }), safeUploadName(filename));
    form.append('type', 'input');
    form.append('overwrite', 'false');
    let response;
    try {
      response = await fetch(this.url('/upload/image'), {
        method: 'POST',
        body: form,
        signal: boundedSignal(signal, 60_000),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw new Error(`ComfyUI reference upload failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const payload = parseJsonBytes(await boundedResponse(response, MAX_JSON_BYTES), '/upload/image');
    if (!response.ok || typeof payload?.name !== 'string' || !payload.name) {
      throw new Error(`ComfyUI reference upload failed with HTTP ${response.status}`);
    }
    const subfolder = typeof payload.subfolder === 'string' ? payload.subfolder.replaceAll('\\', '/') : '';
    const imageName = subfolder ? `${subfolder}/${payload.name}` : payload.name;
    return { name: payload.name, subfolder, type: payload.type ?? 'input', imageName };
  }

  async objectInfo(className, { signal } = {}) {
    const payload = await this.json(`/object_info/${encodeURIComponent(className)}`, { signal });
    return payload?.[className] ?? null;
  }

  async capabilities({ force = false, signal } = {}) {
    const now = Date.now();
    if (!force && this.cachedCapabilities && now - this.capabilitiesCachedAt < 15_000) return this.cachedCapabilities;
    await this.json('/prompt', { signal });
    const [checkpointInfo, samplerInfo] = await Promise.all([
      this.objectInfo('CheckpointLoaderSimple', { signal }),
      this.objectInfo('KSampler', { signal }),
    ]);
    const checkpoints = requiredChoices(checkpointInfo, 'ckpt_name');
    if (checkpoints.length === 0) throw new Error('ComfyUI is online but no CheckpointLoaderSimple checkpoints are installed');
    const samplers = requiredChoices(samplerInfo, 'sampler_name');
    const schedulers = requiredChoices(samplerInfo, 'scheduler');
    const checkpoint = preferredChoice(checkpoints, this.preferredCheckpoint);
    const sampler = preferredChoice(samplers, 'euler');
    const scheduler = preferredChoice(schedulers, 'normal');
    if (!checkpoint || !sampler || !scheduler) throw new Error('ComfyUI KSampler capability discovery failed');
    this.cachedCapabilities = {
      online: true,
      baseUrl: this.baseUrl.origin,
      checkpoint,
      checkpointCount: checkpoints.length,
      sampler,
      samplers,
      scheduler,
    };
    this.capabilitiesCachedAt = now;
    return this.cachedCapabilities;
  }

  async queuePrompt(prompt, promptId = randomUUID(), clientId = randomUUID(), { signal } = {}) {
    const payload = await this.json('/prompt', {
      method: 'POST',
      body: JSON.stringify({ prompt, prompt_id: promptId, client_id: clientId }),
      signal: boundedSignal(signal, 15_000),
    });
    const acceptedId = typeof payload?.prompt_id === 'string' ? payload.prompt_id : promptId;
    return { promptId: acceptedId, clientId };
  }

  async waitForHistory(promptId, { signal } = {}) {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const payload = await this.json(`/history/${encodeURIComponent(promptId)}`, { signal });
      const history = payload?.[promptId];
      if (history) {
        const status = history.status ?? {};
        if (status.status_str === 'error' || status.completed === false && status.status_str === 'error') {
          const messages = Array.isArray(status.messages) ? status.messages : [];
          throw new Error(describeComfyFailure(messages));
        }
        if (history.outputs && Object.keys(history.outputs).length > 0) return history;
        if (status.completed === true) return history;
      }
      await delay(this.pollMs, undefined, { signal });
    }
    throw new Error(`ComfyUI generation timed out after ${this.timeoutMs} ms`);
  }

  firstImage(history) {
    for (const output of Object.values(history?.outputs ?? {})) {
      if (!Array.isArray(output?.images)) continue;
      const image = output.images.find((candidate) => candidate && typeof candidate.filename === 'string');
      if (image) return { filename: image.filename, subfolder: typeof image.subfolder === 'string' ? image.subfolder : '', type: typeof image.type === 'string' ? image.type : 'output' };
    }
    throw new Error('ComfyUI completed without an image output');
  }

  async downloadImage(image, { signal } = {}) {
    const response = await fetch(this.url('/view', { filename: image.filename, subfolder: image.subfolder, type: image.type }), { signal: boundedSignal(signal, 30_000) });
    if (!response.ok) throw new Error(`ComfyUI image download failed with HTTP ${response.status}`);
    const bytes = await boundedResponse(response, MAX_IMAGE_BYTES);
    const contentType = response.headers.get('content-type') || 'image/png';
    return { bytes, contentType };
  }

  async runImageWorkflow(workflow, { signal } = {}) {
    const queued = await this.queuePrompt(workflow, undefined, undefined, { signal });
    const history = await this.waitForHistory(queued.promptId, { signal });
    const image = this.firstImage(history);
    const downloaded = await this.downloadImage(image, { signal });
    return { queued, image, downloaded };
  }

  async generateStoryboardFrame({ prompt, negativePrompt, seed, width = 768, height = 432, steps, cfg, sampler, filenamePrefix, signal }) {
    const capabilities = await this.capabilities({ signal });
    const requestedSampler = sampler && capabilities.samplers?.includes(sampler) ? sampler : capabilities.sampler;
    const workflow = buildStoryboardWorkflow({
      checkpoint: capabilities.checkpoint,
      prompt,
      negativePrompt,
      seed,
      width,
      height,
      steps,
      cfg,
      sampler: requestedSampler,
      scheduler: capabilities.scheduler,
      filenamePrefix,
    });
    const { queued, image, downloaded } = await this.runImageWorkflow(workflow, { signal });
    return {
      promptId: queued.promptId,
      checkpoint: capabilities.checkpoint,
      sampler: requestedSampler,
      scheduler: capabilities.scheduler,
      image,
      bytes: downloaded.bytes,
      contentType: downloaded.contentType,
    };
  }

  async generateReferenceImage({ sourceBytes, sourceFilename, sourceContentType, prompt, negativePrompt, seed, denoise = 0.58, steps, cfg, sampler, filenamePrefix, signal }) {
    const capabilities = await this.capabilities({ signal });
    const requestedSampler = sampler && capabilities.samplers?.includes(sampler) ? sampler : capabilities.sampler;
    const uploaded = await this.uploadImage({ bytes: sourceBytes, filename: sourceFilename, contentType: sourceContentType, signal });
    const workflow = buildReferenceImageWorkflow({
      checkpoint: capabilities.checkpoint,
      uploadedImage: uploaded.imageName,
      prompt,
      negativePrompt,
      seed,
      steps,
      cfg,
      denoise,
      sampler: requestedSampler,
      scheduler: capabilities.scheduler,
      filenamePrefix,
    });
    const { queued, image, downloaded } = await this.runImageWorkflow(workflow, { signal });
    return {
      promptId: queued.promptId,
      checkpoint: capabilities.checkpoint,
      sampler: requestedSampler,
      scheduler: capabilities.scheduler,
      denoise: clampNumber(denoise, 0.58, 0.05, 1),
      uploaded,
      image,
      bytes: downloaded.bytes,
      contentType: downloaded.contentType,
    };
  }
}
