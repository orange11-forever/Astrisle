# Island Life Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Execute tasks inline and obtain one independent review of the finished scene changes.

**Goal:** A larger inhabited island with idle strolling, improved character gait and completion confetti, using the current visual identity and private model.

**Architecture:** Pure navigation/motion and celebration rules feed the existing demand-rendered R3F scene. Shared static character geometry may receive an inferred display-only skeleton; native clips remain preferred. Scene state never controls task execution.

**Tech Stack:** Existing React, Three.js/R3F, TypeScript, Vitest and Playwright. No additional dependencies or external model uploads.

**Spec:** `docs/superpowers/specs/2026-11-14-island-life-design.md`.

## Global Constraints

- Preserve `.astrisle-dev/`, source GLBs, character identities and existing project data.
- Keep the 30 fps ambient ceiling and inactive/reduced-motion behavior.
- Native animation clips remain preferred; basic inferred rig is only for compatible static upright geometry.
- No fake task progress or celebrations for unaccepted work; no repeated automatic celebration on reload.
- Keep current cosmic identity and useful controls, remove unnecessary visual/copy clutter within the changed surface.

## Review Focus

1. Model orientation changes, shared geometry and component remounts must not corrupt another avatar or leak skeleton/geometry resources.
2. Static non-humanoid assets, native animations and dense private geometry must remain usable without uncontrolled deformation.
3. Task arrival during a stroll must interrupt navigation without crossing furniture or jumping position.
4. Hidden, unfocused, reduced-motion and closeup scenes must not continue ambient locomotion.
5. Partial acceptance, historical snapshots, island changes and repeat manual confetti must never imply false completion or accumulate effects.

## Task 1: Motion and static character adaptation

**Files:** create `apps/client/src/characters/procedural-gait.ts`, `procedural-gait.test.ts`, `apps/client/src/island-motion.ts`, `island-motion.test.ts`; modify `characters/model-cache.ts`, `CharacterVisual.tsx`, `Scene.tsx`.

**Interfaces:** `createProceduralGaitTemplate(root, rotationY)` returns a shared rig template or null; per-clone skeletons remain independent. `poseProceduralGait(root, motion)` consumes distance-driven phase/strength. Navigation uses a bounded island and obstacle footprints with pure route/step functions.

- [ ] Write failing tests for rest-pose/UV preservation, real foot deformation with stable head, unsupported static geometry, independent clones and no leaked shared geometry.
- [ ] Implement conservative rig inference and cache it per asset/orientation; inspect the current model in an isolated preview.
- [ ] Write/run navigation tests for obstacle avoidance, island boundary, smooth turns/stops and stationary reduced/preview states; implement and connect ambient walking with real task priority.
- [ ] Run focused tests and type checks, then commit.

## Task 2: Expanded island and completion celebration

**Files:** modify `IslandLandscape.tsx`, `Scene.tsx`, `App.tsx`, existing styles; create `celebration.ts`, `celebration.test.ts`, `Confetti.tsx` and scene E2E tests.

**Interfaces:** completion transition checks commission ID/revision/status; confetti uses a bounded burst token and self-expires. App exposes manual celebration only for accepted work.

- [ ] Write failing transition tests (live acceptance once; partial/history/switch/reload never automatic), then implement controller and bounded particles.
- [ ] Expand the island/paths and add restrained garden/rest/stargazing details; keep routes clear and interactive work stations accessible.
- [ ] Connect celebration control, reduced-motion feedback and concise functional labels.
- [ ] Verify actual roaming, skeletal motion, task interruption, reduced motion, button/particle cleanup and narrow layout in browser tests; commit.

## Task 3: Visual inspection, review and delivery

- [ ] Batch desktop/narrow/private-model screenshots and inspect walking frames. Fix material issues in one pass and confirm once.
- [ ] Run the Impeccable detector on changed UI targets; use project context to judge findings rather than changing unrelated surfaces.
- [ ] Run full JS, Office, build, UI and formatting checks; obtain independent review and fix material findings with regression tests.
- [ ] Update README and stage handoff with actual results and model limitations; commit locally and leave the branch ready for review.
