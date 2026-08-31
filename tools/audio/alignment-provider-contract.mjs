// Stable boundary between a raw forced-aligner's output and the immutable
// `makewatch.alignment/1` Asset. Providers may speak seconds or samples; this
// module converts to integer samples ONCE, enforces ja-JP, monotonic
// non-overlapping token ranges inside the measured speech span, and preserves
// the provider's own confidence without inventing precision.

const NORMALIZATION = 'makewatch.alignment.normalize/1';
const SHA256 = /^[a-f0-9]{64}$/;
const LOW_CONFIDENCE = 0.62;
const MAX_TRANSCRIPT = 12_000;
const MAX_TOKENS = 4096;
// Kana / kanji / prolonged-sound mark / iteration marks. A ja-JP transcript
// must contain at least one; romaji-only text means the wrong language slipped through.
const JAPANESE_CHAR = /[぀-ヿ㐀-䶿一-鿿ｦ-ﾟー々]/;

function fail(message, code = 'invalid_argument') {
  throw Object.assign(new Error(message), { code });
}

function integerSample(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) fail(`${label} must be a non-negative sample count`);
  return Math.round(n);
}

function toSample(entry, keySample, keySeconds, sampleRate, label) {
  if (entry[keySample] !== undefined && entry[keySample] !== null) return integerSample(entry[keySample], label);
  if (entry[keySeconds] !== undefined && entry[keySeconds] !== null) {
    const seconds = Number(entry[keySeconds]);
    if (!Number.isFinite(seconds) || seconds < 0) fail(`${label} seconds must be non-negative`);
    return Math.round(seconds * sampleRate);
  }
  fail(`${label} is missing (need ${keySample} or ${keySeconds})`);
  return 0;
}

export function normalizeAlignmentRequest(value) {
  if (!value || typeof value !== 'object') fail('alignment request must be an object');
  const language = String(value.language ?? '').trim();
  if (language !== 'ja' && language !== 'ja-JP') fail(`alignment language must be ja-JP (got ${language || 'empty'})`);
  const transcript = String(value.transcript ?? '').trim();
  if (!transcript) fail('alignment transcript must not be blank');
  if (transcript.length > MAX_TRANSCRIPT) fail(`alignment transcript exceeds ${MAX_TRANSCRIPT} characters`);
  if (!JAPANESE_CHAR.test(transcript)) fail('alignment transcript for ja-JP must contain kana or kanji');
  const audioSha256 = String(value.audioSha256 ?? '').toLowerCase();
  if (!SHA256.test(audioSha256)) fail('alignment request needs a 64-hex audioSha256');
  const sampleRate = Number(value.sampleRate);
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 384_000) {
    fail('alignment sampleRate must be an integer in 8000..384000');
  }
  const audioPath = value.audioPath === undefined || value.audioPath === null || value.audioPath === ''
    ? null
    : String(value.audioPath);
  if (audioPath && (audioPath.includes('\0') || audioPath.split(/[\\/]/).some((part) => part === '..'))) {
    fail('alignment audioPath must be a safe managed path');
  }
  let totalSamples = null;
  if (value.totalSamples !== undefined && value.totalSamples !== null) {
    totalSamples = integerSample(value.totalSamples, 'alignment totalSamples');
    if (totalSamples < 1) fail('alignment totalSamples must be positive');
  }
  return {
    dialogueUnitId: value.dialogueUnitId ? String(value.dialogueUnitId) : null,
    audioAssetId: value.audioAssetId ? String(value.audioAssetId) : null,
    audioPath,
    audioSha256,
    transcript,
    language: 'ja-JP',
    sampleRate,
    totalSamples,
  };
}

