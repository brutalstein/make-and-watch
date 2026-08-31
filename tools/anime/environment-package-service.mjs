import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import { validateEnvironmentPackage } from './native-anime-asset-contracts.mjs';
import {
  normalizeEnvironmentPackageBuildInput,
  resolveManagedSourceAsset,
} from './semantic-package-contract.mjs';

const REQUIRED_ROLES = ['background', 'midground', 'foreground'];
const MAX_PENDING_JOBS = 12;
const MAX_RETAINED_JOBS = 64;
const RESULT_PREFIX = 'MW_SEMANTIC_QC_V1\t';

function envError(code, message) {
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

function safePart(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'location';
}

async function runQcWorker(pythonPath, workerPath, request, { signal } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'makewatch-env-qc-'));
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
    locationId: job.locationId,
    stateId: job.stateId,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    error: job.error,
    packageAssetId: job.packageAssetId,
    sha256: job.sha256,
  };
}

export class EnvironmentPackageService {
  constructor({ bridge, projectRoot, workerPath, pythonPath = 'python', qcRunner = runQcWorker }) {
    if (!bridge || !projectRoot || !workerPath) throw envError('invalid_argument', 'bridge, projectRoot and workerPath are required');
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

  async plan({ locationId, stateId = 'default' } = {}) {
    const snapshot = await this.bridge.snapshot();
    const location = nodeById(snapshot, String(locationId ?? ''));
    if (!location || location.kind !== 'location') throw envError('not_found', 'location node was not found');
    const state = String(stateId || 'default');

    const sourceAssets = dependenciesOf(snapshot, location.id, 'asset')
      .filter((asset) => asset.metadata?.mediaType === 'image' && !asset.stale)
      .map((asset) => ({ id: asset.id, plateRole: String(asset.metadata?.plateRole ?? ''), approval: asset.approval }));
    const covered = new Set(sourceAssets.map((asset) => asset.plateRole).filter(Boolean));
    const missingPlates = REQUIRED_ROLES.filter((role) => !covered.has(role));

    const reusablePackages = snapshot.nodes
      .filter((node) => node.kind === 'asset'
        && node.metadata?.schema === 'makewatch.environmentPackage/1'
        && node.metadata?.locationId === location.id
        && node.metadata?.stateId === state
        && !node.stale
        && hasDependency(snapshot, location.id, node.id))
      .map((node) => ({ assetId: node.id, approval: node.approval, locationRevision: Number(node.metadata?.locationRevision ?? -1) }));

    const blockers = [];
    if (location.locked) blockers.push({ code: 'locked_location', message: `Location ${location.id} is locked` });
    if (location.stale) blockers.push({ code: 'stale_location', message: `Location ${location.id} is stale` });

    return {
      locationId: location.id,
      locationRevision: location.revision,
      stateId: state,
      requiredPlates: [...REQUIRED_ROLES],
      missingPlates,
      sourceAssets: sourceAssets.sort((a, b) => a.id.localeCompare(b.id)),
      reusablePackages,
      blockers,
    };
  }

  async build(rawInput) {
    const input = normalizeEnvironmentPackageBuildInput(rawInput);
    const canvas = {
      width: Math.trunc(Number(rawInput?.canvas?.width ?? 1920)),
      height: Math.trunc(Number(rawInput?.canvas?.height ?? 1080)),
    };
    if (this.pending.length >= MAX_PENDING_JOBS) throw envError('busy', 'environment package build queue is full');

    const snapshot = await this.bridge.snapshot();
    const location = nodeById(snapshot, input.locationId);
    if (!location || location.kind !== 'location') throw envError('not_found', 'location node was not found');
    if (location.locked) throw envError('locked', 'unlock the Location before building a package');
    if (location.revision !== input.expectedRevision) throw envError('stale_request', 'Location revision changed before the package build started');

    const job = {
      id: randomUUID(),
      locationId: location.id,
      stateId: input.stateId,
      input,
      canvas,
      status: 'queued',
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      error: '',
      packageAssetId: null,
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
    if (!job) throw envError('not_found', 'environment package build job was not found');
    return publicJob(job);
  }

  listJobs({ locationId, limit = 20 } = {}) {
    const bounded = Number.isInteger(limit) ? Math.max(1, Math.min(100, limit)) : 20;
    return [...this.jobs.values()]
      .filter((job) => !locationId || job.locationId === locationId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, bounded)
      .map(publicJob);
  }

  async waitForIdle() {
    await this.idle;
  }

  async cancel(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw envError('not_found', 'environment package build job was not found');
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
    const location = nodeById(snapshot, job.locationId);
    if (!location || location.kind !== 'location') throw new Error('location node was removed before the package build started');
    if (location.locked) throw new Error('location was locked before the package build started');
    if (location.revision !== job.input.expectedRevision) throw new Error('location revision changed before the package build started');

    const resolvedPlates = [];
    for (const plate of job.input.plates) {
      const source = await resolveManagedSourceAsset(snapshot, this.projectRoot, plate.sourceAssetId, 'image');
      resolvedPlates.push({
        id: plate.id,
        role: plate.role,
        imageAssetId: source.id,
        imageSha256: source.sha256,
        path: source.relativePath,
        depth: plate.depth,
      });
    }
    const mask = await resolveManagedSourceAsset(snapshot, this.projectRoot, job.input.occlusionMaskAssetId, 'image');
    signal.throwIfAborted();

    const pkg = validateEnvironmentPackage({
      schema: 'makewatch.environmentPackage/1',
      locationId: location.id,
      locationRevision: location.revision,
      canvas: job.canvas,
      plates: resolvedPlates,
      occlusionMaskAssetId: mask.id,
      occlusionMaskSha256: mask.sha256,
      cameraSafeRegion: job.input.cameraSafeRegion,
      lightingStates: job.input.lightingStates,
      weatherStates: job.input.weatherStates,
    });

    const bytes = Buffer.from(JSON.stringify(pkg, null, 2), 'utf8');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const packageAssetId = `asset.${sha256.slice(0, 24)}`;
    const generationNodeId = `generation.environment-package.${safePart(location.id)}.${sha256.slice(0, 12)}`;
    const directory = resolve(this.projectRoot, '.makewatch', 'artifacts', 'anime', 'environment-package', safePart(location.id));
    const outputPath = join(directory, `${sha256}.json`);
    const relativePath = relative(resolve(this.projectRoot, '.makewatch'), outputPath).replaceAll('\\', '/');
    let created = false;

    try {
      await mkdir(directory, { recursive: true });
      await writeFile(outputPath, bytes, { flag: 'wx' }).then(() => { created = true; }, async (error) => {
        if (error?.code !== 'EEXIST') throw error;
        const existing = await readFile(outputPath);
        if (createHash('sha256').update(existing).digest('hex') !== sha256) {
          throw envError('integrity_error', 'EnvironmentPackage content-addressed file failed hash verification');
        }
      });

      const fresh = await this.bridge.snapshot();
      const freshLocation = nodeById(fresh, location.id);
      if (!freshLocation || freshLocation.revision !== location.revision || freshLocation.locked) {
        throw envError('stale_request', 'Location changed while the package build was running');
      }
      const existingPackage = nodeById(fresh, packageAssetId);
      if (existingPackage && (existingPackage.kind !== 'asset' || existingPackage.metadata?.sha256 !== sha256)) {
        throw envError('conflict', `EnvironmentPackage Asset ID collision: ${packageAssetId}`);
      }

      job.commitStarted = true;
      const sourceIds = [...new Set([...resolvedPlates.map((plate) => plate.imageAssetId), mask.id])].sort();
      const commands = [];
      if (!nodeById(fresh, generationNodeId)) {
        commands.push({
          type: 'node.create',
          node: {
            id: generationNodeId,
            kind: 'generation',
            title: `${location.title} · EnvironmentPackage Build`,
            approval: 'draft', locked: false, stale: false,
            metadata: {
              status: 'ready', mediaType: 'json', strategy: 'NATIVE_ANIME_ENVIRONMENT_PACKAGE', provider: 'native-anime',
              targetId: location.id, targetRevision: String(location.revision),
              schema: 'makewatch.environmentPackage/1', artifactPath: relativePath, artifactSha256: sha256,
              stateId: job.input.stateId,
            },
          },
        });
        commands.push({ type: 'node.markFresh', id: generationNodeId });
      }
      for (const dependency of sourceIds) {
        if (!hasDependency(fresh, generationNodeId, dependency)) {
          commands.push({ type: 'dependency.add', dependent: generationNodeId, dependency });
        }
      }
      if (!hasDependency(fresh, generationNodeId, location.id)) {
        commands.push({ type: 'dependency.add', dependent: generationNodeId, dependency: location.id });
      }
      if (!existingPackage) {
        commands.push({
          type: 'node.create',
          node: {
            id: packageAssetId,
            kind: 'asset',
            title: `${location.title} · EnvironmentPackage (${job.input.stateId})`,
            approval: 'draft', locked: false, stale: false,
            metadata: {
              mediaType: 'json', role: 'native-anime-environment-package', schema: 'makewatch.environmentPackage/1',
              relativePath, sha256, mimeType: 'application/json', generatedBy: generationNodeId,
              locationId: location.id, locationRevision: String(location.revision), stateId: job.input.stateId,
            },
          },
        });
        commands.push({ type: 'node.markFresh', id: packageAssetId });
      }
      if (!hasDependency(fresh, packageAssetId, generationNodeId)) {
        commands.push({ type: 'dependency.add', dependent: packageAssetId, dependency: generationNodeId });
      }
      if (commands.length) {
        await this.bridge.apply(commands, {
          actor: 'system',
          source: 'native-anime-environment-package',
          reason: `build EnvironmentPackage for ${location.id}`,
        }, fresh.projectRevision);
      }

      job.packageAssetId = packageAssetId;
      job.sha256 = sha256;
      job.relativePath = relativePath;
    } catch (error) {
      if (created && !job.commitStarted) await rm(outputPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async validate({ packageAssetId, expectedLocationRevision, promote = false } = {}) {
    const snapshot = await this.bridge.snapshot();
    const packageAsset = nodeById(snapshot, String(packageAssetId ?? ''));
    if (!packageAsset || packageAsset.kind !== 'asset' || packageAsset.metadata?.schema !== 'makewatch.environmentPackage/1') {
      throw envError('not_found', 'EnvironmentPackage Asset was not found');
    }
    const location = nodeById(snapshot, String(packageAsset.metadata?.locationId ?? ''));
    if (!location || location.kind !== 'location') throw envError('not_found', 'EnvironmentPackage has no Location');

    const packageBytes = await readFile(resolve(this.projectRoot, '.makewatch', ...String(packageAsset.metadata.relativePath).split('/')));
    if (createHash('sha256').update(packageBytes).digest('hex') !== packageAsset.metadata.sha256) {
      throw envError('integrity_error', 'EnvironmentPackage Asset failed SHA-256 verification');
    }
    const pkg = validateEnvironmentPackage(JSON.parse(packageBytes.toString('utf8')));

    const plateFiles = [];
    for (const plate of pkg.plates) {
      const source = await resolveManagedSourceAsset(snapshot, this.projectRoot, plate.imageAssetId, 'image');
      if (source.sha256 !== plate.imageSha256) throw envError('integrity_error', `EnvironmentPackage plate ${plate.id} source hash drifted`);
      plateFiles.push({ id: plate.id, role: plate.role, path: source.absolutePath, depth: plate.depth });
    }
    const mask = await resolveManagedSourceAsset(snapshot, this.projectRoot, pkg.occlusionMaskAssetId, 'image');
    if (mask.sha256 !== pkg.occlusionMaskSha256) throw envError('integrity_error', 'EnvironmentPackage occlusion mask hash drifted');

    const reportDir = resolve(this.projectRoot, '.makewatch', 'artifacts', 'anime', 'environment-package-qc', safePart(location.id));
    await mkdir(reportDir, { recursive: true });
    const contactSheet = join(reportDir, `${packageAsset.metadata.sha256}.sheet.png`);

    const qc = await this.qcRunner(this.pythonPath, this.workerPath, {
      operation: 'environment',
      canvas: pkg.canvas,
      plates: plateFiles,
      occlusionMaskPath: mask.absolutePath,
      cameraSafeRegion: pkg.cameraSafeRegion,
      contactSheet,
    }, {});

    const report = {
      schema: 'makewatch.semanticPackageQcReport/1',
      kind: 'environment',
      packageAssetId: packageAsset.id,
      locationId: location.id,
      locationRevision: location.revision,
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
    const freshLocation = nodeById(fresh, location.id);
    const commands = [];
    if (!nodeById(fresh, reportAssetId)) {
      commands.push({
        type: 'node.create',
        node: {
          id: reportAssetId,
          kind: 'asset',
          title: `${location.title} · EnvironmentPackage QC`,
          approval: 'draft', locked: false, stale: false,
          metadata: {
            mediaType: 'json', role: 'native-anime-environment-package-qc', schema: 'makewatch.semanticPackageQcReport/1',
            relativePath: reportRel, sha256: reportSha, mimeType: 'application/json',
            packageAssetId: packageAsset.id, passed: String(report.passed),
          },
        },
      });
      commands.push({ type: 'node.markFresh', id: reportAssetId });
    }
    if (!hasDependency(fresh, reportAssetId, packageAsset.id)) {
      commands.push({ type: 'dependency.add', dependent: reportAssetId, dependency: packageAsset.id });
    }

    let promoted = false;
    if (report.passed && promote) {
      if (!freshLocation || freshLocation.kind !== 'location') throw envError('not_found', 'Location disappeared before promotion');
      if (freshLocation.locked) throw envError('locked', 'unlock the Location before promoting a package');
      if (Number.isInteger(expectedLocationRevision) && freshLocation.revision !== expectedLocationRevision) {
        throw envError('stale_request', `Location is at revision ${freshLocation.revision}, expected ${expectedLocationRevision}`);
      }
      if (freshLocation.revision !== pkg.locationRevision) {
        throw envError('stale_request', `EnvironmentPackage targets revision ${pkg.locationRevision}, Location is at ${freshLocation.revision}`);
      }
      const prior = JSON.parse(freshLocation.metadata?.environmentPackageAssetIds ?? '[]');
      const next = [...new Set([...(Array.isArray(prior) ? prior : []), packageAsset.id])];
      commands.push({ type: 'node.patch', id: packageAsset.id, approval: 'approved' });
      if (!hasDependency(fresh, freshLocation.id, packageAsset.id)) {
        commands.push({ type: 'dependency.add', dependent: freshLocation.id, dependency: packageAsset.id });
      }
      commands.push({
        type: 'node.patch',
        id: freshLocation.id,
        expectedRevision: freshLocation.revision,
        metadataUpdates: { environmentPackageAssetIds: JSON.stringify(next) },
      });
      promoted = true;
    }

    if (commands.length) {
      await this.bridge.apply(commands, {
        actor: 'system',
        source: 'native-anime-environment-package-validate',
        reason: `validate EnvironmentPackage ${packageAsset.id}`,
      }, fresh.projectRevision);
    }

    return { reportAssetId, passed: report.passed, promoted, findings: report.findings, checks: report.checks };
  }
}
