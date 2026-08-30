# Make & Watch — One-Minute Anime Real-User Acceptance Gate

> Release acceptance specification
> Updated: 2026-08-30 (Europe/Istanbul)

> **Temporal provider note (2026-08-30):** the mandatory temporal path is the
> deterministic **Native Anime Motion Engine** (provider `native-anime`,
> `project_brain/NATIVE_ANIME_MOTION_ENGINE.md`), not FramePack. A `native-anime` MP4
> **is** real temporal video for this gate — deterministic 2D animation with real eye
> / mouth / head / hair / camera / parallax motion, frames streamed to the encoder.
> It is explicitly *not* a looped still, Ken Burns move, or frozen-frame pad, and the
> "no still-motion fallback" rule is unchanged. FramePack is an optional experimental
> provider only; "use only if a validated provider is available" now also covers any
> heavy I2V/FLF2V diffusion stack.
> The current 4 s native renderer proof is **not** a pass for this gate: it uses proxy
> tone audio and fails visual inspection on semantic face-layer seams. `native-anime`
> remains production-not-ready until ShotAnim compilation and the visual defects are
> resolved.

## Mission

Before claiming that Make & Watch can create a real anime episode, prove a **~60 second end-to-end mini episode** on the product machine.

Passing unit tests is not enough.

Passing provider health checks is not enough.

Creating a PNG is not enough.

Creating an MP4 file whose frames were never visually inspected is not enough.

The acceptance gate requires an agent to use the product like a human, produce real media, play the result, inspect it, identify defects, fix them when practical, and re-run the affected scope.

---

# 1. Acceptance story

Use one compact story specifically designed to exercise the difficult parts of anime production.

Recommended 55–70 second structure:

```text
Scene 1 — 8s
Establish rainy Tokyo street / recurring location.

Scene 2 — 18s
Two-character Japanese dialogue in a cafe.
Turkish subtitles.
Close-up + reverse + reaction Shot.

Scene 3 — 10s
Character notices a message on phone.
Japanese on-screen text + Turkish forced narrative.

Scene 4 — 12s
Character stands and walks toward the door.
Controlled endpoint / FLF2V candidate if provider exists.

Scene 5 — 10s
Exterior emotional button / final Japanese line / Turkish subtitle.
```

Why this test is useful:

- recurring Character identity;
- recurring Location geometry;
- Japanese TTS;
- Turkish subtitles;
- dialogue timing;
- mouth/face acting expectations;
- reaction editing;
- on-screen text localization;
- temporal motion;
- multiple cuts;
- audio mix;
- Episode assembly.

---

# 2. Default acceptance profile

```text
stylePreset: anime-cinematic
authoringLanguage: tr-TR
originalPerformanceLanguage: ja-JP
primarySubtitleLanguage: tr-TR
fps: 24
aspect: 16:9
target: 60 seconds ± 8 seconds
Shot temporal strategy: I2V default
Temporal provider target: native-anime (must report ready; currently fail-closed)
FLF2V / heavy diffusion I2V (FramePack etc.): use only if a validated provider is actually available
Audio: Chatterbox Multilingual V3 Japanese
Subtitle: Turkish
Render: current Make & Watch temporal Episode path
```

Do not silently switch back to still-motion or a fake animation fallback.

---

# 3. Real-user UI test

The test agent must interact through the same Studio surfaces a user sees whenever possible.

Required behavior:

1. start the official developer/product entry point;
2. open Studio in a real browser;
3. confirm no fatal console errors;
4. open Director;
5. create or reset a dedicated acceptance workflow;
6. ask Director to author the mini episode;
7. inspect the resulting graph visually;
8. verify Series/Episode/Scene/Shot/Character/Location/Audio topology;
9. trigger actual media generation from product actions/Director tools;
10. observe job progress in UI;
11. recover from any surfaced failure instead of bypassing it with private scripts;
12. render the Episode through the product path;
13. play the final MP4 in the product/browser.

Direct internal APIs may be used for diagnosis, but must not replace the user-flow proof.

---

# 4. Provider truth gate

Before expensive work:

- inspect ComfyUI/image provider readiness;
- inspect temporal provider readiness;
- inspect Chatterbox readiness;
- inspect FFmpeg readiness;
- inspect GPU state;
- verify required model paths are real.

A provider marked offline means the production test is blocked. It is not permission to fabricate success.

If a managed runtime can safely install/repair the provider, test that supported path.

Do not silently download unexpected multi-gigabyte models unless the existing product policy explicitly allows and surfaces that operation.

