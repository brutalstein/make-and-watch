import { announceProjectChanged } from '../projectEvents';
import type { DirectorReferenceImportResult } from './providerTypes';

const DEFAULT_MEDIA_API = 'http://127.0.0.1:4178/api';
const MAX_REFERENCE_BYTES = 24 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 90_000;

function apiBase() {
  const url = new URL(import.meta.env.VITE_MAKEWATCH_GENERATION_URL ?? DEFAULT_MEDIA_API);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname.toLowerCase())) {
    throw new Error('Director reference media gateway must be local HTTP');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url;
}

function apiUrl(pathname: string) {
  const base = apiBase();
  return new URL(`${base.pathname}/${pathname.replace(/^\//, '')}`.replace(/\/+/g, '/'), base.origin);
}

async function parseResult<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as {
    ok?: boolean;
    result?: T;
    error?: { message?: string };
  } | null;
  if (!response.ok || payload?.ok !== true || !payload.result) {
    throw new Error(payload?.error?.message ?? `Director media gateway returned HTTP ${response.status}`);
  }
  return payload.result;
}

export const directorReferenceClient = {
  async importImage(file: File): Promise<DirectorReferenceImportResult> {
    if (!file.type.startsWith('image/')) throw new Error(`${file.name} is not an image`);
    if (file.size < 1) throw new Error(`${file.name} is empty`);
    if (file.size > MAX_REFERENCE_BYTES) throw new Error(`${file.name} exceeds the 24 MiB reference limit`);
    const response = await fetch(apiUrl('/director/references'), {
      method: 'POST',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-MakeWatch-Filename': encodeURIComponent(file.name || 'reference-image'),
      },
      body: file,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    const result = await parseResult<DirectorReferenceImportResult>(response);
    announceProjectChanged({ projectRevision: result.projectRevision, source: 'director-reference-import' });
    return result;
  },

  url(assetNodeId: string): string {
    if (!/^[A-Za-z0-9._:-]{1,180}$/.test(assetNodeId)) return '';
    return apiUrl(`/director/references/${encodeURIComponent(assetNodeId)}`).toString();
  },
};

export const directorReferenceClientLimits = Object.freeze({
  maxBytes: MAX_REFERENCE_BYTES,
  maxAttachmentsPerMessage: 8,
});
