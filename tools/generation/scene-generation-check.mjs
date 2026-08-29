import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SceneGenerationService } from './scene-generation-service.mjs';

function baseSnapshot() {
  return {
    schemaVersion: 1,
    projectRevision: 7,
    nodes: [
      { id: 'series.demo', kind: 'series', title: 'Demo', metadata: { genre: 'thriller', visualLanguage: 'cinematic realism' }, revision: 1, approval: 'approved', locked: false, stale: false },
      { id: 'episode.001', kind: 'episode', title: 'Pilot', metadata: {}, revision: 1, approval: 'approved', locked: false, stale: false },
      { id: 'scene.001', kind: 'scene', title: 'First Scene', metadata: { summary: 'A lone traveler enters a rain-soaked station.' }, revision: 1, approval: 'approved', locked: false, stale: false },
      { id: 'shot.001', kind: 'shot', title: 'Arrival', metadata: { framing: 'wide', camera: 'slow dolly', durationSeconds: '4', generationStrategy: 'T2I-preview' }, revision: 1, approval: 'approved', locked: false, stale: false },
      { id: 'location.station', kind: 'location', title: 'Old Station', metadata: { city: 'Istanbul', time: 'night', atmosphere: 'rain' }, revision: 1, approval: 'approved', locked: false, stale: false },
    ],
    dependencies: [
      { dependent: 'episode.001', dependency: 'series.demo' },
      { dependent: 'scene.001', dependency: 'episode.001' },
      { dependent: 'scene.001', dependency: 'location.station' },
      { dependent: 'shot.001', dependency: 'scene.001' },
      { dependent: 'shot.001', dependency: 'location.station' },
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
        this.state.nodes.push({ ...structuredClone(command.node), revision: 1 });
      } else if (command.type === 'dependency.add') {
        if (!this.state.dependencies.some((edge) => edge.dependent === command.dependent && edge.dependency === command.dependency)) {
          this.state.dependencies.push({ dependent: command.dependent, dependency: command.dependency });
        }
      } else if (command.type === 'node.patch') {
        const node = this.state.nodes.find((candidate) => candidate.id === command.id);
        if (!node) throw new Error('fake patch target missing');
        node.metadata = { ...node.metadata, ...(command.metadataUpdates ?? {}) };
        node.revision += 1;
      } else if (command.type === 'node.markFresh') {
        const node = this.state.nodes.find((candidate) => candidate.id === command.id);
        if (node) node.stale = false;
      }
    }
    this.state.projectRevision += 1;
    return { projectRevision: this.state.projectRevision, snapshot: structuredClone(this.state), events: [] };
  }
}

class FakeComfy {
  async capabilities() { return { online: true, checkpoint: 'fake.safetensors', sampler: 'euler', scheduler: 'normal' }; }
  async generateStoryboardFrame(input) {
    assert.match(input.prompt, /First Scene/);
    assert.match(input.prompt, /Arrival/);
    assert.match(input.prompt, /Old Station/);
    return {
      promptId: 'prompt-1',
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
  const service = new SceneGenerationService({ bridge, comfy: new FakeComfy(), artifactRoot: directory });
  const queued = await service.startScene('scene.001');
  assert.equal(queued.status, 'queued');
  const completed = await waitFor(service, queued.id);
  assert.equal(completed.status, 'completed', completed.error);
  assert.equal(completed.completedShots, 1);
  assert.equal(completed.artifacts.length, 1);
  assert.equal(completed.artifacts[0].shotId, 'shot.001');

  const generation = bridge.state.nodes.find((node) => node.id === 'generation.preview.shot.001');
  assert.ok(generation, 'generation node should be durable project state');
  assert.equal(generation.metadata.status, 'ready');
  assert.equal(generation.metadata.provider, 'comfyui');
  assert.ok(bridge.state.dependencies.some((edge) => edge.dependent === generation.id && edge.dependency === 'shot.001'));
  assert.ok(bridge.calls.every((call) => call.context.source === 'scene-storyboard-generation'));

  const manifest = JSON.parse(await readFile(join(directory, 'scene.001', queued.id, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.job.sceneId, 'scene.001');

  bridge.state.nodes.push({ id: 'scene.empty', kind: 'scene', title: 'Empty', metadata: {}, revision: 1, approval: 'draft', locked: false, stale: false });
  await assert.rejects(() => service.startScene('scene.empty'), /no linked shot/);
  console.log('scene generation service check: passed');
} finally {
  await rm(directory, { recursive: true, force: true });
}
