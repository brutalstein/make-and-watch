import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';

const MAX_IMAGE_BYTES = 24 * 1024 * 1024;
const MAX_FILENAME_CHARS = 180;
const ASSET_ID_PREFIX = 'asset.reference.';

function referenceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function cleanFilename(value) {
  const compact = basename(String(value ?? 'reference-image'))
    .replace(/[\r\n\0]/g, '')
    .trim()
    .slice(0, MAX_FILENAME_CHARS);
  return compact || 'reference-image';
}

function sniffImage(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mimeType: 'image/png', extension: '.png' };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: '.jpg' };
  }
  if (bytes.length >= 12
      && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
      && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mimeType: 'image/webp', extension: '.webp' };
  }
  if (bytes.length >= 6) {
    const header = bytes.subarray(0, 6).toString('ascii');
    if (header === 'GIF87a' || header === 'GIF89a') return { mimeType: 'image/gif', extension: '.gif' };
  }
  throw referenceError('invalid_argument', 'Director references must be PNG, JPEG, WebP or GIF images');
}

function managedPath(projectRoot, relativePath) {
  const makewatchRoot = resolve(projectRoot, '.makewatch');
  const candidate = resolve(makewatchRoot, String(relativePath ?? ''));
  const rel = relative(makewatchRoot, candidate);
  if (!relativePath || rel.startsWith('..') || rel.includes('\0')) {
    throw referenceError('invalid_argument', 'Director reference path escapes the project media root');
  }
  return candidate;
}

function nodeById(snapshot, id) {
  return snapshot?.nodes?.find((node) => node.id === id) ?? null;
}

export class DirectorReferenceLibrary {
  constructor({ projectRoot, rootDirectory = null } = {}) {
    if (!projectRoot) throw new Error('DirectorReferenceLibrary requires projectRoot');
    this.projectRoot = resolve(projectRoot);
    this.rootDirectory = resolve(rootDirectory ?? join(this.projectRoot, '.makewatch', 'director-assets'));
  }

  async importImage({ bytes, filename = 'reference-image', declaredMimeType = '' }) {
    if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes ?? []);
    if (!bytes.length) throw referenceError('invalid_argument', 'Director reference image is empty');
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw referenceError('resource_exhausted', `Director reference image exceeds ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MiB`);
    }

    const detected = sniffImage(bytes);
    const declared = String(declaredMimeType ?? '').split(';')[0].trim().toLowerCase();
    if (declared && declared.startsWith('image/') && declared !== detected.mimeType
        && !(declared === 'image/jpg' && detected.mimeType === 'image/jpeg')) {
      throw referenceError('invalid_argument', `Director reference content does not match declared ${declared}`);
    }

    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const directory = join(this.rootDirectory, sha256.slice(0, 2));
    const absolutePath = join(directory, `${sha256}${detected.extension}`);
    await mkdir(directory, { recursive: true });

    const existing = await stat(absolutePath).catch(() => null);
    if (!existing) {
      const temporary = `${absolutePath}.tmp-${process.pid}-${randomUUID()}`;
      await writeFile(temporary, bytes, { flag: 'wx' });
      try {
        await rename(temporary, absolutePath);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        const raced = await stat(absolutePath).catch(() => null);
        if (!raced) throw error;
      }
    } else if (!existing.isFile() || existing.size !== bytes.length) {
      throw referenceError('integrity_error', 'Director reference content-addressed path failed integrity validation');
    }

    const makewatchRoot = resolve(this.projectRoot, '.makewatch');
    return {
      assetNodeId: `${ASSET_ID_PREFIX}${sha256.slice(0, 24)}`,
      filename: cleanFilename(filename),
      mimeType: detected.mimeType,
      byteSize: bytes.length,
      sha256,
      relativePath: relative(makewatchRoot, absolutePath).replaceAll('\\', '/'),
      absolutePath,
    };
  }

  commandsForImport(snapshot, imported) {
    const existing = nodeById(snapshot, imported.assetNodeId);
    if (existing) {
      if (existing.kind !== 'asset' || existing.metadata?.sha256 !== imported.sha256) {
        throw referenceError('integrity_error', `Director reference Asset ID collision: ${imported.assetNodeId}`);
      }
      const commands = [];
      if (existing.stale && !existing.locked) commands.push({ type: 'node.markFresh', id: existing.id, expectedRevision: existing.revision });
      return commands;
    }
    return [
      {
        type: 'node.create',
        node: {
          id: imported.assetNodeId,
          kind: 'asset',
          title: imported.filename,
          approval: 'draft',
          locked: false,
          stale: false,
          metadata: {
            mediaType: 'image',
            role: 'director-reference',
            relativePath: imported.relativePath,
            sha256: imported.sha256,
            mimeType: imported.mimeType,
            source: 'imported',
            originalFilename: imported.filename,
            byteSize: String(imported.byteSize),
            importedAt: new Date().toISOString(),
          },
        },
      },
      { type: 'node.markFresh', id: imported.assetNodeId },
    ];
  }

  async resolveAsset(snapshot, assetNodeId) {
    const asset = nodeById(snapshot, assetNodeId);
    if (!asset || asset.kind !== 'asset') throw referenceError('not_found', 'Director reference Asset was not found');
    if (asset.metadata?.mediaType !== 'image') throw referenceError('invalid_argument', 'Director reference Asset must be an image');
    const absolutePath = managedPath(this.projectRoot, asset.metadata?.relativePath);
    const metadata = await stat(absolutePath).catch(() => null);
    if (!metadata?.isFile()) throw referenceError('not_found', 'Director reference image file is missing');
    if (metadata.size > MAX_IMAGE_BYTES) throw referenceError('resource_exhausted', 'Director reference image exceeds the safe read limit');
    return {
      assetNodeId: asset.id,
      filename: String(asset.metadata?.originalFilename || asset.title || asset.id).slice(0, MAX_FILENAME_CHARS),
      mimeType: String(asset.metadata?.mimeType || 'image/png').slice(0, 80),
      byteSize: metadata.size,
      sha256: String(asset.metadata?.sha256 || ''),
      relativePath: String(asset.metadata?.relativePath || ''),
      absolutePath,
    };
  }
}

export const directorReferenceLimits = Object.freeze({
  maxImageBytes: MAX_IMAGE_BYTES,
  maxAttachmentsPerMessage: 8,
});
