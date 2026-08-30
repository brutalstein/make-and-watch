import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SceneGenerationService, sceneGenerationInternals } from './scene-generation-service.mjs';

function baseSnapshot() {
  return {
    schemaVersion: 1,
    projectRevision: 7,
    nodes: [
      { id: 'series.demo', kind: 'series', title: 'Demo', metadata: { genre: 'thriller', visualLanguage: 'cinematic realism', masterSeed: '777' }, revision: 1, approval: 'approved', locked: false, stale: false },
      { id: 'episode.001', kind: 'episode', title: 'Pilot', metadata: {}, revision: 1, approval: 'approved', locked: false, stale: false },
      { id: 'scene.001', kind: 'scene', title: 'First Scene', metadata: { summary: 'A lone traveler enters a rain-soaked station.', dramaticGoal: 'Reveal that the station is not abandoned.' }, revision: 1, approval: 'approved', locked: false, stale: false },
      { id: 'shot.001', kind: 'shot', title: 'Arrival', metadata: { framing: 'wide', camera: 'slow dolly', durationSeconds: '4', generationStrategy: 'T2I', subjectAction: 'the traveler crosses the wet platform' }, revision: 1, approval: 'approved', locked: false, stale: false },
      { id: 'character.traveler', kind: 'character', title: 'The Traveler', metadata: { appearancePrompt: 'adult traveler, dark wool coat, tired eyes', wardrobe: 'dark wool coat' }, revision: 1, approval: 'approved', locked: true, stale: false },
      { id: 'location.station', kind: 'location', title: 'Old Station', metadata: { city: 'Istanbul', time: 'night', weather: 'rain', environmentPrompt: 'old stone railway station, wet reflective platform, sparse amber lamps' }, revision: 1, approval: 'approved', locked: false, stale: false },
    ],
    dependencies: [
      { dependent: 'episode.001', dependency: 'series.demo' },
      { dependent: 'scene.001', dependency: 'episode.001' },
      { dependent: 'scene.001', dependency: 'location.station' },
      { dependent: 'shot.001', dependency: 'scene.001' },
      { dependent: 'shot.001', dependency: 'location.station' },
      { dependent: 'shot.001', dependency: 'character.traveler' },
    ],
  };
}

class FakeBridge {
  constructor() { this.state = baseSnapshot(); this.calls = []; }
  async snapshot() { return structuredClone(this.state); }
  async apply(commands, context, expectedRevision) {
    assert.equal(expectedRevision, this.state.projectRevision);
    this.calls.push({ commands: structuredClone(commands), context: structuredClone(context) });
    for (const command of commands) {
      if (command.type === 'node.create') {
        if (!this.state.nodes.some((candidate) => candidate.id === command.node.id)) {
          this.state.nodes.push({ ...structuredClone(command.node), revision: 1 });
        }
      } else if (command.type === 'dependency.add') {
        if (!this.state.dependencies.some((edge) => edge.dependent === command.dependent && edge.dependency === command.dependency)) {
          this.state.dependencies.push({ dependent: command.dependent, dependency: command.dependency });
        }
      } else if (command.type === 'node.patch') {
        const target = this.state.nodes.find((candidate) => candidate.id === command.id);
        if (!target) throw new Error('fake patch target missing');
        target.metadata = { ...target.metadata, ...(command.metadataUpdates ?? {}) };
        target.revision += 1;
      } else if (command.type === 'node.markFresh') {
        const target = this.state.nodes.find((candidate) => candidate.id === command.id);
        if (target) target.stale = false;
      }
    }
    this.state.projectRevision += 1;
    return { projectRevision: this.state.projectRevision, snapshot: structuredClone(this.state), events: [] };
  }
}

class FakeComfy {
  constructor() { this.inputs = []; }
  async capabilities() { return { online: true, checkpoint: 'fake.safetensors', sampler: 'euler', scheduler: 'normal' }; }
  async generateStoryboardFrame(input) {
    this.inputs.push(structuredClone(input));
    assert.match(input.prompt, /First Scene/);
    assert.match(input.prompt, /Arrival/);
    assert.match(input.prompt, /Old Station/);
    assert.match(input.prompt, /The Traveler/);
    assert.match(input.prompt, /dark wool coat/);
    assert.match(input.prompt, /not abandoned/);
    return {
      promptId: `prompt-${this.inputs.length}`,
      checkpoint: 'fake.safetensors',
      sampler: 'euler',
      scheduler: 'normal',
      image: { filename: 'frame.png', subfolder: '', type: 'output' },
      bytes: Buffer.from('fake-image'),
      contentType: 'image/png',
    };
  }
}

