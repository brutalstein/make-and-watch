import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import { validateCharacterRig } from './native-anime-asset-contracts.mjs';
import {
  normalizeCharacterRigBuildInput,
  resolveManagedSourceAsset,
} from './semantic-package-contract.mjs';

const EYE_STATES = ['OPEN', 'HALF', 'CLOSED'];
const MOUTH_STATES = ['CLOSED', 'SMALL', 'A', 'I', 'U', 'E', 'O', 'WIDE'];
const MAX_PENDING_JOBS = 12;
const MAX_RETAINED_JOBS = 64;
const RESULT_PREFIX = 'MW_SEMANTIC_QC_V1\t';

function rigError(code, message) {
  return Object.assign(new Error(message), { code });
}

function nodeById(snapshot, id) {
  return snapshot.nodes.find((node) => node.id === id) ?? null;
}

function hasDependency(snapshot, dependent, dependency) {
  return snapshot.dependencies.some((edge) => edge.dependent === dependent && edge.dependency === dependency);
}

function dependenciesOf(snapshot, dependent, kind) {
  const ids = new Set(snapshot.dependencies.filter((edge) => edge.dependent === dependent).map((edge) => edge.dependency));
  return snapshot.nodes.filter((node) => ids.has(node.id) && (!kind || node.kind === kind));
}

function requiredStateIds() {
  return [
    'face_base.DEFAULT', 'body.DEFAULT', 'front_hair.DEFAULT', 'rear_hair.DEFAULT',
    ...['eyes_l', 'eyes_r'].flatMap((side) => EYE_STATES.map((state) => `${side}.${state}`)),
    ...MOUTH_STATES.map((state) => `mouth.${state}`),
  ];
}

function safePart(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'character';
}

async function runQcWorker(pythonPath, workerPath, request, { signal } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'makewatch-rig-qc-'));
  const requestPath = join(directory, 'request.json');
  await writeFile(requestPath, JSON.stringify(request), 'utf8');
  try {
    const stdout = await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(pythonPath, [workerPath, '--request', requestPath], { windowsHide: true, signal });
      let out = '';
      let err = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.stderr.on('data', (chunk) => { err += chunk; });
      child.on('error', rejectPromise);
      child.on('close', (code) => {
        if (code === 0) resolvePromise(out);
        else rejectPromise(new Error(`semantic package worker exited ${code}: ${err.slice(-800)}`));
      });
    });
    const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith(RESULT_PREFIX));
    if (!line) throw new Error('semantic package worker produced no result line');
    const payload = JSON.parse(line.slice(RESULT_PREFIX.length));
    if (!payload.ok) throw new Error(payload.error?.message || 'semantic package worker failed');
    return payload.result;
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

function publicJob(job) {
  return {
    id: job.id,
    characterId: job.characterId,
    outfitState: job.outfitState,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    error: job.error,
    rigAssetId: job.rigAssetId,
    sha256: job.sha256,
  };
}

export class CharacterRigService {
  constructor({ bridge, projectRoot, workerPath, pythonPath = 'python', qcRunner = runQcWorker }) {
    if (!bridge || !projectRoot || !workerPath) throw rigError('invalid_argument', 'bridge, projectRoot and workerPath are required');
    this.bridge = bridge;
    this.projectRoot = resolve(projectRoot);
    this.workerPath = resolve(workerPath);
    this.pythonPath = pythonPath;
    this.qcRunner = qcRunner;
    this.jobs = new Map();
    this.pending = [];
    this.activeJobId = null;
    this.idle = Promise.resolve();
    this.resolveIdle = () => {};
  }

