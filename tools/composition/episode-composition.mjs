const MAX_SCENES = 256;
const MAX_SHOTS = 4096;
const MAX_AUDIO_CUES = 4096;

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nodeById(snapshot, id) {
  return snapshot.nodes.find((node) => node.id === id) ?? null;
}

function dependenciesOf(snapshot, id) {
  return snapshot.dependencies
    .filter((edge) => edge.dependent === id)
    .map((edge) => nodeById(snapshot, edge.dependency))
    .filter(Boolean);
}

function dependentsOf(snapshot, id) {
  return snapshot.dependencies
    .filter((edge) => edge.dependency === id)
    .map((edge) => nodeById(snapshot, edge.dependent))
    .filter(Boolean);
}

function sorted(nodes) {
  return [...nodes].sort((left, right) => {
    const a = numeric(left.metadata.index ?? left.metadata.shotNumber, Number.MAX_SAFE_INTEGER);
    const b = numeric(right.metadata.index ?? right.metadata.shotNumber, Number.MAX_SAFE_INTEGER);
    return a === b ? left.id.localeCompare(right.id) : a - b;
  });
}

function profileFor(episode, series) {
  const profile = episode.metadata.renderProfile || 'preview-720p';
  const fps = Math.max(1, Math.min(120, numeric(series?.metadata?.fps, 24)));
  const dimensions = {
    'preview-720p': [1280, 720],
    'master-1080p': [1920, 1080],
    'master-1440p': [2560, 1440],
    'master-4k': [3840, 2160],
  }[profile] ?? [1280, 720];
  return { name: profile, width: dimensions[0], height: dimensions[1], fps };
}

function readyGenerationsFor(snapshot, semanticId, mediaType) {
  return dependentsOf(snapshot, semanticId)
    .filter((node) => node.kind === 'generation')
    .filter((node) => node.metadata.status === 'ready')
    .filter((node) => !mediaType || node.metadata.mediaType === mediaType)
    .sort((a, b) => b.revision - a.revision || b.id.localeCompare(a.id));
}

function assetForGeneration(snapshot, generation, acceptedTypes) {
  if (!generation) return null;
  const candidates = dependentsOf(snapshot, generation.id)
    .filter((node) => node.kind === 'asset')
    .filter((node) => !node.stale)
    .filter((node) => acceptedTypes.includes(node.metadata.mediaType));
  return candidates[0] ?? null;
}

function mediaForShot(snapshot, shot) {
  const strategy = shot.metadata.generationStrategy || '';
  const preferred = strategy === 'VIDEO' || strategy === 'I2V' ? ['video', 'image'] : ['image', 'video'];
  for (const type of preferred) {
    const generation = readyGenerationsFor(snapshot, shot.id, type)[0];
    const asset = assetForGeneration(snapshot, generation, [type]);
    if (asset) return { generation, asset };
  }
  return { generation: null, asset: null };
}

function mediaForAudio(snapshot, audio) {
  const generation = readyGenerationsFor(snapshot, audio.id, 'audio')[0];
  return { generation, asset: assetForGeneration(snapshot, generation, ['audio']) };
}

function toProjectMedia(asset) {
  if (!asset) return null;
  return {
    assetId: asset.id,
    mediaType: asset.metadata.mediaType,
    relativePath: asset.metadata.relativePath || '',
    mimeType: asset.metadata.mimeType || '',
    sha256: asset.metadata.sha256 || '',
    width: numeric(asset.metadata.width, 0),
    height: numeric(asset.metadata.height, 0),
    durationSeconds: numeric(asset.metadata.durationSeconds, 0),
  };
}

function frame(seconds, fps) {
  return Math.max(0, Math.round(seconds * fps));
}

