import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DirectorReferenceLibrary, directorReferenceLimits } from './reference-library.mjs';

const root = await mkdtemp(join(tmpdir(), 'makewatch-director-reference-'));
try {
  const library = new DirectorReferenceLibrary({ projectRoot: root });
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(256, 7),
  ]);
  const imported = await library.importImage({
    bytes: png,
    filename: 'Mira reference.png',
    declaredMimeType: 'image/png',
  });

  assert.match(imported.assetNodeId, /^asset\.reference\.[a-f0-9]{24}$/);
  assert.equal(imported.mimeType, 'image/png');
  assert.equal(imported.byteSize, png.length);
  assert.match(imported.relativePath, /^director-assets\/[a-f0-9]{2}\/[a-f0-9]{64}\.png$/);
  assert.deepEqual(await readFile(imported.absolutePath), png);

  const commands = library.commandsForImport({ nodes: [], dependencies: [] }, imported);
  assert.equal(commands[0].type, 'node.create');
  assert.equal(commands[0].node.kind, 'asset');
  assert.equal(commands[0].node.metadata.role, 'director-reference');
  assert.equal(commands[0].node.metadata.sha256, imported.sha256);

  const deduped = await library.importImage({ bytes: png, filename: 'same.png', declaredMimeType: 'image/png' });
  assert.equal(deduped.assetNodeId, imported.assetNodeId);
  assert.equal(deduped.relativePath, imported.relativePath);

  const snapshot = {
    nodes: [{
      id: imported.assetNodeId,
      kind: 'asset',
      title: 'Existing',
      revision: 3,
      stale: true,
      locked: false,
      metadata: { sha256: imported.sha256, mediaType: 'image', relativePath: imported.relativePath },
    }],
    dependencies: [],
  };
  assert.deepEqual(library.commandsForImport(snapshot, imported), [
    { type: 'node.markFresh', id: imported.assetNodeId, expectedRevision: 3 },
  ]);

  const resolved = await library.resolveAsset(snapshot, imported.assetNodeId);
  assert.equal(resolved.absolutePath, imported.absolutePath);
  assert.equal(resolved.byteSize, png.length);

  await assert.rejects(
    library.importImage({ bytes: Buffer.from('not-an-image'), filename: 'fake.png', declaredMimeType: 'image/png' }),
    /must be PNG, JPEG, WebP or GIF/,
  );
  await assert.rejects(
    library.importImage({ bytes: png, filename: 'wrong.jpg', declaredMimeType: 'image/jpeg' }),
    /does not match declared/,
  );
  assert.equal(directorReferenceLimits.maxAttachmentsPerMessage, 8);
  assert.ok(directorReferenceLimits.maxImageBytes >= 16 * 1024 * 1024);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('director reference library check: passed');
