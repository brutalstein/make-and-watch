import assert from 'node:assert/strict';

import {
  alignmentProviderLimits,
  normalizeAlignmentRequest,
  normalizeAlignmentResult,
} from './alignment-provider-contract.mjs';

const AUDIO_SHA = 'a'.repeat(64);
const request = normalizeAlignmentRequest({
  dialogueUnitId: 'audio.dialogue.aya.001',
  audioAssetId: 'asset.audio.abc',
  audioPath: 'artifacts/audio/aya-001.wav',
  audioSha256: AUDIO_SHA,
  transcript: 'もっと ゆっくり 話して',
  language: 'ja-JP',
  sampleRate: 24000,
  totalSamples: 72000,
});
assert.equal(request.language, 'ja-JP');
assert.equal(request.sampleRate, 24000);

assert.throws(() => normalizeAlignmentRequest({ ...request, language: 'tr-TR' }), /ja-JP/);
assert.throws(() => normalizeAlignmentRequest({ ...request, transcript: 'motto yukkuri' }), /kana or kanji/);
assert.throws(() => normalizeAlignmentRequest({ ...request, audioSha256: 'zz' }), /audioSha256/);
assert.throws(() => normalizeAlignmentRequest({ ...request, sampleRate: 500 }), /sampleRate/);
assert.throws(() => normalizeAlignmentRequest({ ...request, audioPath: '../secret.wav' }), /managed path/);

const provider = { id: 'mms-fa', version: '2024.1' };
const raw = {
  speechStartSample: 2400,
  speechEndSample: 50400,
  tokens: [
    { text: 'もっと', readingKana: 'モット', startSample: 2400, endSample: 14400, confidence: 0.94 },
    { text: 'ゆっくり', readingKana: 'ユックリ', startSample: 15000, endSample: 30000, confidence: 0.9 },
    { text: '話して', readingKana: 'ハナシテ', startSample: 31000, endSample: 50400, confidence: 0.88 },
  ],
};

const normalized = normalizeAlignmentResult(raw, request, provider);
assert.equal(normalized.schema, 'makewatch.alignment/1');
assert.equal(normalized.tokens[0].startSample, 2400);
assert.equal(normalized.tokens.length, 3);
assert.equal(normalized.provider.id, 'mms-fa');
assert.equal(normalized.normalization, alignmentProviderLimits.normalization);
assert.equal(normalized.confidence, 0.88);
assert.deepEqual(normalized.warnings, []);
assert.equal(normalized.dialogueUnitId, 'audio.dialogue.aya.001');

const secondsRaw = {
  speechStart: 0.1,
  speechEnd: 2.1,
  tokens: [
    { text: 'あめ', start: 0.1, end: 0.9, conf: 0.8 },
    { text: 'だね', start: 1.0, end: 2.1, conf: 0.75 },
  ],
};
const fromSeconds = normalizeAlignmentResult(secondsRaw, request, provider);
assert.equal(fromSeconds.speechStartSample, Math.round(0.1 * 24000));
assert.equal(fromSeconds.tokens[1].endSample, Math.round(2.1 * 24000));

assert.throws(
  () => normalizeAlignmentResult({ ...raw, tokens: [{ ...raw.tokens[0], endSample: 9_999_999 }, ...raw.tokens.slice(1)] }, request, provider),
  /audio bounds/i,
);
assert.throws(
  () => normalizeAlignmentResult({ ...raw, speechEndSample: 80_000 }, request, provider),
  /audio bounds/i,
);
assert.throws(
  () => normalizeAlignmentResult({
    ...raw,
    tokens: [raw.tokens[0], { ...raw.tokens[1], startSample: 10_000 }],
  }, request, provider),
  /monotonic/i,
);
assert.throws(
  () => normalizeAlignmentResult({ ...raw, audioSha256: 'b'.repeat(64) }, request, provider),
  /hash/i,
);
assert.throws(() => normalizeAlignmentResult(raw, request, { id: '', version: '' }), /provider/i);

const lowConf = normalizeAlignmentResult({
  ...raw,
  tokens: raw.tokens.map((token) => ({ ...token, confidence: 0.4 })),
}, request, provider);
assert.equal(lowConf.confidence, 0.4);
assert.ok(lowConf.warnings.some((entry) => entry.includes('low_confidence')));

assert.equal(
  JSON.stringify(normalizeAlignmentResult(raw, request, provider)),
  JSON.stringify(normalizeAlignmentResult(raw, request, provider)),
);

console.log('alignment provider contract check: passed');
