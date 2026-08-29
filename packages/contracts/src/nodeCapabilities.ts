import type { ProjectNodeKind } from './index';

export type NodeExecutionRole = 'scope' | 'creative-anchor' | 'production-unit' | 'execution' | 'artifact';
export type NodeMetadataFieldType = 'text' | 'multiline' | 'number' | 'enum' | 'boolean' | 'duration' | 'seed' | 'language' | 'path';
export type NodeMetadataScope = 'creative' | 'production' | 'runtime' | 'provenance';

export interface NodeMetadataFieldSpec {
  key: string;
  label: string;
  type: NodeMetadataFieldType;
  scope: NodeMetadataScope;
  description: string;
  defaultValue?: string;
  placeholder?: string;
  options?: readonly string[];
  requiredFor?: 'preview' | 'final';
}

export interface ProjectNodeCapability {
  kind: ProjectNodeKind;
  label: string;
  role: NodeExecutionRole;
  purpose: string;
  primaryOutput: string;
  consumes: readonly ProjectNodeKind[];
  produces: readonly ProjectNodeKind[];
  invariants: readonly string[];
  fields: readonly NodeMetadataFieldSpec[];
}

const field = (
  key: string,
  label: string,
  type: NodeMetadataFieldType,
  scope: NodeMetadataScope,
  description: string,
  extra: Omit<NodeMetadataFieldSpec, 'key' | 'label' | 'type' | 'scope' | 'description'> = {},
): NodeMetadataFieldSpec => ({ key, label, type, scope, description, ...extra });

