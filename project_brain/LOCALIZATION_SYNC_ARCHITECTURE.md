# Make & Watch — Multilingual Anime Localization & Sync Architecture

> Product/architecture specification
> Updated: 2026-08-30 (Europe/Istanbul)

## 0. Product target

For an `anime-cinematic` Series, the recommended premium audience profile is:

```text
Original performance audio: Japanese (ja-JP)
Primary viewer subtitle: Turkish (tr-TR)
Optional subtitle tracks: English + additional BCP-47 languages
Optional dub tracks: Turkish / English / others
Master video: one canonical picture edit
Dialogue/lip motion: synchronized to the selected performance audio
Subtitle timing: synchronized to the same DialogueUnit, but optimized for reading
```

Japanese is a **recommended default for the authentic-anime preset**, not a hard technical requirement. The user must be able to override original performance language explicitly.

The system must never treat these as one field named `language`. They are separate concerns:

- authoring language;
- original performance language;
- subtitle language(s);
- dub language(s);
- UI language;
- on-screen text language;
- metadata/title localization.

This distinction is mandatory for a serious long-form production system.

---

# 1. Core idea: one semantic line, many synchronized representations

The central unit should be a stable semantic **DialogueUnit**.

Conceptual shape:

```text
DialogueUnit dlg.s03.014
├─ speakerCharacterId: character.aya
├─ intent: restrained frustration
├─ sourceMeaning: canonical semantic intent
├─ authoringText.tr-TR: "Bunu bana daha önce söylemeliydin."
├─ performanceText.ja-JP: "もっと早く言ってくれればよかったのに。"
├─ subtitleText.tr-TR: "Bunu daha önce söylemeliydin."
├─ subtitleText.en-US: "You should've told me sooner."
├─ speechAsset.ja-JP
├─ alignment.ja-JP
├─ optionalDubAsset.tr-TR
├─ optionalDubAlignment.tr-TR
└─ QC / approvals / revision
```

The semantic identity (`dlg.s03.014`) survives translation, TTS regeneration, subtitle resegmentation, voice replacement and final mastering.

## Why this is superior

Without a stable DialogueUnit, a project drifts into four unrelated copies:

```text
script text != Japanese TTS text != Turkish subtitle != lip animation
```

That eventually creates sync bugs and translation contradictions.

With one semantic unit:

```text
                   DialogueUnit
                  /      |       \
             Japanese   Turkish   English
              audio     subtitle subtitle
                |          |        |
          forced align     |        |
                \__________|________/
                           |
                    common timeline
```

Every downstream representation can be regenerated independently while preserving semantic and editorial identity.

---

# 2. Language profile model

## 2.1 Replace the idea of one project `language`

The current Series schema has one generic dialogue language field. That is sufficient for the present implementation but not for premium localization.

Future schema should expose a language profile resembling:

```json
{
  "authoringLanguage": "tr-TR",
  "originalPerformanceLanguage": "ja-JP",
  "defaultSubtitleLanguage": "tr-TR",
  "subtitleLanguages": ["tr-TR", "en-US"],
  "dubLanguages": [],
  "uiLanguage": "tr-TR",
  "onScreenTextPolicy": "original-ja-with-localized-forced-narrative"
}
```

Use BCP-47 language tags at the project boundary rather than ambiguous names such as `Japanese` or `Turkish`.

Provider adapters may map `ja-JP -> ja` and `tr-TR -> tr` internally when a model only accepts two-letter language IDs.

## 2.2 Anime preset behavior

Recommended default behavior when `stylePreset=anime-cinematic` and the user has not made a language decision:

```text
originalPerformanceLanguage = ja-JP
primary subtitle             = user's preferred audience language
subtitlePolicy               = sidecar + optional preview burn-in
```

For a Turkish creator/audience profile:

```text
ja-JP audio + tr-TR subtitles
```

The Director should state the choice once in the Episode/Series plan, then stop repeatedly asking about it unless the user changes it.

---

# 3. Canonical timing: never use floating-point seconds as production truth

A professional long-form timeline should eventually use a **rational time model**.

Recommended conceptual representation:

```text
RationalTime(value, rate)
```

Examples:

```text
frame 144 at 24 fps    => value=144 rate=24
48000 audio samples    => value=48000 rate=48000
```

