// Shot camera intent -> real rendered motion.
//
// A Shot already carries `camera`, `motionLevel` and `framing`. Until now those
// only reached the image prompt and were discarded at render time, so every
// shot was a frozen still held for its full duration. This module turns that
// same authored intent into actual camera movement over the generated frame.
//
// Two implementation details matter and are easy to get wrong:
//
//  1. ffmpeg's zoompan quantises its crop origin to whole source pixels, so
//     driving it at output size produces visible stair-stepping. Computing the
//     motion on an oversampled canvas and scaling back down makes the same
//     move effectively sub-pixel.
//
//  2. Linear interpolation reads mechanical. Real camera moves ease in and out,
//     so every ramp runs through a smoothstep rather than a straight line.

const MOTION_AMPLITUDE = {
  none: 0,
  low: 0.06,
  medium: 0.11,
  high: 0.18,
};

// How far the frame may drift on a pan/tilt, as a fraction of the headroom the
// zoom created. Staying below 1 keeps the move from ending hard against the
// frame edge, which is what makes a drift read as a camera rather than a slide.
const TRAVEL_FRACTION = 0.82;
const HANDHELD_SWAY = 0.35;
const DEFAULT_OVERSAMPLE = 2;
const MIN_MOTION_SECONDS = 0.2;
const MAX_AMPLITUDE = 0.3;

// Free-text camera direction -> motion kind. Ordered: the first hit wins, so
// specific phrases ("push in") are tested before looser ones ("dolly").
// `ing` is optional throughout because a Director writes "tracking shot" as
// readily as "track in", and a stem that only matches the bare verb silently
// demotes a moving shot to locked off.
const CAMERA_PATTERNS = [
  [/\b(push(ing)?|dolly(ing)?|zoom(ing)?|track(ing)?|creep(ing)?|mov(e|ing))[\s-]?in\b/i, 'push'],
  [/\b(pull(ing)?[\s-]?(out|back)|dolly(ing)?[\s-]?out|zoom(ing)?[\s-]?out|track(ing)?[\s-]?out|retreat(ing)?|reveal)\b/i, 'pull'],
  [/\b(orbit(ing)?|arc(ing)?|circl(e|ing)|revolv(e|ing))\b/i, 'orbit'],
  [/\b(hand[\s-]?held|shaky|shak(e|ing)|documentary|verite)\b/i, 'handheld'],
  [/\b(pan(ning)?|whip)[\s-]?left\b/i, 'pan-left'],
  [/\b(pan(ning)?|whip)[\s-]?right\b/i, 'pan-right'],
  [/\b(tilt(ing)?[\s-]?up|cran(e|ing)[\s-]?up|boom(ing)?[\s-]?up|ris(e|ing))\b/i, 'tilt-up'],
  [/\b(tilt(ing)?[\s-]?down|cran(e|ing)[\s-]?down|boom(ing)?[\s-]?down|descend(ing)?)\b/i, 'tilt-down'],
  [/\b(pan(ning)?|whip)\b/i, 'pan-right'],
  [/\b(tilt(ing)?|cran(e|ing)|boom(ing)?)\b/i, 'tilt-up'],
  [/\b(dolly(ing)?|track(ing)?|truck(ing)?|travel(l?ing)?|follow(ing)?)\b/i, 'push'],
  [/\b(static|locked|lock[\s-]?off|tripod|still|fixed)\b/i, 'static'],
];

export function classifyCameraMove(camera) {
  const text = String(camera ?? '').trim();
  if (!text) return 'static';
  for (const [pattern, kind] of CAMERA_PATTERNS) {
    if (pattern.test(text)) return kind;
  }
  return 'static';
}

export function motionAmplitude(motionLevel) {
  const key = String(motionLevel ?? '').trim().toLowerCase();
  return Object.hasOwn(MOTION_AMPLITUDE, key) ? MOTION_AMPLITUDE[key] : MOTION_AMPLITUDE.low;
}

function round(value, places = 6) {
  return Number(Number(value).toFixed(places));
}

/**
 * Resolve the motion a Shot should actually receive.
 *
 * `camera` states the intent and `motionLevel` states how far to take it. An
 * explicitly static camera, a motionLevel of none, and a shot too short to
 * carry a move are all honoured as locked off.
 */
export function resolveShotMotion({ camera, motionLevel, durationSeconds }) {
  const kind = classifyCameraMove(camera);
  const duration = Number(durationSeconds);
  if (!Number.isFinite(duration) || duration < MIN_MOTION_SECONDS) {
    return { kind: 'static', amplitude: 0, reason: 'shot is too short to carry a move' };
  }
  if (kind === 'static') return { kind: 'static', amplitude: 0, reason: 'camera is locked off' };

  let amplitude = motionAmplitude(motionLevel);
  if (amplitude === 0) return { kind: 'static', amplitude: 0, reason: 'motionLevel is none' };

  // A long take needs a smaller rate or the move becomes a zoom stunt; a short
  // one needs more amplitude to register at all.
  if (duration > 8) amplitude *= 0.75;
  if (duration < 2) amplitude *= 1.25;

  return { kind, amplitude: round(Math.min(amplitude, MAX_AMPLITUDE)), reason: '' };
}