---

# 5. Picture-generation gate

Every final Shot must resolve to a real temporal **video Asset**.

Reject:

- still image accepted as final media;
- FFmpeg image loop;
- fake pan/zoom animation;
- repeated/frozen tail used to hide short generation;
- missing video duration metadata;
- generated video shorter than authored duration beyond allowed frame tolerance.

For each Shot record:

```text
Shot id
strategy
provider
model
video Asset id
SHA-256
duration
resolution
seed/parameters
```

---

# 6. Visual watch-through

The agent must actually inspect the rendered result.

## 6.1 Continuous playback

Watch the entire ~1 minute from start to finish at normal speed.

Record timestamped observations, for example:

```text
00:12.4 — Aya's left eye shape mutates during head turn.
00:18.1 — reverse Shot changes cafe window geometry.
00:31.7 — 6-frame freeze before cut.
00:44.2 — subtitle covers phone text.
```

Generic comments such as `quality could be better` are not sufficient.

## 6.2 Frame/contact-sheet inspection

Extract and inspect:

- first/middle/last frame of every Shot;
- frames around every cut;
- frames around major pose changes;
- dialogue close-up samples;
- suspected defect ranges;
- at least one regular interval sample across the full minute.

If the agent supports image vision, present extracted frames directly to that vision system.

## 6.3 Mechanical video checks

Use FFmpeg/ffprobe or equivalent diagnostics to verify:

- decodable MP4;
- expected video/audio streams;
- duration;
- dimensions/FPS;
- no accidental black segments;
- no corrupt frames;
- no long technical freeze segments;
- no unexpected silence during authored dialogue;
- no obvious A/V duration mismatch.

Mechanical detectors are evidence, not final artistic judgement. Anime intentionally uses held poses; a freeze detector must distinguish an authored hold with active eyes/hair/environment from a technical repeated-frame failure.

---

# 7. Character continuity gate

For every recurring Character compare all Shots against canonical references.

Fail on obvious unintended changes to:

- face proportions;
- eye color/shape;
- hair color/silhouette;
- body proportions;
- outfit identity;
- signature accessory;
- age presentation.

Temporary action deformation/smear is allowed when clearly intentional.

Recommended acceptance rubric per Shot:

```text
identity       0–5
face topology  0–5
hair           0–5
wardrobe       0–5
acting clarity 0–5
```

Any score <=2 should trigger inspection/regeneration before release acceptance.

---

# 8. Location continuity gate

Across reverse angles and later returns, inspect:

- doors/windows;
- furniture placement;
- dominant palette;
- wall geometry;
- light direction;
- weather state;
- horizon/perspective;
- recurring props.

A cafe cannot become a different building every cut.

---

# 9. Motion gate

The final result should feel like temporal animation, not AI morphing.

Inspect:

- anticipation before large movement;
- readable primary action;
- settle/follow-through;
- eye/head ordering;
- hair/cloth secondary motion;
- motion continuity across temporal segments;
- camera intent;
- unwanted full-frame boiling;
- sudden motion-vector direction changes;
- limb duplication;
- hand/object interaction.

For quiet dialogue, prefer deliberate low motion density over random motion everywhere.

For action, prioritize silhouette/readability over perfect frame-to-frame facial rigidity.

---

# 10. Japanese audio gate

Listen to the complete Japanese dialogue track.

Inspect:

- no missing lines;
- no duplicates;
- no speaker swaps;
- no clipped starts/ends;
- plausible Japanese pronunciation;
- character voice consistency;
- emotional delivery appropriate to Scene;
- pacing not obviously robotic;
- pauses align with acting/edit rhythm.

Chatterbox currently documents Japanese support. That does not mean every generated Japanese line automatically passes acting/pronunciation QC.

If a voice reference language creates an audible accent problem, report it explicitly and regenerate with a more appropriate reference/settings.

---

# 11. Japanese performance + Turkish subtitle sync gate

The acceptance render must demonstrate at least several Japanese spoken cues with Turkish subtitles.

## Timing

Subtitle in-time should normally land on or within roughly 1–2 frames of audible speech onset.

Subtitle out-time may remain slightly after speech for readability when the next cue/shot permits.

Do not force subtitle out-time to equal mouth closure exactly.

## Turkish readability

Target current professional guidance:

- <= 17 characters/second for adult Turkish subtitle content;
- maximum 2 lines;
- avoid extremely short flashes;
- preserve grammatical/semantic units;
- avoid subtitle collision with important on-screen text/faces;
- do not reveal a punchline/reaction early.