OpenTimelineIO uses this `value / rate` model for editorial timing and supports rescaling between rates. Make & Watch does not need to adopt OTIO as its internal project model immediately, but it should copy this correctness principle.

Why:

- 23.976 / 29.97 / 59.94 do not remain exact under naive decimal math;
- audio is sample-based;
- subtitles need millisecond output;
- render cuts are frame-based;
- long episodes amplify small rounding errors.

## Recommended clocks

- Picture/edit: rational frame time.
- Audio alignment: integer sample positions at the actual sample rate (normally 48 kHz master).
- Subtitle export: derived timestamps from the canonical timeline.

Seconds remain a UI/display convenience, not the long-term source of truth.

Official design reference:
- Academy Software Foundation OpenTimelineIO `RationalTime`.

---

# 4. Japanese TTS path

Chatterbox Multilingual V3 currently documents support for both Japanese (`ja`) and Turkish (`tr`), alongside 21 other languages.

For the anime-authentic profile:

```text
DialogueUnit
 -> Japanese performance adaptation
 -> Character voice reference
 -> Chatterbox V3 language_id=ja
 -> WAV Asset
 -> forced alignment
 -> Audio provenance
```

## 4.1 Translation is not literal translation

The system needs two text transforms:

### Semantic translation

Preserve what the character means.

### Performance adaptation

Rewrite for natural Japanese acting, timing, register and character personality.

Do not mechanically translate Turkish syntax into Japanese and send it directly to TTS.

The Director should preserve:

- intent;
- relationship/formality;
- age/personality;
- emotional energy;
- important terminology;
- plot facts.

It may alter word order and phrasing to become natural Japanese.

## 4.2 Character-specific language bible

Each recurring Character should eventually have a speech profile:

```text
register
politeness level
pronoun/self-reference habits
sentence ending habits
honorific policy
verbal tics
forbidden phrasing
emotional range
normal speaking rate
```

This is the language equivalent of the visual Character Anchor.

A teenage protagonist, an older teacher and a formal executive should not all sound like the same LLM translated them.

## 4.3 Voice reference rule

Chatterbox documentation warns that mismatching reference-clip language and requested language can transfer accent characteristics. Therefore:

- prefer a Japanese voice reference for Japanese canonical performance;
- if the identity voice reference is in another language, treat accent transfer as a QC risk;
- keep provider settings/provenance per generated line;
- do not silently reuse an unsuitable reference.

---

# 5. Forced alignment: generated audio becomes timing authority

Do **not** assume the text duration before TTS.

Correct flow:

```text
performance text
     ↓
Japanese TTS
     ↓
actual waveform
     ↓
forced alignment
     ↓
word / character / phone / mora-like timing data
```

For Japanese, current research candidates include:

- Montreal Forced Aligner, which documents current Japanese acoustic/dictionary/G2P workflows;
- WhisperX, whose current alignment table includes Japanese and Turkish alignment models and can return fine-grained alignment data.

These are alignment candidates, not yet Make & Watch runtime dependencies.

## 5.1 Alignment Asset

Alignment should become an immutable JSON Asset, for example:

```json
{
  "dialogueUnitId": "dlg.s03.014",
  "language": "ja-JP",
  "audioAssetId": "asset.audio.abc",
  "sampleRate": 48000,
  "speechStart": 10240,
  "speechEnd": 163840,
  "tokens": [
    {"text":"もっと", "start":10240, "end":42000},
    {"text":"早く", "start":43000, "end":70000}
  ]
}
```

The exact phone/mora representation is provider-specific. The project contract only needs stable timing ranges with confidence values.

## 5.2 Confidence gate

If forced alignment confidence is poor:

1. retry alignment with the known transcript;
2. verify text normalization;
3. regenerate speech if pronunciation is clearly wrong;
4. do not build lip motion from low-confidence timings.

---

# 6. Lip sync is not subtitle sync

This distinction is critical.

## Lip / face timeline

Driven by the **actual audio alignment**.

```text
speech starts -> mouth/face performance starts
phoneme/mora timing -> mouth-state changes
speech ends -> mouth performance ends
```

## Subtitle timeline

Driven by the same DialogueUnit and audio boundaries, but optimized for human reading.

A subtitle may:

- start within 1–2 frames of speech onset;
- stay on-screen slightly after speech finishes;
- avoid crossing an unrelated shot change;
- be split/condensed for reading speed.