export function normalizeAlignmentResult(raw, request, provider) {
  if (!raw || typeof raw !== 'object') fail('alignment result must be an object');
  const normalizedRequest = request?.language === 'ja-JP' && Number.isInteger(request?.sampleRate)
    ? request
    : normalizeAlignmentRequest(request);
  const providerId = String(provider?.id ?? '').trim();
  const providerVersion = String(provider?.version ?? '').trim();
  if (!providerId || !providerVersion) fail('alignment provider id and version are required');

  if (raw.audioSha256 && String(raw.audioSha256).toLowerCase() !== normalizedRequest.audioSha256) {
    fail('alignment result audio hash does not match the request audio hash', 'integrity_error');
  }

  const rate = normalizedRequest.sampleRate;
  const speechStartSample = toSample(raw, 'speechStartSample', 'speechStart', rate, 'alignment speech start');
  const speechEndSample = toSample(raw, 'speechEndSample', 'speechEnd', rate, 'alignment speech end');
  if (speechEndSample <= speechStartSample) fail('alignment speech bounds must be positive and ordered');
  if (normalizedRequest.totalSamples !== null && speechEndSample > normalizedRequest.totalSamples) {
    fail('alignment speech end is past the audio bounds');
  }

  const rawTokens = Array.isArray(raw.tokens) ? raw.tokens : null;
  if (!rawTokens || rawTokens.length < 1 || rawTokens.length > MAX_TOKENS) {
    fail(`alignment result must carry 1..${MAX_TOKENS} tokens`);
  }

  let priorEnd = speechStartSample;
  let minConfidence = 1;
  const tokens = rawTokens.map((rawToken, index) => {
    if (!rawToken || typeof rawToken !== 'object') fail(`alignment token[${index}] must be an object`);
    const startSample = toSample(rawToken, 'startSample', 'start', rate, `alignment token[${index}] start`);
    const endSample = toSample(rawToken, 'endSample', 'end', rate, `alignment token[${index}] end`);
    if (startSample < speechStartSample || endSample > speechEndSample) {
      fail(`alignment token[${index}] falls outside the audio bounds`);
    }
    if (startSample < priorEnd || endSample <= startSample) {
      fail(`alignment token[${index}] timing is not monotonic and non-overlapping`);
    }
    priorEnd = endSample;
    const text = String(rawToken.text ?? '').trim();
    if (!text || text.length > 120) fail(`alignment token[${index}] text is missing or too long`);
    const confidenceRaw = rawToken.confidence ?? rawToken.conf;
    const confidence = confidenceRaw === undefined || confidenceRaw === null ? 1 : Number(confidenceRaw);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) fail(`alignment token[${index}] confidence must be 0..1`);
    minConfidence = Math.min(minConfidence, confidence);
    return {
      text,
      readingKana: String(rawToken.readingKana ?? rawToken.kana ?? text).slice(0, 160),
      startSample,
      endSample,
      confidence,
    };
  });

  const overallConfidence = raw.confidence === undefined || raw.confidence === null
    ? minConfidence
    : Math.max(0, Math.min(1, Number(raw.confidence)));
  const warnings = Array.isArray(raw.warnings) ? raw.warnings.map((entry) => String(entry).slice(0, 200)) : [];
  if (overallConfidence < LOW_CONFIDENCE && !warnings.some((entry) => entry.includes('low_confidence'))) {
    warnings.push(`low_confidence: overall ${overallConfidence.toFixed(3)} < ${LOW_CONFIDENCE}`);
  }

  return {
    schema: 'makewatch.alignment/1',
    dialogueUnitId: normalizedRequest.dialogueUnitId ?? '',
    language: 'ja-JP',
    transcript: normalizedRequest.transcript,
    audioAssetId: normalizedRequest.audioAssetId ?? '',
    audioSha256: normalizedRequest.audioSha256,
    provider: { id: providerId, version: providerVersion },
    normalization: NORMALIZATION,
    sampleRate: rate,
    speechStartSample,
    speechEndSample,
    tokens,
    confidence: overallConfidence,
    warnings,
  };
}

export const alignmentProviderLimits = Object.freeze({
  normalization: NORMALIZATION,
  lowConfidence: LOW_CONFIDENCE,
  maxTokens: MAX_TOKENS,
  maxTranscript: MAX_TRANSCRIPT,
});
