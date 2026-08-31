# Motion library provenance

Every clip here is a `makewatch.motionClip/1` performance **authored by hand** as
keyframed bone rotations — none is motion-captured, DWPose-extracted, or derived
from copyrighted animation. They are deliberately short, low-key reference
movement meant to be retargeted onto any CharacterRig skeleton and refined per
Shot, not shipped verbatim.

| file | clipId | frames @ fps | loop | hand-authored | notes |
|------|--------|--------------|------|---------------|-------|
| `walk.json` | `walk.neutral.loop` | 24 @ 24 | yes | 2026-08-31, keyframed | contralateral leg/arm swing, alternating foot plants, 58u root travel |
| `turn.json` | `turn.stand.left` | 18 @ 24 | no | 2026-08-31, keyframed | standing quarter-turn left: head leads, spine and hips follow, right foot re-plants |
| `sit.json` | `sit.chair.settle` | 30 @ 24 | no | 2026-08-31, keyframed | lower to a seat: thighs/shins fold, hips drop 48u, both feet stay planted, settle at f26 |
| `reach.json` | `reach.forward.right` | 20 @ 24 | no | 2026-08-31, keyframed | right-arm forward reach with anticipation (f3), contact (f14), recovery (f17) |
| `strike.json` | `strike.thrust.right` | 16 @ 24 | no | 2026-08-31, keyframed | windup (f0–4) → thrust → contact+impact (f9) → follow-through; lead foot planted throughout |

Shared skeleton: `root` → (`hip` → thigh/shin/foot ×2) + (`spine` → `head`, upper_arm/forearm ×2), 14 bones, lengths in rig-canvas units.

To bring a clip into a project as an Asset, call `motion_clip` register with its
`libraryClipId` (the filename without `.json`). The register step content-addresses
the exact bytes and records hand-authored provenance on the Generation node.