export function compileEpisodeComposition(snapshot, episodeId) {
  if (!snapshot || !Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.dependencies)) {
    throw new Error('valid project snapshot is required');
  }
  const episode = nodeById(snapshot, episodeId);
  if (!episode || episode.kind !== 'episode') throw new Error('episode node was not found');
  const seriesOwners = dependenciesOf(snapshot, episode.id).filter((node) => node.kind === 'series');
  const series = seriesOwners.length === 1 ? seriesOwners[0] : null;
  const profile = profileFor(episode, series);
  const issues = [];
  const warnings = [];
  if (seriesOwners.length !== 1) issues.push(`Episode must depend on exactly one Series; found ${seriesOwners.length}.`);

  const scenes = sorted(dependentsOf(snapshot, episode.id).filter((node) => node.kind === 'scene'));
  if (scenes.length === 0) issues.push('Episode has no Scene nodes.');
  if (scenes.length > MAX_SCENES) issues.push(`Episode exceeds ${MAX_SCENES} Scene composition bound.`);

  let episodeCursor = 0;
  let totalShots = 0;
  let totalAudioCues = 0;
  const sceneManifest = [];

  for (const scene of scenes.slice(0, MAX_SCENES)) {
    const shots = sorted(dependentsOf(snapshot, scene.id).filter((node) => node.kind === 'shot'));
    totalShots += shots.length;
    if (shots.length === 0) issues.push(`Scene ${scene.id} has no Shots.`);
    if (totalShots > MAX_SHOTS) {
      issues.push(`Episode exceeds ${MAX_SHOTS} Shot composition bound.`);
      break;
    }

    const sceneStart = episodeCursor;
    let shotCursor = 0;
    const shotManifest = shots.map((shot) => {
      const durationSeconds = numeric(shot.metadata.durationSeconds, 0);
      if (!(durationSeconds > 0)) issues.push(`Shot ${shot.id} has invalid duration.`);
      const strategy = shot.metadata.generationStrategy || '';
      if (!strategy) issues.push(`Shot ${shot.id} has no generationStrategy.`);
      const { generation, asset } = mediaForShot(snapshot, shot);
      if (!asset) issues.push(`Shot ${shot.id} has no ready generated visual Asset.`);
      const startSeconds = sceneStart + shotCursor;
      const safeDuration = Math.max(0, durationSeconds);
      shotCursor += safeDuration;
      return {
        id: shot.id,
        title: shot.title,
        index: numeric(shot.metadata.index ?? shot.metadata.shotNumber, 0),
        strategy,
        purpose: shot.metadata.purpose || '',
        framing: shot.metadata.framing || '',
        camera: shot.metadata.camera || '',
        motionLevel: shot.metadata.motionLevel || 'low',
        transitionOut: shot.metadata.transitionOut || 'cut',
        startSeconds,
        durationSeconds: safeDuration,
        startFrame: frame(startSeconds, profile.fps),
        durationInFrames: Math.max(1, frame(safeDuration, profile.fps)),
        generationId: generation?.id ?? null,
        media: toProjectMedia(asset),
      };
    });

    const audioNodes = sorted(dependentsOf(snapshot, scene.id).filter((node) => node.kind === 'audio'));
    totalAudioCues += audioNodes.length;
    if (totalAudioCues > MAX_AUDIO_CUES) issues.push(`Episode exceeds ${MAX_AUDIO_CUES} Audio cue composition bound.`);
    let implicitAudioCursor = 0;
    const audioManifest = audioNodes.slice(0, Math.max(0, MAX_AUDIO_CUES - (totalAudioCues - audioNodes.length))).map((audio) => {
      const { generation, asset } = mediaForAudio(snapshot, audio);
      const kind = audio.metadata.kind || 'dialogue';
      const durationSeconds = numeric(asset?.metadata.durationSeconds ?? audio.metadata.durationSeconds, 0);
      if ((kind === 'dialogue' || kind === 'narration') && !asset) issues.push(`Audio ${audio.id} has no ready generated audio Asset.`);
      const explicitStart = audio.metadata.startSeconds;
      const localStart = explicitStart === undefined || explicitStart === '' ? implicitAudioCursor : Math.max(0, numeric(explicitStart, 0));
      if (explicitStart === undefined || explicitStart === '') implicitAudioCursor = localStart + Math.max(0, durationSeconds);
      const startSeconds = sceneStart + localStart;
      return {
        id: audio.id,
        title: audio.title,
        kind,
        text: audio.metadata.text || '',
        language: audio.metadata.language || series?.metadata.language || 'tr',
        startSeconds,
        durationSeconds: Math.max(0, durationSeconds),
        startFrame: frame(startSeconds, profile.fps),
        volumeDb: numeric(audio.metadata.volumeDb, 0),
        duckingDb: numeric(audio.metadata.duckingDb, -8),
        subtitle: audio.metadata.subtitle !== 'false',
        generationId: generation?.id ?? null,
        media: toProjectMedia(asset),
      };
    });

    const declaredSceneDuration = numeric(scene.metadata.durationSeconds, 0);
    const visualDuration = shotCursor;
    const audioDuration = audioManifest.reduce((maximum, cue) => Math.max(maximum, cue.startSeconds - sceneStart + cue.durationSeconds), 0);
    const naturalDuration = Math.max(visualDuration, audioDuration);
    const sceneDuration = declaredSceneDuration > 0 ? Math.max(declaredSceneDuration, naturalDuration) : naturalDuration;
    if (declaredSceneDuration > 0 && visualDuration > declaredSceneDuration + 0.05) {
      warnings.push(`Scene ${scene.id} Shots exceed declared Scene duration by ${(visualDuration - declaredSceneDuration).toFixed(2)}s.`);
    }
    if (sceneDuration <= 0) issues.push(`Scene ${scene.id} has no positive composition duration.`);

    sceneManifest.push({
      id: scene.id,
      title: scene.title,
      index: numeric(scene.metadata.index, 0),
      summary: scene.metadata.summary || '',
      transitionIn: scene.metadata.transitionIn || 'cut',
      transitionOut: scene.metadata.transitionOut || 'cut',
      startSeconds: sceneStart,
      durationSeconds: sceneDuration,
      startFrame: frame(sceneStart, profile.fps),
      durationInFrames: Math.max(1, frame(sceneDuration, profile.fps)),
      shots: shotManifest,
      audio: audioManifest,
    });
    episodeCursor += sceneDuration;
  }

  const targetDurationSeconds = numeric(episode.metadata.targetDurationSeconds, numeric(series?.metadata.targetEpisodeMinutes, 20) * 60);
  const delta = targetDurationSeconds - episodeCursor;
  const tolerance = Math.max(3, targetDurationSeconds * 0.02);
  if (Math.abs(delta) > tolerance) {
    warnings.push(`Composition runtime is ${episodeCursor.toFixed(1)}s vs target ${targetDurationSeconds.toFixed(1)}s (${delta >= 0 ? '+' : ''}${delta.toFixed(1)}s remaining).`);
  }

  return {
    schemaVersion: 1,
    projectRevision: snapshot.projectRevision,
    episode: {
      id: episode.id,
      title: episode.title,
      seriesId: series?.id ?? null,
      seriesTitle: series?.title ?? '',
      targetDurationSeconds,
      durationSeconds: episodeCursor,
      durationInFrames: Math.max(1, frame(episodeCursor, profile.fps)),
    },
    profile,
    scenes: sceneManifest,
    stats: {
      sceneCount: sceneManifest.length,
      shotCount: totalShots,
      audioCueCount: totalAudioCues,
      generatedVisualCount: sceneManifest.flatMap((scene) => scene.shots).filter((shot) => shot.media).length,
      generatedAudioCount: sceneManifest.flatMap((scene) => scene.audio).filter((cue) => cue.media).length,
    },
    issues,
    warnings,
    ready: issues.length === 0,
  };
}
