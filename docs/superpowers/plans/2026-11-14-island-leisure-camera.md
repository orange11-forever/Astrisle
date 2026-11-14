# Island Life Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans. Implement lifecycle integration inline, delegate isolated camera and scenery work, then request one fresh review.

**Goal:** Deliver unrestricted horizontal studio orbit and automatic seated island activities.

**Architecture:** Shared facility definitions bind geometry, navigation and animation. A pure per-character life state machine with shared reservations drives existing walkers and character rigs. Camera changes remain isolated from business state.

**Tech Stack:** React, TypeScript, Three.js, React Three Fiber, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-14-island-leisure-camera-design.md`

## Global Constraints

- All leisure happens automatically. No manual action menu.
- Preserve existing characters, workspace data, task click behavior, reduced-motion and demand rendering.
- Runtime work and handoffs interrupt leisure. One actor per facility; release reservations on cancellation and unmount.
- No new dependencies or edits to `.astrisle-dev`.
- Use current clean checkout on a feature branch; after local verification, commit and create a remote PR as subsequently requested by the user. Do not merge it.

## Review Focus

- First frame after background or reduced-motion changes must not jump or hold stale reservations.
- Full-cycle leave/return paths must remain walkable and never strand a character inside furniture.
- Imported unsupported or still-loading models must not enter impossible seated poses.
- Fixed camera, resize, reset and closeups must preserve usable targets.
- Repeated mount, workspace switches and GLB resource lifecycle must not leak shared assets.

### Task 1: Camera freedom

- [x] Add browser assertions for overview back/side views, pan, lock and reset; observe old limits fail.
- [x] Update CameraRig and control hints; preserve closeups and fit behavior.
- [x] Run targeted camera browser checks.

### Task 2: Facilities and automatic activities

- [x] Define `island-activities.ts` pure facility and lifecycle interface; tests for routes, reservations, task interruption, motion preferences and full cycle.
- [x] Implement the coordinator and shared facility layout, with seated/swing transform sampling.
- [x] Add joint poses and restore tests for default and procedural characters; use explicit capability reporting for imported models.
- [x] Build `IslandLeisure.tsx` with shared bench, tea table and synchronized swing; integrate into Scene and navigation.
- [x] Verify targeted unit tests and browser activity cycle.

### Task 3: Integration verification and handoff

- [x] Run typecheck, JS tests, UI regression checks, formatting and build.
- [x] Inspect whole island and seated/swing views, fix observed defects in one batch.
- [x] Obtain fresh code review and address material findings.
- [x] Update README and stage-8 development record with actual results and compatibility limits.