// smoothstep over normalised progress, so moves ease in and out.
function easedProgress(frames) {
  const progress = '(on/' + frames + ')';
  return '(' + progress + '*' + progress + '*(3-2*' + progress + '))';
}

function zoomExpression(kind, amplitude, frames) {
  const eased = easedProgress(frames);
  const amount = round(amplitude);
  if (kind === 'push') return '1+' + amount + '*' + eased;
  if (kind === 'pull') return round(1 + amplitude) + '-' + amount + '*' + eased;
  if (kind === 'orbit') return round(1 + amplitude * 0.5) + '+' + round(amplitude * 0.25) + '*' + eased;
  // Pans, tilts and handheld need standing headroom to travel inside, so they
  // hold a constant crop rather than changing scale.
  return String(round(1 + amplitude));
}

// Available travel in source pixels at the current zoom, per axis.
const TRAVEL_X = '(iw-iw/zoom)';
const TRAVEL_Y = '(ih-ih/zoom)';
const CENTER_X = '(iw/2-iw/zoom/2)';
const CENTER_Y = '(ih/2-ih/zoom/2)';

function panExpressions(kind, frames, durationSeconds) {
  const eased = easedProgress(frames);
  const travel = round(TRAVEL_FRACTION);
  const edge = round((1 - TRAVEL_FRACTION) / 2);
  const far = round(1 - edge);

  switch (kind) {
    case 'pan-right':
      return { x: TRAVEL_X + '*(' + edge + '+' + travel + '*' + eased + ')', y: CENTER_Y };
    case 'pan-left':
      return { x: TRAVEL_X + '*(' + far + '-' + travel + '*' + eased + ')', y: CENTER_Y };
    case 'tilt-down':
      return { x: CENTER_X, y: TRAVEL_Y + '*(' + edge + '+' + travel + '*' + eased + ')' };
    case 'tilt-up':
      return { x: CENTER_X, y: TRAVEL_Y + '*(' + far + '-' + travel + '*' + eased + ')' };
    case 'orbit': {
      // A quarter turn of lateral travel with a paired vertical bob reads as a
      // camera arcing around the subject rather than sliding past it.
      const quarter = '2*PI*0.25*on/' + frames;
      return {
        x: TRAVEL_X + '*(0.5+0.42*sin(' + quarter + '))',
        y: TRAVEL_Y + '*(0.5+0.12*cos(' + quarter + '))',
      };
    }
    case 'handheld': {
      // Two incommensurable frequencies per axis so the sway never visibly
      // repeats over a shot's length.
      const sway = round(HANDHELD_SWAY * 0.5);
      const cycles = Math.max(1, Number(durationSeconds) / 2.6);
      const wave = (multiplier) => '2*PI*' + round(cycles * multiplier) + '*on/' + frames;
      return {
        x: TRAVEL_X + '*(0.5+' + sway + '*(sin(' + wave(1) + ')*0.6+sin(' + wave(1.7) + ')*0.4))',
        y: TRAVEL_Y + '*(0.5+' + sway + '*(cos(' + wave(0.8) + ')*0.6+cos(' + wave(2.3) + ')*0.4))',
      };
    }
    default:
      return { x: CENTER_X, y: CENTER_Y };
  }
}

/**
 * Build the ffmpeg filter chain that renders one still as a moving shot.
 *
 * Returns null when the Shot should stay locked off, so the caller keeps its
 * cheaper static path rather than paying for a no-op motion pass.
 */
export function buildCameraMotionFilter({
  camera,
  motionLevel,
  durationSeconds,
  fps,
  width,
  height,
  oversample = DEFAULT_OVERSAMPLE,
}) {
  const motion = resolveShotMotion({ camera, motionLevel, durationSeconds });
  if (motion.kind === 'static' || motion.amplitude <= 0) return null;

  const frameRate = Math.max(1, Math.round(Number(fps) || 24));
  const frames = Math.max(2, Math.round(Number(durationSeconds) * frameRate));
  const outputWidth = Math.max(2, Math.round(Number(width)));
  const outputHeight = Math.max(2, Math.round(Number(height)));

  const scale = Math.max(1, Math.min(4, Math.round(oversample)));
  const even = (value) => value - (value % 2);
  const workWidth = even(outputWidth * scale);
  const workHeight = even(outputHeight * scale);

  const zoom = zoomExpression(motion.kind, motion.amplitude, frames);
  const { x, y } = panExpressions(motion.kind, frames, Number(durationSeconds));

  return {
    motion,
    frames,
    workWidth,
    workHeight,
    filter: [
      'scale=' + workWidth + ':' + workHeight + ':force_original_aspect_ratio=increase:flags=bicubic',
      'crop=' + workWidth + ':' + workHeight,
      'setsar=1',
      "zoompan=z='" + zoom + "':x='" + x + "':y='" + y + "':d=1:s=" + workWidth + 'x' + workHeight + ':fps=' + frameRate,
      'scale=' + outputWidth + ':' + outputHeight + ':flags=bicubic',
      'format=yuv420p',
    ].join(','),
  };
}

export const cameraMotionInternals = Object.freeze({
  MOTION_AMPLITUDE,
  TRAVEL_FRACTION,
  MAX_AMPLITUDE,
  CAMERA_PATTERNS,
  zoomExpression,
  panExpressions,
  easedProgress,
});