  async plan({ characterId, outfitState = 'default' } = {}) {
    const snapshot = await this.bridge.snapshot();
    const character = nodeById(snapshot, String(characterId ?? ''));
    if (!character || character.kind !== 'character') throw rigError('not_found', 'character node was not found');
    const outfit = String(outfitState || character.metadata?.outfitState || 'default');

    const sourceAssets = dependenciesOf(snapshot, character.id, 'asset')
      .filter((asset) => asset.metadata?.mediaType === 'image' && !asset.stale)
      .map((asset) => ({
        id: asset.id,
        semanticState: String(asset.metadata?.semanticState ?? ''),
        approval: asset.approval,
        sha256: asset.metadata?.sha256 ?? null,
      }));

    const covered = new Set(sourceAssets.map((asset) => asset.semanticState).filter(Boolean));
    const required = requiredStateIds();
    const missingStates = required.filter((state) => !covered.has(state)).sort();

    const reusableRigs = snapshot.nodes
      .filter((node) => node.kind === 'asset'
        && node.metadata?.schema === 'makewatch.characterRig/1'
        && node.metadata?.characterId === character.id
        && node.metadata?.outfitState === outfit
        && !node.stale
        && hasDependency(snapshot, character.id, node.id))
      .map((node) => ({ assetId: node.id, approval: node.approval, characterRevision: Number(node.metadata?.characterRevision ?? -1) }));

    const blockers = [];
    if (character.locked) blockers.push({ code: 'locked_character', message: `Character ${character.id} is locked` });
    if (character.stale) blockers.push({ code: 'stale_character', message: `Character ${character.id} is stale` });

    return {
      characterId: character.id,
      characterRevision: character.revision,
      outfitState: outfit,
      requiredStates: required,
      missingStates,
      sourceAssets: sourceAssets.sort((a, b) => a.id.localeCompare(b.id)),
      reusableRigs,
      blockers,
    };
  }

  async build(rawInput) {
    const input = normalizeCharacterRigBuildInput(rawInput);
    const canvas = {
      width: Math.trunc(Number(rawInput?.canvas?.width ?? 2048)),
      height: Math.trunc(Number(rawInput?.canvas?.height ?? 2048)),
    };
    if (this.pending.length >= MAX_PENDING_JOBS) throw rigError('busy', 'character rig build queue is full');
    const missingRequired = requiredStateIds().filter(
      (state) => !input.states.some((entry) => entry.id === state),
    );
    if (missingRequired.length) {
      throw rigError('invalid_argument', `missing required semantic states: ${missingRequired.join(', ')}`);
    }

    const snapshot = await this.bridge.snapshot();
    const character = nodeById(snapshot, input.characterId);
    if (!character || character.kind !== 'character') throw rigError('not_found', 'character node was not found');
    if (character.locked) throw rigError('locked', 'unlock the Character before building a rig');
    if (character.revision !== input.expectedRevision) throw rigError('stale_request', 'Character revision changed before the rig build started');

    const job = {
      id: randomUUID(),
      characterId: character.id,
      outfitState: input.outfitState,
      input,
      canvas,
      status: 'queued',
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      error: '',
      rigAssetId: null,
      sha256: null,
    };
    job.abortController = new AbortController();
    job.settled = new Promise((resolveSettled) => { job.resolveSettled = resolveSettled; });
    this.jobs.set(job.id, job);
    this.pending.push(job.id);
    if (!this.activeJobId) this.idle = new Promise((r) => { this.resolveIdle = r; });
    const queued = publicJob(job);
    this.#prune();
    void this.#pump();
    return { job: queued };
  }

  job(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw rigError('not_found', 'character rig build job was not found');
    return publicJob(job);
  }

  listJobs({ characterId, limit = 20 } = {}) {
    const bounded = Number.isInteger(limit) ? Math.max(1, Math.min(100, limit)) : 20;
    return [...this.jobs.values()]
      .filter((job) => !characterId || job.characterId === characterId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, bounded)
      .map(publicJob);
  }

  async waitForIdle() {
    await this.idle;
  }

  async cancel(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw rigError('not_found', 'character rig build job was not found');
    if (job.status === 'queued') {
      this.pending = this.pending.filter((id) => id !== job.id);
      job.status = 'cancelled';
      job.completedAt = new Date().toISOString();
      job.resolveSettled();
      if (this.pending.length === 0 && !this.activeJobId) this.resolveIdle();
    } else if (job.status === 'running' && !job.commitStarted) {
      job.abortController.abort();
      await job.settled;
    }
    return publicJob(job);
  }

