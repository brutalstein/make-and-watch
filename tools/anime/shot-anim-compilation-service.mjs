import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import { buildShotAnimRequest, planShotAnim } from './shot-anim-compiler.mjs';

function serviceError(code, message) {
  return Object.assign(new Error(message), { code });
}

function safePart(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'shot';
}

function nodeById(snapshot, id) {
  return snapshot.nodes.find((node) => node.id === id) ?? null;
}

function hasDependency(snapshot, dependent, dependency) {
  return snapshot.dependencies.some((edge) => edge.dependent === dependent && edge.dependency === dependency);
}

function assertShot(snapshot, shotId, expectedRevision) {
  const shot = nodeById(snapshot, shotId);
  if (!shot || shot.kind !== 'shot') throw serviceError('stale_request', 'Shot was removed while ShotAnim compilation was running');
  if (shot.revision !== expectedRevision) throw serviceError('stale_request', 'Shot changed while ShotAnim compilation was running');
  if (shot.stale) throw serviceError('stale_request', 'Shot became stale while ShotAnim compilation was running');
  if (shot.locked) throw serviceError('locked', 'Unlock the Shot before compiling a new ShotAnim Asset');
  return shot;
}

export class ShotAnimCompilationService {
  constructor({ projectRoot, bridge, compiler = buildShotAnimRequest, planner = planShotAnim }) {
    if (!projectRoot || !bridge) throw serviceError('invalid_argument', 'projectRoot and bridge are required');
    this.projectRoot = resolve(projectRoot);
    this.bridge = bridge;
    this.compiler = compiler;
    this.planner = planner;
  }

  async plan(shotId) {
    const snapshot = await this.bridge.snapshot();
    const plan = await this.planner(snapshot, shotId, { projectRoot: this.projectRoot });
    const resolved = plan.resolved ?? {};
    return {
      ready: plan.ready,
      shotId: plan.shotId,
      projectRevision: plan.projectRevision,
      issues: plan.issues,
      inputAssetIds: plan.inputAssetIds,
      resolved: {
        shotRevision: resolved.shot?.revision ?? null,
        scene: resolved.scene ? { id: resolved.scene.id, revision: resolved.scene.revision } : null,
        characterRigs: (resolved.rigs ?? []).map((rig, index) => ({
          assetId: resolved.rigAssets?.[index]?.id ?? null,
          characterId: rig.characterId,
          characterRevision: rig.characterRevision,
          outfitState: rig.outfitState,
        })),
        environmentPackage: resolved.environment ? {
          assetId: resolved.environmentAsset?.id ?? null,
          locationId: resolved.environment.locationId,
          locationRevision: resolved.environment.locationRevision,
        } : null,
        dialogue: (resolved.dialogue ?? []).map(({ unit, audioAsset, alignmentAsset }) => ({
          dialogueUnitId: unit.id,
          audioAssetId: audioAsset.id,
          alignmentAssetId: alignmentAsset.id,
        })),
        correctiveKeyAssetIds: [...(resolved.correctiveKeyIds ?? [])],
      },
    };
  }

