import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AnchorReferenceGenerationService } from './anchor-reference-generation-service.mjs';

async function waitForJob(service, id) {
  for (let i = 0; i < 80; i += 1) {
    const job = service.get(id);
    if (job.status === 'completed' || job.status === 'failed') return job;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  return service.get(id);
}

const root = await mkdtemp(join(tmpdir(), 'makewatch-anchor-reference-'));
try {
  await mkdir(join(root, '.makewatch', 'director-assets', 'aa'), { recursive: true });
  const sourcePath = join(root, '.makewatch', 'director-assets', 'aa', 'source.png');
  await writeFile(sourcePath, Buffer.alloc(2048, 3));

  let snapshot = {
    schemaVersion: 1,
    projectRevision: 1,
    nodes: [
      { id: 'series.demo', kind: 'series', title: 'Demo', revision: 1, locked: false, stale: false, approval: 'draft', metadata: { stylePreset: 'anime-cinematic', visualLanguage: 'soft evening color script', masterSeed: '1337' } },
      { id: 'character.mira', kind: 'character', title: 'Mira', revision: 2, locked: false, stale: false, approval: 'draft', metadata: { appearancePrompt: 'young adult woman, black bob haircut, calm eyes', wardrobe: 'navy coat' } },
      { id: 'asset.reference.source', kind: 'asset', title: 'Mira source', revision: 1, locked: false, stale: false, approval: 'draft', metadata: { mediaType: 'image', role: 'director-reference', relativePath: 'director-assets/aa/source.png', sha256: 'a'.repeat(64), mimeType: 'image/png' } },
    ],
    dependencies: [
      { dependent: 'character.mira', dependency: 'series.demo' },
      { dependent: 'character.mira', dependency: 'asset.reference.source' },
    ],
  };
  const applies = [];
  const bridge = {
    snapshot: async () => structuredClone(snapshot),
    apply: async (commands, context, expectedProjectRevision) => {
      assert.equal(expectedProjectRevision, snapshot.projectRevision);
      applies.push({ commands: structuredClone(commands), context });
      for (const command of commands) {
        if (command.type === 'node.create') snapshot.nodes.push({ ...command.node, revision: 1 });
        if (command.type === 'node.patch') {
          const target = snapshot.nodes.find((node) => node.id === command.id);
          Object.assign(target.metadata, command.metadataUpdates);
          target.revision += 1;
        }
        if (command.type === 'node.markFresh') {
          const target = snapshot.nodes.find((node) => node.id === command.id);
          if (target) target.stale = false;
        }
        if (command.type === 'dependency.add' && !snapshot.dependencies.some((edge) => edge.dependent === command.dependent && edge.dependency === command.dependency)) {
          snapshot.dependencies.push({ dependent: command.dependent, dependency: command.dependency });
        }
      }
      snapshot.projectRevision += 1;
      return { projectRevision: snapshot.projectRevision, snapshot: structuredClone(snapshot) };
    },
  };
  const scheduler = { run: async (_lease, operation) => operation() };
  const comfyCalls = [];
  const comfy = {
    capabilities: async () => ({ checkpoint: 'anime.safetensors' }),
    generateReferenceImage: async (input) => {
      comfyCalls.push(['img2img', input]);
      assert.equal((await readFile(sourcePath)).length, input.sourceBytes.length);
      return {
        bytes: Buffer.alloc(4096, 9), contentType: 'image/png', promptId: 'prompt-1', checkpoint: 'anime.safetensors', sampler: 'euler', scheduler: 'normal',
      };
    },
    generateStoryboardFrame: async (input) => {
      comfyCalls.push(['t2i', input]);
      return {
        bytes: Buffer.alloc(4096, 8), contentType: 'image/png', promptId: 'prompt-2', checkpoint: 'anime.safetensors', sampler: 'euler', scheduler: 'normal',
      };
    },
  };

  const service = new AnchorReferenceGenerationService({ bridge, comfy, scheduler, projectRoot: root });
  const started = await service.start({
    targetId: 'character.mira',
    sourceAssetId: 'asset.reference.source',
    stylePreset: 'anime-cinematic',
    direction: 'keep her calm expression and make it a premium anime key visual',
    denoise: 0.6,
  });
  assert.ok(['queued', 'running'].includes(started.status));
  const job = await waitForJob(service, started.id);
  assert.equal(job.status, 'completed', job.error);
  assert.equal(comfyCalls[0][0], 'img2img');
  assert.match(comfyCalls[0][1].prompt, /anime/i);
  assert.match(comfyCalls[0][1].prompt, /Mira/);
  assert.equal(job.artifact.sourceAssetId, 'asset.reference.source');
  assert.equal(job.artifact.sha256.length, 64);

  const outputAsset = snapshot.nodes.find((node) => node.id === job.artifact.assetNodeId);
  assert.equal(outputAsset.kind, 'asset');
  assert.equal(outputAsset.metadata.role, 'character-reference');
  const generation = snapshot.nodes.find((node) => node.id === job.artifact.generationNodeId);
  assert.equal(generation.kind, 'generation');
  assert.equal(generation.metadata.strategy, 'IMG2IMG_REFERENCE');
  assert.ok(snapshot.dependencies.some((edge) => edge.dependent === generation.id && edge.dependency === 'asset.reference.source'));
  assert.ok(snapshot.dependencies.some((edge) => edge.dependent === outputAsset.id && edge.dependency === generation.id));
  assert.ok(snapshot.dependencies.some((edge) => edge.dependent === 'character.mira' && edge.dependency === outputAsset.id));
  assert.equal(snapshot.dependencies.some((edge) => edge.dependent === generation.id && edge.dependency === 'character.mira'), false, 'provenance must not create a Character→Asset→Generation→Character cycle');
  assert.ok(applies.every((entry) => entry.context.source === 'reference-generation'));

  const canonicalDependenciesBeforeStaleRun = snapshot.dependencies
    .filter((edge) => edge.dependent === 'character.mira' && edge.dependency.startsWith('asset.'))
    .map((edge) => edge.dependency)
    .sort();

  const staleComfy = {
    capabilities: async () => ({ checkpoint: 'anime.safetensors' }),
    generateReferenceImage: async () => {
      const character = snapshot.nodes.find((node) => node.id === 'character.mira');
      character.revision += 1;
      character.metadata.wardrobe = 'red coat';
      snapshot.projectRevision += 1;
      return {
        bytes: Buffer.alloc(4096, 7), contentType: 'image/png', promptId: 'prompt-stale', checkpoint: 'anime.safetensors', sampler: 'euler', scheduler: 'normal',
      };
    },
    generateStoryboardFrame: async () => {
      throw new Error('unexpected t2i call');
    },
  };
  const staleService = new AnchorReferenceGenerationService({ bridge, comfy: staleComfy, scheduler, projectRoot: root });
  const staleStarted = await staleService.start({
    targetId: 'character.mira',
    sourceAssetId: 'asset.reference.source',
    stylePreset: 'anime-cinematic',
  });
  const staleJob = await waitForJob(staleService, staleStarted.id);
  assert.equal(staleJob.status, 'failed');
  assert.match(staleJob.error, /reference target changed while generation was running/);
  assert.equal(staleJob.artifact, null, 'failed stale generation must never publish an artifact');
  assert.throws(() => staleService.artifact(staleStarted.id), /reference artifact is not ready/);
  const staleGeneration = snapshot.nodes.find((node) => node.id === `generation.reference.${staleStarted.id}`);
  assert.equal(staleGeneration.metadata.status, 'failed');
  const canonicalDependenciesAfterStaleRun = snapshot.dependencies
    .filter((edge) => edge.dependent === 'character.mira' && edge.dependency.startsWith('asset.'))
    .map((edge) => edge.dependency)
    .sort();
  assert.deepEqual(canonicalDependenciesAfterStaleRun, canonicalDependenciesBeforeStaleRun, 'stale output must not attach a new canonical Asset');

  const character = snapshot.nodes.find((node) => node.id === 'character.mira');
  character.locked = true;
  await assert.rejects(
    service.start({ targetId: 'character.mira', stylePreset: 'anime-cinematic' }),
    /Unlock Mira/,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('anchor reference generation service check: passed');