The test report should calculate reading speed for every Turkish cue.

## Meaning

Compare:

```text
canonical DialogueUnit intent
Japanese performance text
Turkish subtitle
```

The subtitle must preserve plot meaning and emotional function, not necessarily literal word order.

---

# 12. On-screen text gate

The phone-message Scene must prove the forced-narrative concept.

Expected behavior:

- visual phone/world text may remain Japanese;
- plot-relevant meaning appears in Turkish;
- Turkish forced narrative does not collide with dialogue subtitle;
- timing tracks the on-screen text while remaining readable;
- decorative text is not unnecessarily translated.

---

# 13. Edit / pacing gate

A real-series feeling depends heavily on editing.

Watch for:

- too many same-sized close-ups;
- every Shot lasting the same duration;
- cuts happening mid-action accidentally;
- no reaction Shots;
- unnecessary dissolves;
- camera constantly floating;
- dialogue with no breathing room;
- abrupt scene endings;
- emotional beat not held long enough;
- empty dead time created only to reach 60 seconds.

The minute should have a beginning, escalation/reveal and button/end beat.

---

# 14. Audio-mix gate

Verify:

- dialogue intelligibility;
- ambience continuity across cuts;
- no abrupt room-tone disappearance;
- music does not mask speech;
- no clipping;
- no huge line-to-line loudness variation;
- transition between silence/ambience feels intentional.

If music/SFX generation is not currently implemented, document that gap rather than pretending a complete broadcast mix exists.

---

# 15. Subtitle export gate

When subtitle exporters are implemented, acceptance should require:

- structured internal subtitle data;
- WebVTT preview export;
- IMSC/TTML master export;
- optional SRT compatibility export;
- UTF-8 correctness;
- language metadata;
- deterministic repeatable timestamps.

Until implemented, this remains a roadmap gate and must be reported as such.

---

# 16. Defect severity

## P0 — invalid proof

- no actual MP4;
- final Shot is image fallback;
- video cannot play;
- missing required audio track;
- fabricated success.

## P1 — release blocker

- major identity swap;
- severe facial/limb corruption;
- missing dialogue;
- major A/V sync failure;
- subtitles unusable/unreadable;
- long accidental freeze/black frame;
- Scene continuity obviously broken.

## P2 — quality blocker

- visible temporal flicker;
- weak acting;
- unnatural TTS line;
- subtitle wording awkward;
- poor cut timing;
- mild geometry drift;
- mix problem.

## P3 — polish

- minor line-art wobble;
- one weak secondary-motion moment;
- subtitle break could be prettier;
- subtle color mismatch.

A `real series` acceptance should have zero P0/P1, no unresolved high-confidence P2 defects, and a documented P3 list.

---

# 17. Repair loop

For every defect:

1. classify severity and defect type;
2. identify Scene/Shot/DialogueUnit/frame range;
3. identify the smallest invalidated dependency;
4. repair only that scope;
5. regenerate/rerender;
6. re-watch the changed range plus surrounding cuts;
7. rerun mechanical checks;
8. update the report.

Preferred repair cost order:

```text
metadata / subtitle edit
< audio cue regeneration
< hero/reference regeneration
< temporal segment regeneration
< entire Shot regeneration
< Scene rebuild
< Episode rebuild
```

---

# 18. Required test report

Create a durable report under `.makewatch/reports/` or an agreed repo-local test output path containing:

```text
exact git SHA
machine/GPU
runtime/provider versions
models/checkpoints
workflow/project id
Episode id
final MP4 path + SHA-256
duration/FPS/resolution
all Shot media Assets
all Audio Assets
subtitle cues + CPS
mechanical test results
timestamped watch-through notes
P0/P1/P2/P3 findings
fixes made
remaining limitations
final PASS / FAIL
```

Do not write `PASS` if the agent never watched/inspected the rendered media.

---

# 19. Definition of PASS

PASS means all of these are true on the same final project revision:

- a real ~1 minute MP4 exists;
- every final Shot uses real temporal video;
- video plays continuously;
- Japanese dialogue is audible and coherent;
- Turkish subtitles are synchronized/readable;
- recurring Characters remain recognizably the same;
- recurring Location remains coherent;
- no P0/P1 defects remain;
- relevant P2 defects were repaired or explicitly justified;
- final output was visually and audibly inspected after the last fix;
- the exact final commit passes repository CI.

Anything less is a development milestone, not proof of a real-series production path.