Therefore:

```text
Audio alignment = biological/performance clock
Subtitle cue     = viewer/readability clock
```

They share identity and anchors, not necessarily identical out-times.

This is how we avoid the bad compromise where either lips become late or subtitles disappear too quickly.

---

# 7. Turkish subtitle generation

Turkish subtitle text should be generated from the canonical DialogueUnit meaning and the final Japanese performance intent, not by blindly ASR-transcribing the Japanese WAV and translating the transcription.

Recommended path:

```text
DialogueUnit semantic meaning
 + final Japanese performance text
 + character/scene context
 -> Turkish subtitle adaptation
 -> reading-speed / segmentation solver
 -> timed cue
```

## 7.1 Hard quality rules

Use current professional timed-text principles as a target:

- maximum two subtitle lines;
- normal dialogue subtitles for Turkish adult content should target <= 17 characters/second;
- minimum event duration should normally be around 20 frames at 24 fps (Netflix general guidance: 5/6 second; language-specific rules may vary);
- maximum event duration around 7 seconds;
- in-time should normally be at/very close to first speech frame;
- if no following cue conflicts, out-time may extend roughly half a second for comfortable reading;
- do not unnecessarily cross shot changes;
- semantic/grammatical units should not be broken awkwardly;
- plot-relevant dialogue has priority over decorative on-screen text.

The Netflix Turkish guide is a useful public professional reference, not a Make & Watch delivery certification claim.

## 7.2 Subtitle condensation

A translation that is accurate but impossible to read is not finished.

Subtitle adaptation may condense redundant wording while preserving:

- plot fact;
- emotional force;
- joke/punchline timing;
- relationship/formality;
- character voice.

Never reveal a punchline or reaction before the corresponding Japanese audio/visual beat.

## 7.3 Safe area

Subtitle renderer should understand:

- face/action regions;
- on-screen text;
- lower-third graphics;
- shot composition.

Future QC can use detected face/important-object boxes to choose bottom/top placement automatically instead of always covering the character's mouth.

---

# 8. Subtitle master formats

Do not make `.srt` the canonical internal format.

Recommended outputs:

### Web preview

`WebVTT (.vtt)`

Why:

- W3C-defined timed text format;
- native browser `<track>` support;
- cue identifiers;
- language/voice spans;
- positioning/regions;
- metadata cues.

### Professional/master text track

`IMSC / TTML`

W3C IMSC is designed for worldwide subtitle/caption delivery. IMSC Text Profile 1.3 became a W3C Recommendation in May 2026.

### Compatibility export

`SRT`

Useful for interchange, but not rich enough to be Make & Watch's semantic truth.

## Internal rule

The internal SubtitleTrack is structured data. VTT/IMSC/SRT are export adapters.

---

# 9. Recommended project entities

The current graph can represent basic subtitles through Audio + Asset metadata. For premium multi-language production, the next semantic schema should add or emulate the following entities.

## DialogueUnit

Language-neutral dramatic utterance identity.

## PerformanceTrack

One spoken-language realization of DialogueUnits.

Example:

```text
performance.ja-JP
```

## SubtitleTrack

One localized timed-text realization.

Example:

```text
subtitles.tr-TR
subtitles.en-US
```

## DubTrack

A second spoken-language realization.

Example:

```text
dub.tr-TR
```

## Alignment Asset

Audio-derived token/phone timing.

## QCReport

Machine + human/Director findings tied to concrete Asset revisions.

Until dedicated node kinds exist, these can be represented as typed JSON/subtitle Assets and strongly named Audio metadata, but the documentation should treat them as first-class production concepts.

---

# 10. Language matrix

A Series should display one obvious matrix rather than scattered language fields.

Example:

| Role | Language | State |
| --- | --- | --- |
| Authoring | tr-TR | canonical |
| Original performance | ja-JP | enabled |
| Primary subtitle | tr-TR | enabled |
| Secondary subtitle | en-US | optional |
| Turkish dub | tr-TR | off |
| English dub | en-US | off |

The user should understand the entire localization configuration in seconds.

---

# 11. Dub architecture without destroying the picture edit

A dub language will rarely have exactly the same duration as Japanese.

Never solve this by aggressively stretching audio.

Recommended hierarchy:

