# Island life and character motion

User-approved direction, 2026-11-14: companions stroll when idle; improve movement detail; enlarge and enrich each island; add confetti after completed work; keep the interface restrained and avoid generic AI dashboard styling.

## Intent and approaches

Keep the existing cosmic island identity and the user's blue-haired maid. Expand the place rather than reskinning the application. Replacing the character with a stock animated avatar would lose the chosen appearance; treating whole-object sliding as walking would miss the request. Use native clips when present, and attempt a conservative display-only humanoid rig for suitable static upright meshes. Do not modify the imported GLB or distribute private assets. Unsupported shapes retain their original pose; do not promise production-quality automatic rigging for arbitrary meshes.

## Motion

- On idle, follow a walkable outer promenade with individual starting positions, speeds and occasional pauses. Moving to real task stations takes priority. Work/approval states remain truthful.
- Use distance-driven stride phase, smooth acceleration/deceleration, bounded shortest-angle turning and landing transitions. Avoid desks, furniture, ponds and the island edge.
- Adapt hips, knees, ankles, small arm counter-swing, torso weight shift and head motion. Keep dress/hair deformation conservative, verify the actual imported model, and preserve rest geometry/UV/materials.
- Character closeups stay stationary for inspection. Reduced motion removes roaming and skeletal cycles; hidden/unfocused scenes do not simulate ambient work. No changes to execution or task state originate from animation.

## Island and interface

- Increase land radius from 7.42 to about 9 units, retaining the central working deck. Add a clear promenade, garden seating, a small sheltered rest area, lamps, shrubs and a stargazing corner; use merged geometry and existing material palette.
- Retain stone, faded timber, sage plants, brass and the cosmic backdrop. Keep palette anchored in existing #b6a58b timber, #4e9690 teal, #e7eef0 paper, #ba994f brass and #203d50 ink. Existing typography remains; improve hierarchy and concise functional copy.
- A visitor sees one inhabited island, not a grid of decorative cards. Task controls remain usable in desktop/narrow layouts; labels do not crowd characters. Avoid extra glows, slogans or invented progress.

## Celebration

On the current commission's live transition to `accepted`, burst once. Historical snapshots, switching islands and reloads do not replay it. A `庆祝一下` button is available for accepted work. Keep a bounded short-lived particle pool, no audio, no pointer obstruction, and a static completion cue in reduced-motion/2D mode. Task failure, cancellation and partial acceptance never celebrate completion.

## Verification

Test navigation boundaries and collision avoidance, motion continuity, rig rest-pose integrity and deformation, resource ownership/sharing, and celebration transition rules. Browser tests observe actual scene position/bone changes and no movement under reduced motion; test the real button and completed snapshot transition. Inspect the current private model in an isolated preview and inspect desktop/narrow scenes in one batched visual pass, followed by at most one corrective pass.