  #prune() {
    if (this.jobs.size <= MAX_RETAINED_JOBS) return;
    const done = [...this.jobs.values()]
      .filter((job) => job.status !== 'queued' && job.status !== 'running')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    while (this.jobs.size > MAX_RETAINED_JOBS && done.length) this.jobs.delete(done.shift().id);
  }

  async #pump() {
    if (this.activeJobId || this.pending.length === 0) return;
    const id = this.pending.shift();
    const job = this.jobs.get(id);
    if (!job) return void this.#pump();
    this.activeJobId = id;
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    try {
      await this.#run(job);
      job.abortController.signal.throwIfAborted();
      job.status = 'completed';
      job.completedAt = new Date().toISOString();
    } catch (error) {
      job.status = job.abortController.signal.aborted ? 'cancelled' : 'failed';
      job.error = job.status === 'cancelled' ? '' : (error instanceof Error ? error.message : String(error)).slice(0, 1600);
      job.completedAt = new Date().toISOString();
    } finally {
      this.activeJobId = null;
      job.resolveSettled();
      this.#prune();
      if (this.pending.length === 0) this.resolveIdle();
      void this.#pump();
    }
  }

  async #run(job) {
    const { signal } = job.abortController;
    signal.throwIfAborted();
    const snapshot = await this.bridge.snapshot();
    const character = nodeById(snapshot, job.characterId);
    if (!character || character.kind !== 'character') throw new Error('character node was removed before the rig build started');
    if (character.locked) throw new Error('character was locked before the rig build started');
    if (character.revision !== job.input.expectedRevision) throw new Error('character revision changed before the rig build started');

    const resolvedStates = [];
    for (const state of job.input.states) {
      const source = await resolveManagedSourceAsset(snapshot, this.projectRoot, state.sourceAssetId, 'image');
      resolvedStates.push({
        id: state.id,
        semanticPart: state.semanticPart,
        imageAssetId: source.id,
        imageSha256: source.sha256,
        path: source.relativePath,
        pivot: state.pivot,
        z: state.z,
        attachTo: state.attachTo,
      });
    }
    signal.throwIfAborted();

    const paletteFingerprint = createHash('sha256')
      .update(resolvedStates.map((state) => `${state.id}:${state.imageSha256}`).sort().join('\n'))
      .digest('hex');

    const rig = validateCharacterRig({
      schema: 'makewatch.characterRig/1',
      characterId: character.id,
      characterRevision: character.revision,
      outfitState: job.input.outfitState,
      paletteFingerprint,
      canvas: job.canvas,
      states: resolvedStates,
      validDomain: job.input.validDomain,
    });

    const bytes = Buffer.from(JSON.stringify(rig, null, 2), 'utf8');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const rigAssetId = `asset.${sha256.slice(0, 24)}`;
    const generationNodeId = `generation.character-rig.${safePart(character.id)}.${sha256.slice(0, 12)}`;
    const directory = resolve(this.projectRoot, '.makewatch', 'artifacts', 'anime', 'character-rig', safePart(character.id));
    const outputPath = join(directory, `${sha256}.json`);
    const relativePath = relative(resolve(this.projectRoot, '.makewatch'), outputPath).replaceAll('\\', '/');
    let created = false;

    try {
      await mkdir(directory, { recursive: true });
      await writeFile(outputPath, bytes, { flag: 'wx' }).then(() => { created = true; }, async (error) => {
        if (error?.code !== 'EEXIST') throw error;
        const existing = await readFile(outputPath);
        if (createHash('sha256').update(existing).digest('hex') !== sha256) {
          throw rigError('integrity_error', 'CharacterRig content-addressed file failed hash verification');
        }
      });

      const fresh = await this.bridge.snapshot();
      const freshCharacter = nodeById(fresh, character.id);
      if (!freshCharacter || freshCharacter.revision !== character.revision || freshCharacter.locked) {
        throw rigError('stale_request', 'Character changed while the rig build was running');
      }
      const existingRig = nodeById(fresh, rigAssetId);
      if (existingRig && (existingRig.kind !== 'asset' || existingRig.metadata?.sha256 !== sha256)) {
        throw rigError('conflict', `CharacterRig Asset ID collision: ${rigAssetId}`);
      }

      job.commitStarted = true;
      const commands = [];
      if (!nodeById(fresh, generationNodeId)) {
        commands.push({
          type: 'node.create',
          node: {
            id: generationNodeId,
            kind: 'generation',
            title: `${character.title} · CharacterRig Build`,
            approval: 'draft', locked: false, stale: false,
            metadata: {
              status: 'ready',
              mediaType: 'json',
              strategy: 'NATIVE_ANIME_CHARACTER_RIG',
              provider: 'native-anime',
              targetId: character.id,
              targetRevision: String(character.revision),
              schema: 'makewatch.characterRig/1',
              artifactPath: relativePath,
              artifactSha256: sha256,
              outfitState: job.input.outfitState,
            },
          },
        });
        commands.push({ type: 'node.markFresh', id: generationNodeId });
      }
      for (const dependency of [...new Set(resolvedStates.map((state) => state.imageAssetId))].sort()) {
        if (!hasDependency(fresh, generationNodeId, dependency)) {
          commands.push({ type: 'dependency.add', dependent: generationNodeId, dependency });
        }
      }
      if (!hasDependency(fresh, generationNodeId, character.id)) {
        commands.push({ type: 'dependency.add', dependent: generationNodeId, dependency: character.id });
      }
      if (!existingRig) {
        commands.push({
          type: 'node.create',
          node: {
            id: rigAssetId,
            kind: 'asset',
            title: `${character.title} · CharacterRig (${job.input.outfitState})`,
            approval: 'draft', locked: false, stale: false,
            metadata: {
              mediaType: 'json',
              role: 'native-anime-character-rig',
              schema: 'makewatch.characterRig/1',
              relativePath,
              sha256,
              mimeType: 'application/json',
              generatedBy: generationNodeId,
              characterId: character.id,
              characterRevision: String(character.revision),
              outfitState: job.input.outfitState,
              paletteFingerprint,
            },
          },
        });
        commands.push({ type: 'node.markFresh', id: rigAssetId });
      }
      if (!hasDependency(fresh, rigAssetId, generationNodeId)) {
        commands.push({ type: 'dependency.add', dependent: rigAssetId, dependency: generationNodeId });
      }
      if (commands.length) {
        await this.bridge.apply(commands, {
          actor: 'system',
          source: 'native-anime-character-rig',
          reason: `build CharacterRig for ${character.id}`,
        }, fresh.projectRevision);
      }

      job.rigAssetId = rigAssetId;
      job.sha256 = sha256;
      job.relativePath = relativePath;
    } catch (error) {
      if (created && !job.commitStarted) await rm(outputPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async validate({ rigAssetId, expectedCharacterRevision, promote = false } = {}) {
    const snapshot = await this.bridge.snapshot();
    const rigAsset = nodeById(snapshot, String(rigAssetId ?? ''));
    if (!rigAsset || rigAsset.kind !== 'asset' || rigAsset.metadata?.schema !== 'makewatch.characterRig/1') {
      throw rigError('not_found', 'CharacterRig Asset was not found');
    }
    const character = nodeById(snapshot, String(rigAsset.metadata?.characterId ?? ''));
    if (!character || character.kind !== 'character') throw rigError('not_found', 'CharacterRig has no Character');

    const rigBytes = await readFile(resolve(this.projectRoot, '.makewatch', ...String(rigAsset.metadata.relativePath).split('/')));
    if (createHash('sha256').update(rigBytes).digest('hex') !== rigAsset.metadata.sha256) {
      throw rigError('integrity_error', 'CharacterRig Asset failed SHA-256 verification');
    }
    const rig = validateCharacterRig(JSON.parse(rigBytes.toString('utf8')));

    const stateFiles = [];
    for (const state of rig.states) {
      const source = await resolveManagedSourceAsset(snapshot, this.projectRoot, state.imageAssetId, 'image');
      if (source.sha256 !== state.imageSha256) throw rigError('integrity_error', `CharacterRig state ${state.id} source hash drifted`);
      stateFiles.push({ id: state.id, semanticPart: state.semanticPart, path: source.absolutePath });
    }

    const reportDir = resolve(this.projectRoot, '.makewatch', 'artifacts', 'anime', 'character-rig-qc', safePart(character.id));
    await mkdir(reportDir, { recursive: true });
    const contactSheet = join(reportDir, `${rigAsset.metadata.sha256}.sheet.png`);

    const qc = await this.qcRunner(this.pythonPath, this.workerPath, {
      operation: 'character',
      canvas: rig.canvas,
      states: stateFiles,
      contactSheet,
    }, {});

    const report = {
      schema: 'makewatch.semanticPackageQcReport/1',
      kind: 'character',
      rigAssetId: rigAsset.id,
      characterId: character.id,
      characterRevision: character.revision,
      passed: Boolean(qc.passed),
      checks: qc.checks ?? [],
      findings: qc.findings ?? [],
      contactSheetRelativePath: relative(resolve(this.projectRoot, '.makewatch'), contactSheet).replaceAll('\\', '/'),
    };
    const reportBytes = Buffer.from(JSON.stringify(report, null, 2), 'utf8');
    const reportSha = createHash('sha256').update(reportBytes).digest('hex');
    const reportAssetId = `asset.${reportSha.slice(0, 24)}`;
    const reportPath = join(reportDir, `${reportSha}.json`);
    const reportRel = relative(resolve(this.projectRoot, '.makewatch'), reportPath).replaceAll('\\', '/');
    await writeFile(reportPath, reportBytes, { flag: 'wx' }).catch((error) => { if (error?.code !== 'EEXIST') throw error; });

    const fresh = await this.bridge.snapshot();
    const freshCharacter = nodeById(fresh, character.id);
    const commands = [];
    if (!nodeById(fresh, reportAssetId)) {
      commands.push({
        type: 'node.create',
        node: {
          id: reportAssetId,
          kind: 'asset',
          title: `${character.title} · CharacterRig QC`,
          approval: 'draft', locked: false, stale: false,
          metadata: {
            mediaType: 'json', role: 'native-anime-character-rig-qc', schema: 'makewatch.semanticPackageQcReport/1',
            relativePath: reportRel, sha256: reportSha, mimeType: 'application/json',
            rigAssetId: rigAsset.id, passed: String(report.passed),
          },
        },
      });
      commands.push({ type: 'node.markFresh', id: reportAssetId });
    }
    if (!hasDependency(fresh, reportAssetId, rigAsset.id)) {
      commands.push({ type: 'dependency.add', dependent: reportAssetId, dependency: rigAsset.id });
    }

    let promoted = false;
    if (report.passed && promote) {
      if (!freshCharacter || freshCharacter.kind !== 'character') throw rigError('not_found', 'Character disappeared before promotion');
      if (freshCharacter.locked) throw rigError('locked', 'unlock the Character before promoting a rig');
      if (Number.isInteger(expectedCharacterRevision) && freshCharacter.revision !== expectedCharacterRevision) {
        throw rigError('stale_request', `Character is at revision ${freshCharacter.revision}, expected ${expectedCharacterRevision}`);
      }
      if (freshCharacter.revision !== rig.characterRevision) {
        throw rigError('stale_request', `CharacterRig targets revision ${rig.characterRevision}, Character is at ${freshCharacter.revision}`);
      }
      const priorRigs = JSON.parse(freshCharacter.metadata?.characterRigAssetIds ?? '[]');
      const nextRigs = [...new Set([...(Array.isArray(priorRigs) ? priorRigs : []), rigAsset.id])];
      commands.push({ type: 'node.patch', id: rigAsset.id, approval: 'approved' });
      if (!hasDependency(fresh, freshCharacter.id, rigAsset.id)) {
        commands.push({ type: 'dependency.add', dependent: freshCharacter.id, dependency: rigAsset.id });
      }
      commands.push({
        type: 'node.patch',
        id: freshCharacter.id,
        expectedRevision: freshCharacter.revision,
        metadataUpdates: { characterRigAssetIds: JSON.stringify(nextRigs) },
      });
      promoted = true;
    }

    if (commands.length) {
      await this.bridge.apply(commands, {
        actor: 'system',
        source: 'native-anime-character-rig-validate',
        reason: `validate CharacterRig ${rigAsset.id}`,
      }, fresh.projectRevision);
    }

    return { reportAssetId, passed: report.passed, promoted, findings: report.findings, checks: report.checks };
  }
}