  async compile(shotId) {
    const initial = await this.bridge.snapshot();
    const shot = nodeById(initial, shotId);
    if (!shot || shot.kind !== 'shot') throw serviceError('not_found', 'Shot was not found');
    if (shot.stale) throw serviceError('not_ready', 'Shot is stale');
    if (shot.locked) throw serviceError('locked', 'Unlock the Shot before compiling a new ShotAnim Asset');

    const compiled = await this.compiler(initial, shotId, { projectRoot: this.projectRoot });
    const bytes = Buffer.from(JSON.stringify(compiled.shotAnim, null, 2), 'utf8');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const assetNodeId = `asset.${sha256.slice(0, 24)}`;
    const generationNodeId = `generation.anime-compile.${safePart(shot.id)}.${sha256.slice(0, 12)}`;
    const directory = resolve(this.projectRoot, '.makewatch', 'artifacts', 'anime', 'shot-anim', safePart(shot.id));
    const outputPath = resolve(directory, `${sha256}.json`);
    const relativePath = relative(resolve(this.projectRoot, '.makewatch'), outputPath).replaceAll('\\', '/');
    let created = false;

    try {
      await mkdir(directory, { recursive: true });
      const existingFile = await stat(outputPath).catch(() => null);
      if (existingFile) {
        if (!existingFile.isFile()) throw serviceError('integrity_error', 'ShotAnim content-addressed path is not a file');
        const existingBytes = await readFile(outputPath);
        if (createHash('sha256').update(existingBytes).digest('hex') !== sha256) {
          throw serviceError('integrity_error', 'ShotAnim content-addressed file failed hash verification');
        }
      } else {
        await writeFile(outputPath, bytes, { flag: 'wx' });
        created = true;
      }

      const fresh = await this.bridge.snapshot();
      assertShot(fresh, shot.id, shot.revision);
      const commands = [];
      const existingGeneration = nodeById(fresh, generationNodeId);
      if (existingGeneration && (existingGeneration.kind !== 'generation' || existingGeneration.locked)) {
        throw serviceError('conflict', `ShotAnim Generation ID collision: ${generationNodeId}`);
      }
      if (!existingGeneration) {
        commands.push({
          type: 'node.create',
          node: {
            id: generationNodeId,
            kind: 'generation',
            title: `${shot.title} · Native ShotAnim Compile`,
            approval: 'draft', locked: false, stale: false,
            metadata: {
              status: 'ready',
              mediaType: 'json',
              strategy: 'NATIVE_ANIME_COMPILE',
              provider: 'native-anime',
              targetId: shot.id,
              targetRevision: String(shot.revision),
              schema: 'makewatch.shotAnim/1',
              artifactPath: relativePath,
              artifactSha256: sha256,
              compileReport: JSON.stringify(compiled.compileReport),
            },
          },
        });
        commands.push({ type: 'node.markFresh', id: generationNodeId });
      }
      for (const dependency of [...new Set(compiled.inputAssetIds)]) {
        if (!hasDependency(fresh, generationNodeId, dependency)) {
          commands.push({ type: 'dependency.add', dependent: generationNodeId, dependency });
        }
      }

      const existingAsset = nodeById(fresh, assetNodeId);
      if (existingAsset && (existingAsset.kind !== 'asset' || existingAsset.metadata?.sha256 !== sha256)) {
        throw serviceError('integrity_error', `ShotAnim Asset ID collision: ${assetNodeId}`);
      }
      if (!existingAsset) {
        commands.push({
          type: 'node.create',
          node: {
            id: assetNodeId,
            kind: 'asset',
            title: `${shot.title} · ShotAnim`,
            approval: 'draft', locked: false, stale: false,
            metadata: {
              mediaType: 'json',
              role: 'native-anime-shot-anim',
              schema: 'makewatch.shotAnim/1',
              relativePath,
              sha256,
              mimeType: 'application/json',
              generatedBy: generationNodeId,
              shotId: shot.id,
              shotRevision: String(shot.revision),
            },
          },
        });
        commands.push({ type: 'node.markFresh', id: assetNodeId });
      }
      if (!hasDependency(fresh, assetNodeId, generationNodeId)) {
        commands.push({ type: 'dependency.add', dependent: assetNodeId, dependency: generationNodeId });
      }
      if (!hasDependency(fresh, shot.id, assetNodeId)) {
        commands.push({ type: 'dependency.add', dependent: shot.id, dependency: assetNodeId });
      }
      if (commands.length) {
        await this.bridge.apply(commands, {
          actor: 'system',
          source: 'native-anime-compile',
          reason: `compile ShotAnim for ${shot.id}`,
        }, fresh.projectRevision);
      }

      return {
        generationNodeId,
        assetNodeId,
        relativePath,
        sha256,
        shotAnim: compiled.shotAnim,
        compileReport: compiled.compileReport,
        inputAssetIds: [...new Set(compiled.inputAssetIds)],
      };
    } catch (error) {
      if (created) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }
}