1. timing-aware translation/adaptation;
2. TTS speaking-rate/punctuation control;
3. small transparent time-scale correction only if needed;
4. re-time pauses inside the DialogueUnit;
5. if necessary, use a language-specific face/lip performance layer;
6. regenerate the whole temporal Shot only as the expensive last resort.

Future premium architecture can separate:

```text
body/background temporal plate
             +
language-specific face/mouth performance
```

That would allow Japanese, Turkish and English dubs to share the expensive base animation while receiving different lip performance.

This is a high-value research direction, not a current implementation claim.

---

# 12. Dialogue-first production ordering

For dialogue-heavy anime, audio should often be produced **before final temporal video**.

Recommended order:

```text
script / DialogueUnits
 -> final Japanese performance adaptation
 -> TTS
 -> forced alignment
 -> Shot timing refinement
 -> hero frames
 -> audio-aware temporal prompts / face control
 -> video generation
 -> subtitles
 -> final mix/render
```

Why this is better than generating video first:

- Shot duration is based on actual acting;
- pauses become intentional;
- lip motion has a real source;
- edit rhythm is grounded in performance;
- subtitles inherit real dialogue timing;
- fewer expensive video regenerations are caused by late audio changes.

Action-only and montage scenes can use picture-first production where appropriate.

---

# 13. Audio-aware temporal video

Three quality levels should exist.

## Level 1 — audio-timed prompt

Current-compatible concept:

- audio determines Shot duration;
- temporal prompt describes eye/head/mouth beats around speech timing.

## Level 2 — alignment-conditioned mouth plan

Convert alignment into stylized anime mouth states:

```text
CLOSED
SMALL_OPEN
OPEN
WIDE
ROUND
EMPHASIS
```

Do not attempt hyper-photoreal visemes if the target style is traditional anime.

## Level 3 — audio-conditioned video provider

Research provider path where audio directly conditions facial video synthesis.

This should be integrated behind Make & Watch's provider-neutral temporal contract, never allowed to own project semantics.

---

# 14. Subtitle timing solver

A future deterministic subtitle solver should optimize a cost function such as:

```text
cost =
  reading_speed_violation
+ shot_boundary_violation
+ semantic_break_penalty
+ overlap_penalty
+ visual_occlusion_penalty
+ spoiler_early_reveal_penalty
+ excessive_linger_penalty
```

The LLM proposes translation/segmentation; deterministic code verifies and adjusts timing.

This is preferable to asking the LLM to invent milliseconds directly.

---

# 15. Anime-specific on-screen Japanese text

Signs, phones, letters, classroom boards and titles require a separate policy.

Possible Series setting:

```text
onScreenTextPolicy:
  original-ja-with-localized-forced-narrative
```

Meaning:

- visual world remains Japanese where artistically intended;
- plot-relevant written information receives a Turkish forced-narrative subtitle;
- redundant decorative text is not translated;
- forced narrative does not collide with dialogue subtitle;
- placement adapts to existing screen text.

This gives the episode an authentic Japanese visual world without sacrificing comprehension.

---

# 16. Music and songs

Anime openings/endings and insert songs need their own track policy.

Each song should carry:

```text
song language
lyrics rights/source
romanization track (optional)
Turkish lyric subtitle track (optional)
karaoke timing (optional)
instrumental/karaoke mix Asset (optional)
```

Dialogue subtitles and lyric subtitles must not fight for the same safe area without an explicit layout decision.

Do not automatically translate background song lyrics unless the creative/show policy says the audience is meant to understand them.

---

# 17. QC: synchronization gates

A one-minute premium acceptance render should fail if any of the following occurs without an intentional exception:

## Audio

- clipped dialogue;
- missing dialogue;
- duplicated line;
- obvious pronunciation error;
- speaker voice identity swap;
- large loudness jumps;
- silence where dialogue should exist.

## A/V

- lip/face performance visibly starts late/early;
- dialogue continues after the mouth/acting completely stops;
- shot duration is shorter than dialogue;
- abrupt audio cut at edit boundary;
- cumulative drift across the minute.

## Subtitles

- wrong translation/meaning;
- subtitle appears before punchline/reveal;
- >2 lines without explicit exception;
- Turkish reading speed over target;
- cue flashes too briefly;
- cue hides critical face/action when relocation is possible;
- dialogue cue and forced narrative collide;
- subtitle persists into unrelated scene.