async function waitFor(service, id) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const job = service.get(id);
    if (job.status === 'completed' || job.status === 'failed') return job;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error('generation service check timed out');
}

const directory = await mkdtemp(join(tmpdir(), 'makewatch-generation-'));
try {
  const bridge = new FakeBridge();
  const comfy = new FakeComfy();
  const service = new SceneGenerationService({ bridge, comfy, artifactRoot: directory });

  const firstAccepted = await service.startScene('scene.001');
  assert.ok(['queued', 'running'].includes(firstAccepted.status), 'accepted job may start immediately');
  const first = await waitFor(service, firstAccepted.id);
  assert.equal(first.status, 'completed', first.error);
  assert.equal(first.completedShots, 1);
  assert.equal(first.artifacts.length, 1);
  assert.equal(first.artifacts[0].shotId, 'shot.001');
  assert.match(first.artifacts[0].sha256, /^[a-f0-9]{64}$/);
  assert.match(first.artifacts[0].promptHash, /^[a-f0-9]{64}$/);
  assert.ok(Number.isInteger(first.artifacts[0].seed));

  const generation = bridge.state.nodes.find((candidate) => candidate.id === 'generation.preview.shot.001');
  assert.ok(generation, 'generation node should be durable project state');
  assert.equal(generation.metadata.status, 'ready');
  assert.equal(generation.metadata.provider, 'comfyui');
  assert.equal(generation.metadata.model, 'fake.safetensors');
  assert.equal(generation.metadata.artifactSha256, first.artifacts[0].sha256);
  assert.equal(generation.metadata.promptHash, first.artifacts[0].promptHash);
  assert.equal(Number(generation.metadata.seed), first.artifacts[0].seed);
  assert.ok(bridge.state.dependencies.some((edge) => edge.dependent === generation.id && edge.dependency === 'shot.001'));

  const asset = bridge.state.nodes.find((candidate) => candidate.id === first.artifacts[0].assetNodeId);
  assert.ok(asset, 'generated media must become a durable Asset node');
  assert.equal(asset.kind, 'asset');
  assert.equal(asset.metadata.mediaType, 'image');
  assert.equal(asset.metadata.sha256, first.artifacts[0].sha256);
  assert.equal(asset.metadata.generatedBy, generation.id);
  assert.ok(bridge.state.dependencies.some((edge) => edge.dependent === asset.id && edge.dependency === generation.id));
  assert.ok(bridge.calls.every((call) => call.context.source === 'scene-storyboard-generation'));

  const manifest = JSON.parse(await readFile(join(directory, 'scene.001', firstAccepted.id, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.job.sceneId, 'scene.001');

  // Unrelated project transactions must not perturb visual identity seeds.
  bridge.state.projectRevision += 50;
  bridge.state.nodes.push({ id: 'asset.unrelated', kind: 'asset', title: 'Unrelated', metadata: {}, revision: 1, approval: 'draft', locked: false, stale: false });
  const secondAccepted = await service.startScene('scene.001');
  const second = await waitFor(service, secondAccepted.id);
  assert.equal(second.status, 'completed', second.error);
  assert.equal(second.artifacts[0].seed, first.artifacts[0].seed);
  assert.equal(comfy.inputs[1].seed, comfy.inputs[0].seed);

  const queuedService = new SceneGenerationService({ bridge, comfy, artifactRoot: directory });
  queuedService.activeJobId = 'fixture-held';
  const queued = await queuedService.startScene('scene.001');
  const cancelled = await queuedService.cancel(queued.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(queuedService.pending.includes(queued.id), false);

  bridge.state.nodes.push({ id: 'scene.empty', kind: 'scene', title: 'Empty', metadata: {}, revision: 1, approval: 'draft', locked: false, stale: false });
  await assert.rejects(() => service.startScene('scene.empty'), /no linked shot/);
  console.log('scene generation service check: passed');
} finally {
  await rm(directory, { recursive: true, force: true });
}

// --- Style presets -----------------------------------------------------------
// The prompt scaffold used to be hardcoded photoreal wording, which fought any
// non-photoreal checkpoint. A Series now declares its rendering idiom and every
// Shot must inherit it.
{
  const { STYLE_PRESETS, DEFAULT_STYLE_PRESET, stylePresetFor, compiledShotPrompt } = sceneGenerationInternals;

  assert.equal(stylePresetFor(null), STYLE_PRESETS[DEFAULT_STYLE_PRESET], 'missing series falls back to the default idiom');
  assert.equal(
    stylePresetFor({ metadata: { stylePreset: 'nonsense' } }),
    STYLE_PRESETS[DEFAULT_STYLE_PRESET],
    'an unknown preset must not break generation',
  );

  const styled = (preset) => {
    const series = { id: 'series.s', kind: 'series', title: 'S', revision: 1, metadata: { stylePreset: preset } };
    const episode = { id: 'ep.1', kind: 'episode', title: 'E', revision: 1, metadata: {} };
    const scene = { id: 'sc.1', kind: 'scene', title: 'Sc', revision: 1, metadata: { summary: 'a beat' } };
    const shot = { id: 'sh.1', kind: 'shot', title: 'Sh', revision: 1, metadata: {} };
    const snapshot = {
      schemaVersion: 1,
      projectRevision: 1,
      nodes: [series, episode, scene, shot],
      dependencies: [
        { dependent: 'ep.1', dependency: 'series.s' },
        { dependent: 'sc.1', dependency: 'ep.1' },
        { dependent: 'sh.1', dependency: 'sc.1' },
      ],
    };
    return compiledShotPrompt(snapshot, scene, shot);
  };

  const anime = styled('anime-cinematic');
  assert.match(anime.prompt, /anime film still/, 'anime idiom must lead the prompt');
  assert.doesNotMatch(anime.prompt, /physically plausible materials/, 'photoreal scaffold must not leak into anime');
  assert.doesNotMatch(anime.prompt, /restrained filmic color grade/, 'photoreal grade must not leak into anime');
  assert.match(anime.style.negative, /photorealistic/, 'anime idiom must exclude photorealism');
  assert.equal(anime.style.sampler, 'euler_ancestral');
  assert.ok(anime.style.width >= 1024, 'SDXL-class idioms must not render below training resolution');

  const live = styled('live-action-cinematic');
  assert.match(live.prompt, /physically plausible materials/, 'default idiom must keep its existing behaviour');
  assert.doesNotMatch(live.prompt, /anime/, 'default idiom must not become anime');

  for (const [name, preset] of Object.entries(STYLE_PRESETS)) {
    for (const key of ['lead', 'tail', 'negative']) {
      assert.equal(typeof preset[key], 'string', `${name}.${key} must be text`);
      assert.ok(preset[key].length > 0, `${name}.${key} must not be empty`);
    }
    assert.ok(preset.steps >= 1 && preset.steps <= 80, `${name}.steps out of range`);
    assert.ok(preset.cfg >= 1 && preset.cfg <= 20, `${name}.cfg out of range`);
    assert.equal(preset.width % 8, 0, `${name}.width must be a multiple of 8`);
    assert.equal(preset.height % 8, 0, `${name}.height must be a multiple of 8`);
  }
}

// A diffusion model does not process negation in the positive conditioning:
// asking for "no typography" there puts typography into the conditioning and
// makes on-screen text MORE likely. Exclusions must live in the negative
// prompt, which is what actually suppresses them.
{
  const { STYLE_PRESETS, BASE_NEGATIVE_PROMPT } = sceneGenerationInternals;

  for (const [name, preset] of Object.entries(STYLE_PRESETS)) {
    for (const phrase of ['no ', 'without ', 'avoid ', 'not ']) {
      assert.ok(
        !preset.lead.includes(phrase) && !preset.tail.includes(phrase),
        `${name} puts the negation "${phrase.trim()}" in the positive prompt; move it to the preset negative`,
      );
    }
  }

  // The exclusions that keep rendered frames usable as film frames.
  for (const term of ['text', 'typography', 'subtitles', 'watermark', 'logo', 'ui overlay', 'hud', 'timecode']) {
    assert.ok(
      BASE_NEGATIVE_PROMPT.includes(term),
      `base negative prompt must exclude "${term}"`,
    );
  }
}

console.log('scene generation prompt polarity check: passed');
console.log('scene generation style preset check: passed');