export const PROJECT_NODE_CAPABILITIES: Record<ProjectNodeKind, ProjectNodeCapability> = {
  series: {
    kind: 'series',
    label: 'Series Bible',
    role: 'scope',
    purpose: 'Canonical creative constitution shared by every episode: visual language, language, format, continuity policy and master production defaults.',
    primaryOutput: 'A stable series-level production bible inherited by episodes, scenes and shots.',
    consumes: [],
    produces: ['episode', 'character', 'location'],
    invariants: [
      'One canonical Series should own an Episode.',
      'Series-wide identity and visual-language changes may invalidate downstream production.',
    ],
    fields: [
      field('genre', 'Genre', 'text', 'creative', 'Primary dramatic genre.', { defaultValue: 'cinematic drama' }),
      field('visualLanguage', 'Visual language', 'multiline', 'creative', 'Canonical lighting, lens, palette, texture and realism rules.', { requiredFor: 'preview', defaultValue: 'cinematic realism, coherent lighting, restrained filmic grade' }),
      field('language', 'Dialogue language', 'language', 'creative', 'BCP-47-ish project language used by dialogue and narration.', { defaultValue: 'tr' }),
      field('targetEpisodeMinutes', 'Target episode minutes', 'number', 'production', 'Default finished episode duration.', { defaultValue: '20', requiredFor: 'final' }),
      field('aspectRatio', 'Aspect ratio', 'enum', 'production', 'Master image aspect ratio.', { options: ['16:9', '9:16', '1:1', '2.39:1'], defaultValue: '16:9' }),
      field('fps', 'Master FPS', 'number', 'production', 'Final composition frame rate.', { defaultValue: '24', requiredFor: 'final' }),
      field('masterSeed', 'Master seed', 'seed', 'production', 'Stable deterministic seed namespace for derived shot seeds.', { defaultValue: '1337' }),
      field('contentRating', 'Content rating', 'text', 'creative', 'Creative safety/rating target used during planning.', { defaultValue: 'general' }),
      field('audioStyle', 'Audio style', 'multiline', 'creative', 'Global dialogue, music, ambience and loudness direction.', { defaultValue: 'cinematic dialogue, restrained score, natural ambience' }),
    ],
  },
  episode: {
    kind: 'episode',
    label: 'Episode Master',
    role: 'scope',
    purpose: 'One renderable story deliverable. Owns scene ordering, target runtime and the final composition/export contract.',
    primaryOutput: 'One assembled episode master plus render manifest.',
    consumes: ['series'],
    produces: ['scene', 'generation', 'asset'],
    invariants: [
      'An Episode belongs to exactly one Series.',
      'Final duration is derived from scene/shot/audio timing rather than a single long model generation.',
    ],
    fields: [
      field('episodeNumber', 'Episode number', 'number', 'creative', 'Human ordering within the Series.', { defaultValue: '1' }),
      field('targetDurationSeconds', 'Target duration', 'duration', 'production', 'Desired final runtime in seconds.', { defaultValue: '1200', requiredFor: 'final' }),
      field('synopsis', 'Synopsis', 'multiline', 'creative', 'Episode-level story summary.'),
      field('dramaticArc', 'Dramatic arc', 'multiline', 'creative', 'Setup, escalation, climax and resolution intent.'),
      field('pace', 'Pace', 'enum', 'creative', 'Global edit rhythm.', { options: ['slow', 'measured', 'balanced', 'fast', 'kinetic'], defaultValue: 'balanced' }),
      field('renderProfile', 'Render profile', 'enum', 'production', 'Master delivery profile.', { options: ['preview-720p', 'master-1080p', 'master-1440p', 'master-4k'], defaultValue: 'preview-720p' }),
      field('soundtrackPolicy', 'Soundtrack policy', 'multiline', 'production', 'How score, ambience and dialogue are balanced and reused.'),
      field('subtitlePolicy', 'Subtitle policy', 'enum', 'production', 'Subtitle output behavior.', { options: ['none', 'burn-in', 'sidecar', 'both'], defaultValue: 'sidecar' }),
    ],
  },
  scene: {
    kind: 'scene',
    label: 'Scene',
    role: 'production-unit',
    purpose: 'Narrative and continuity block. Converts one dramatic beat into ordered shots plus dialogue, ambience and transition intent.',
    primaryOutput: 'A scene package containing shot media, timed audio and scene-level continuity state.',
    consumes: ['episode', 'character', 'location', 'audio', 'asset'],
    produces: ['shot', 'audio', 'generation', 'asset'],
    invariants: [
      'A final Scene has at least one Shot.',
      'Scene ownership of Shots must be unambiguous.',
      'Location and Character dependencies are semantic anchors, not copied prompt text.',
    ],
    fields: [
      field('index', 'Scene index', 'number', 'creative', 'Scene ordering inside the Episode.', { defaultValue: '1' }),
      field('durationSeconds', 'Target duration', 'duration', 'production', 'Scene timing budget.', { defaultValue: '45', requiredFor: 'final' }),
      field('summary', 'Scene summary', 'multiline', 'creative', 'What visibly/narratively happens.', { requiredFor: 'preview' }),
      field('dramaticGoal', 'Dramatic goal', 'multiline', 'creative', 'What must change by the end of the Scene.'),
      field('beat', 'Story beat', 'text', 'creative', 'Compact beat label such as reveal, confrontation or release.'),
      field('pace', 'Scene pace', 'enum', 'creative', 'Scene-level edit tempo.', { options: ['slow', 'measured', 'balanced', 'fast', 'kinetic'], defaultValue: 'balanced' }),
      field('timeOfDay', 'Time of day', 'text', 'creative', 'Scene-local time/lighting override.'),
      field('weather', 'Weather', 'text', 'creative', 'Scene-local environment condition.'),
      field('transitionIn', 'Transition in', 'enum', 'production', 'Composition transition entering the Scene.', { options: ['cut', 'fade', 'dip-black', 'dissolve', 'match-cut'], defaultValue: 'cut' }),
      field('transitionOut', 'Transition out', 'enum', 'production', 'Composition transition leaving the Scene.', { options: ['cut', 'fade', 'dip-black', 'dissolve', 'match-cut'], defaultValue: 'cut' }),
      field('generationPolicy', 'Generation policy', 'enum', 'production', 'Default strategy selector for child Shots.', { options: ['hybrid', 'mostly-stills', 'mostly-i2v', 'full-video'], defaultValue: 'hybrid' }),
      field('dialogueBudgetSeconds', 'Dialogue budget', 'duration', 'production', 'Approximate spoken-content budget used for pacing.'),
    ],
  },
  shot: {
    kind: 'shot',
    label: 'Shot',
    role: 'production-unit',
    purpose: 'Smallest visual editorial unit. It is the contract sent to image/video generation and later placed on the episode timeline.',
    primaryOutput: 'One time-bounded visual clip or animated still with deterministic provenance.',
    consumes: ['scene', 'character', 'location', 'asset', 'audio'],
    produces: ['generation', 'asset'],
    invariants: [
      'A final Shot has a positive duration.',
      'Generation strategy is explicit.',
      'Character/location continuity is referenced through dependencies.',
    ],
    fields: [
      field('index', 'Shot index', 'number', 'creative', 'Ordering inside the owning Scene.', { defaultValue: '1' }),
      field('durationSeconds', 'Duration', 'duration', 'production', 'Editorial duration in seconds.', { defaultValue: '5', requiredFor: 'final' }),
      field('purpose', 'Shot purpose', 'text', 'creative', 'Narrative reason the Shot exists: establish, reaction, reveal, action, insert, etc.'),
      field('framing', 'Framing', 'enum', 'creative', 'Camera framing.', { options: ['extreme-wide', 'wide', 'medium-wide', 'medium', 'medium-close', 'close-up', 'extreme-close-up', 'insert'], defaultValue: 'medium' }),
      field('camera', 'Camera movement', 'text', 'creative', 'Static, handheld, dolly, pan, tilt, orbit, push-in, rack-focus, etc.', { defaultValue: 'static' }),
      field('subjectAction', 'Subject action', 'multiline', 'creative', 'Visible action that must occur during the Shot.'),
      field('motionLevel', 'Motion level', 'enum', 'production', 'Motion complexity used to choose still-motion vs I2V/video.', { options: ['none', 'low', 'medium', 'high'], defaultValue: 'low' }),
      field('generationStrategy', 'Generation strategy', 'enum', 'production', 'Concrete media synthesis mode.', { options: ['STILL_MOTION', 'T2I', 'I2V', 'VIDEO', 'COMPOSITE'], defaultValue: 'STILL_MOTION', requiredFor: 'preview' }),
      field('qualityTier', 'Quality tier', 'enum', 'production', 'Controls steps/resolution/retries.', { options: ['draft', 'preview', 'final'], defaultValue: 'preview' }),
      field('continuityPriority', 'Continuity priority', 'enum', 'production', 'How aggressively identity/location anchors constrain regeneration.', { options: ['low', 'medium', 'high', 'critical'], defaultValue: 'high' }),
      field('seed', 'Shot seed', 'seed', 'production', 'Explicit deterministic seed. If empty it is derived from the Series master seed and Shot id.'),
      field('promptOverride', 'Prompt override', 'multiline', 'creative', 'Optional user-authored visual additions without replacing canonical anchors.'),
      field('negativePrompt', 'Negative prompt', 'multiline', 'production', 'Shot-specific exclusions.'),
      field('transitionOut', 'Transition out', 'enum', 'production', 'Editorial transition after this Shot.', { options: ['cut', 'fade', 'dissolve', 'match-cut'], defaultValue: 'cut' }),
      field('reusePolicy', 'Reuse policy', 'enum', 'production', 'Whether a generated result may be reused as an establishing/loop asset.', { options: ['unique', 'allow-reuse', 'prefer-reuse'], defaultValue: 'unique' }),
    ],
  },
  character: {
    kind: 'character',
    label: 'Character Anchor',
    role: 'creative-anchor',
    purpose: 'Canonical identity and performance anchor shared across every Scene and Shot where the Character appears.',
    primaryOutput: 'Stable visual identity, voice identity and performance constraints.',
    consumes: ['asset'],
    produces: ['shot', 'audio', 'generation'],
    invariants: [
      'Identity anchors are shared, not copied per episode.',
      'Locked Character changes require explicit unlock and may invalidate every dependent Shot/Audio node.',
    ],
    fields: [
      field('role', 'Role', 'text', 'creative', 'Lead, supporting, antagonist, narrator, etc.'),
      field('description', 'Character description', 'multiline', 'creative', 'Canonical human-readable identity description.'),
      field('appearancePrompt', 'Appearance anchor', 'multiline', 'creative', 'Stable generation-facing appearance description.', { requiredFor: 'preview' }),
      field('wardrobe', 'Default wardrobe', 'multiline', 'creative', 'Canonical wardrobe and allowed variations.'),
      field('agePresentation', 'Age presentation', 'text', 'creative', 'Visual age range/presentation when relevant.'),
      field('performanceStyle', 'Performance style', 'multiline', 'creative', 'Gesture, expression and acting direction.'),
      field('identitySeed', 'Identity seed', 'seed', 'production', 'Stable seed namespace for identity references.'),
      field('voiceProvider', 'Voice provider', 'enum', 'production', 'Preferred voice synthesis provider.', { options: ['chatterbox', 'piper', 'external'], defaultValue: 'chatterbox' }),
      field('voiceLanguage', 'Voice language', 'language', 'production', 'Character-specific voice language override.'),
      field('voiceReferenceAsset', 'Voice reference asset', 'path', 'production', 'Approved short reference audio asset for voice conditioning.'),
      field('voiceExaggeration', 'Voice expression', 'number', 'production', 'Provider-neutral expression intensity.', { defaultValue: '0.5' }),
      field('voiceCfg', 'Voice CFG', 'number', 'production', 'Provider-neutral voice similarity/accent guidance.', { defaultValue: '0.5' }),
    ],
  },
  location: {
    kind: 'location',
    label: 'Location Anchor',
    role: 'creative-anchor',
    purpose: 'Reusable environment continuity anchor: geography, layout, materials, palette, lighting and atmosphere.',
    primaryOutput: 'Stable environment prompt/reference bundle reused by dependent Scenes and Shots.',
    consumes: ['asset'],
    produces: ['scene', 'shot', 'generation'],
    invariants: ['Location continuity should survive camera changes and episode boundaries.'],
    fields: [
      field('description', 'Location description', 'multiline', 'creative', 'Canonical spatial/environment description.'),
      field('environmentPrompt', 'Environment anchor', 'multiline', 'creative', 'Generation-facing stable environment description.', { requiredFor: 'preview' }),
      field('city', 'City / region', 'text', 'creative', 'Geographic context.'),
      field('time', 'Default time', 'text', 'creative', 'Default time-of-day lighting.'),
      field('weather', 'Default weather', 'text', 'creative', 'Canonical ambient weather.'),
      field('lighting', 'Lighting', 'multiline', 'creative', 'Key/fill/practical lighting and contrast rules.'),
      field('palette', 'Palette', 'text', 'creative', 'Dominant environment color palette.'),
      field('lensLanguage', 'Lens language', 'text', 'creative', 'Preferred lens/focal character for this location.'),
      field('continuitySeed', 'Continuity seed', 'seed', 'production', 'Stable seed namespace for environment references.'),
      field('referencePolicy', 'Reference policy', 'enum', 'production', 'How aggressively reference images are reused.', { options: ['prompt-only', 'prefer-reference', 'require-reference'], defaultValue: 'prefer-reference' }),
    ],
  },
  asset: {
    kind: 'asset',
    label: 'Asset',
    role: 'artifact',
    purpose: 'Durable imported or generated media/reference artifact with integrity, provenance and reuse metadata.',
    primaryOutput: 'Addressable media that other semantic/execution nodes can safely depend on.',
    consumes: ['generation'],
    produces: ['character', 'location', 'scene', 'shot', 'audio'],
    invariants: ['Generated assets should carry provider/model/seed provenance and content integrity metadata.'],
    fields: [
      field('mediaType', 'Media type', 'enum', 'provenance', 'Physical asset media type.', { options: ['image', 'video', 'audio', 'subtitle', 'json', 'other'], requiredFor: 'final' }),
      field('role', 'Asset role', 'text', 'creative', 'character-reference, location-reference, shot-output, music-bed, etc.'),
      field('relativePath', 'Relative path', 'path', 'provenance', 'Project-managed artifact path.'),
      field('sha256', 'SHA-256', 'text', 'provenance', 'Content integrity hash.'),
      field('mimeType', 'MIME type', 'text', 'provenance', 'Detected media MIME type.'),
      field('durationSeconds', 'Duration', 'duration', 'provenance', 'Media duration if temporal.'),
      field('width', 'Width', 'number', 'provenance', 'Pixel width for visual media.'),
      field('height', 'Height', 'number', 'provenance', 'Pixel height for visual media.'),
      field('source', 'Source', 'text', 'provenance', 'imported, generated, recorded or derived.'),
      field('license', 'License / rights', 'text', 'provenance', 'Rights metadata for imported/reusable media.'),
      field('generatedBy', 'Generated by', 'text', 'provenance', 'Generation node id when produced by Make & Watch.'),
    ],
  },
  audio: {
    kind: 'audio',
    label: 'Audio Cue',
    role: 'production-unit',
    purpose: 'Semantic timed audio unit: dialogue, narration, ambience, music or SFX. Dialogue timing can drive Shot and Scene duration.',
    primaryOutput: 'Timed WAV/media asset plus mix instructions and optional subtitle timing.',
    consumes: ['character', 'scene', 'shot', 'asset'],
    produces: ['generation', 'asset', 'shot'],
    invariants: [
      'Dialogue speaker identity should be a Character dependency rather than free text only.',
      'Final audio has an explicit kind and timeline ownership.',
    ],
    fields: [
      field('kind', 'Audio kind', 'enum', 'creative', 'Semantic role in the mix.', { options: ['dialogue', 'narration', 'ambience', 'music', 'sfx'], defaultValue: 'dialogue', requiredFor: 'preview' }),
      field('text', 'Spoken text / cue', 'multiline', 'creative', 'Dialogue/narration text or sound cue description.'),
      field('language', 'Language', 'language', 'production', 'Speech language.', { defaultValue: 'tr' }),
      field('provider', 'Provider', 'enum', 'runtime', 'TTS/audio provider.', { options: ['chatterbox', 'piper', 'imported', 'procedural'], defaultValue: 'chatterbox' }),
      field('voiceReferenceAsset', 'Voice reference asset', 'path', 'production', 'Approved voice-conditioning reference.'),
      field('startSeconds', 'Timeline start', 'duration', 'production', 'Optional explicit start offset in owning Scene/Shot.'),
      field('durationSeconds', 'Measured duration', 'duration', 'provenance', 'Synthesized/imported duration used by timeline compilation.'),
      field('volumeDb', 'Volume dB', 'number', 'production', 'Mix gain before normalization.', { defaultValue: '0' }),
      field('duckingDb', 'Ducking dB', 'number', 'production', 'How much competing beds should duck under this cue.', { defaultValue: '-8' }),
      field('exaggeration', 'Expression', 'number', 'production', 'TTS expression intensity.', { defaultValue: '0.5' }),
      field('cfgWeight', 'Voice guidance', 'number', 'production', 'TTS voice/accent guidance strength.', { defaultValue: '0.5' }),
      field('subtitle', 'Subtitle enabled', 'boolean', 'production', 'Whether this spoken cue emits subtitle timing.', { defaultValue: 'true' }),
      field('status', 'Status', 'enum', 'runtime', 'Audio production state.', { options: ['draft', 'queued', 'generating', 'ready', 'failed'], defaultValue: 'draft' }),
    ],
  },
  generation: {
    kind: 'generation',
    label: 'Generation Attempt',
    role: 'execution',
    purpose: 'Immutable-ish execution/provenance record for one concrete image, video, audio or composition attempt.',
    primaryOutput: 'A traceable attempt linking provider/model/parameters to produced Assets.',
    consumes: ['shot', 'scene', 'audio', 'character', 'location', 'asset'],
    produces: ['asset'],
    invariants: [
      'Semantic intent lives on Scene/Shot/Audio; Generation records execution state.',
      'Successful attempts retain provider, model, seed/parameters and artifact linkage.',
    ],
    fields: [
      field('targetKind', 'Target kind', 'text', 'provenance', 'scene, shot, audio or episode.'),
      field('targetId', 'Target id', 'text', 'provenance', 'Semantic target id.'),
      field('mediaType', 'Media type', 'enum', 'provenance', 'Generated media class.', { options: ['image', 'video', 'audio', 'composition'], defaultValue: 'image' }),
      field('provider', 'Provider', 'text', 'runtime', 'comfyui, chatterbox, remotion, ffmpeg, etc.', { requiredFor: 'preview' }),
      field('model', 'Model', 'text', 'runtime', 'Resolved model/checkpoint/version.'),
      field('strategy', 'Strategy', 'text', 'runtime', 'Resolved production strategy.'),
      field('status', 'Status', 'enum', 'runtime', 'Execution state.', { options: ['queued', 'running', 'ready', 'failed', 'cancelled'], defaultValue: 'queued' }),
      field('seed', 'Seed', 'seed', 'provenance', 'Resolved deterministic generation seed.'),
      field('promptHash', 'Prompt hash', 'text', 'provenance', 'Hash of fully compiled prompt/inputs.'),
      field('artifactPath', 'Artifact path', 'path', 'provenance', 'Primary produced artifact.'),
      field('artifactSha256', 'Artifact SHA-256', 'text', 'provenance', 'Primary artifact integrity hash.'),
      field('startedAt', 'Started at', 'text', 'provenance', 'UTC execution start.'),
      field('completedAt', 'Completed at', 'text', 'provenance', 'UTC execution completion.'),
      field('error', 'Error', 'multiline', 'runtime', 'Bounded failure detail when status is failed.'),
    ],
  },
};

export function defaultMetadataForKind(kind: ProjectNodeKind): Record<string, string> {
  return Object.fromEntries(
    PROJECT_NODE_CAPABILITIES[kind].fields
      .filter((candidate) => candidate.defaultValue !== undefined)
      .map((candidate) => [candidate.key, candidate.defaultValue as string]),
  );
}

export function nodeCapability(kind: ProjectNodeKind): ProjectNodeCapability {
  return PROJECT_NODE_CAPABILITIES[kind];
}