## Video

- identity drift;
- costume mutation;
- face deformation;
- background geometry drift;
- flicker/boiling;
- frozen generated tail;
- accidental black frames;
- camera motion inconsistent with authored Shot;
- repeated/duplicate frames that read as a technical failure rather than deliberate anime cadence.

---

# 18. Automatic correction loop

The Director/QA agent should never only report "bad video".

It should localize the defect:

```text
Episode
 -> Scene
 -> Shot
 -> temporal segment
 -> frame range
 -> Character / Location / DialogueUnit
 -> concrete defect class
```

Then choose the cheapest valid repair:

```text
subtitle text/timing edit
< audio regeneration
< hero-frame regeneration
< one temporal segment regeneration
< whole Shot regeneration
< whole Scene regeneration
```

Whole-Episode regeneration should be practically forbidden for local defects.

---

# 19. 100/100 "authentic anime" profile

Recommended product preset:

```text
PROFILE: anime-authentic-tr

Visual style: anime-cinematic
Authoring language: tr-TR
Original performance: ja-JP
Primary subtitles: tr-TR
Secondary subtitles: optional en-US
Master fps: 24
Dialogue workflow: audio-first
TTS: Chatterbox Multilingual V3
Alignment: provider-neutral forced-alignment stage
Shot strategy: I2V default / FLF2V for controlled endpoints
Subtitle master: structured internal track
Web export: WebVTT
Professional timed-text export: IMSC/TTML
Compatibility export: SRT
QC: required before Episode approval
```

This preset should remain editable; it is an intelligent default, not a restriction.

---

# 20. Research anchors (current as of 2026-08-30)

## Timed text

- W3C WebVTT Candidate Recommendation Draft, 20 May 2026: https://www.w3.org/TR/webvtt1/
- W3C IMSC Text Profile 1.3 Recommendation, 21 May 2026: https://www.w3.org/TR/ttml-imsc/
- Netflix Timed Text General Requirements: https://partnerhelp.netflixstudios.com/hc/en-us/articles/215758617-Timed-Text-Style-Guide-General-Requirements
- Netflix Subtitle Timing Guidelines: https://partnerhelp.netflixstudios.com/hc/en-us/articles/360051554394-Timed-Text-Style-Guide-Subtitle-Timing-Guidelines
- Netflix Turkish Timed Text Style Guide: https://partnerhelp.netflixstudios.com/hc/en-us/articles/215342858-Turkish-Timed-Text-Style-Guide
- Netflix Japanese Timed Text Style Guide: https://partnerhelp.netflixstudios.com/hc/en-us/articles/215767517-Japanese-Timed-Text-Style-Guide

## Audio / alignment

- Resemble AI Chatterbox: https://github.com/resemble-ai/chatterbox
- Montreal Forced Aligner: https://github.com/MontrealCorpusTools/Montreal-Forced-Aligner
- WhisperX: https://github.com/m-bain/whisperX

## Editorial time

- Academy Software Foundation OpenTimelineIO: https://github.com/AcademySoftwareFoundation/OpenTimelineIO

## Temporal video

- FramePack official project: https://github.com/lllyasviel/FramePack
- ComfyUI Wan video examples: https://docs.comfy.org/tutorials/video/wan/wan-video
- ComfyUI Wan FLF2V: https://docs.comfy.org/tutorials/video/wan/wan-flf
- ComfyUI Wan2.2 Animate: https://docs.comfy.org/tutorials/video/wan/wan2-2-animate

---

# 21. Current implementation versus roadmap

Already present in Make & Watch:

- Series/Character/Scene/Shot/Audio semantic graph;
- per-Audio language metadata;
- Chatterbox multilingual voice path;
- subtitle-enabled Audio cues;
- temporal video Shot pipeline;
- deterministic Episode composition/render;
- Asset/Generation provenance.

Not yet claimed as implemented:

- dedicated DialogueUnit node;
- multi-language SubtitleTrack/DubTrack nodes;
- forced-alignment service;
- rational-time migration;
- automatic Turkish subtitle segmentation/read-speed solver;
- WebVTT/IMSC master exporters;
- audio-conditioned lip/face control;
- language-specific face performance layers;
- automated semantic subtitle translation QC.

These are roadmap requirements, not fake current capabilities.
