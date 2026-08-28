export const DEV_SEED_COMMANDS = [
  {
    type: 'node.create',
    node: {
      id: 'series.afterlight',
      kind: 'series',
      title: 'Afterlight',
      approval: 'approved',
      metadata: { genre: 'neo-noir thriller', visualLanguage: 'restrained cinematic realism' },
    },
  },
  {
    type: 'node.create',
    node: {
      id: 'episode.001',
      kind: 'episode',
      title: 'The Last Signal',
      approval: 'approved',
      metadata: { episodeNumber: '1', targetDurationSeconds: '1104' },
    },
  },
  {
    type: 'node.create',
    node: {
      id: 'character.mira',
      kind: 'character',
      title: 'Mira',
      approval: 'approved',
      locked: true,
      metadata: { role: 'lead', identity: 'locked', voice: 'mira-v1' },
    },
  },
  {
    type: 'node.create',
    node: {
      id: 'location.cafe',
      kind: 'location',
      title: 'Mirrored Cafe',
      approval: 'approved',
      metadata: { city: 'Istanbul', time: 'night', atmosphere: 'wet neon / restrained' },
    },
  },
  ...[
    ['scene.01', '1', 'Cold Open', 'locked', '72'],
    ['scene.02', '2', 'The Unmarked Call', 'approved', '96'],
    ['scene.03', '3', 'The Mirrored Cafe', 'review', '64'],
    ['scene.04', '4', 'Underground Passage', 'draft', '88'],
    ['scene.05', '5', 'The Last Signal', 'draft', '112'],
  ].map(([id, index, title, approval, durationSeconds]) => ({
    type: 'node.create',
    node: {
      id,
      kind: 'scene',
      title,
      approval,
      locked: approval === 'locked',
      metadata: {
        index,
        durationSeconds,
        summary: id === 'scene.03'
          ? 'Mira notices a follower only through a reflection; the reveal stays indirect.'
          : 'Episode structure placeholder owned by the native project graph.',
      },
    },
  })),
  {
    type: 'node.create',
    node: {
      id: 'shot.031',
      kind: 'shot',
      title: 'Reflection Reveal',
      approval: 'review',
      metadata: {
        sceneIndex: '3',
        durationSeconds: '5.2',
        framing: 'close-up',
        camera: 'slow push-in',
        generationStrategy: 'I2V',
        identityPriority: 'high',
      },
    },
  },
  {
    type: 'node.create',
    node: {
      id: 'generation.031',
      kind: 'generation',
      title: 'Shot 031 Synthesis',
      approval: 'draft',
      metadata: { status: 'ready', mode: 'I2V', qualityTarget: '0.91' },
    },
  },
  { type: 'dependency.add', dependent: 'episode.001', dependency: 'series.afterlight' },
  ...['scene.01', 'scene.02', 'scene.03', 'scene.04', 'scene.05'].map((scene) => ({
    type: 'dependency.add', dependent: scene, dependency: 'episode.001',
  })),
  { type: 'dependency.add', dependent: 'scene.03', dependency: 'character.mira' },
  { type: 'dependency.add', dependent: 'scene.03', dependency: 'location.cafe' },
  { type: 'dependency.add', dependent: 'shot.031', dependency: 'scene.03' },
  { type: 'dependency.add', dependent: 'shot.031', dependency: 'character.mira' },
  { type: 'dependency.add', dependent: 'shot.031', dependency: 'location.cafe' },
  { type: 'dependency.add', dependent: 'generation.031', dependency: 'shot.031' },
];
