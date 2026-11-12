# Budget continuation implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let users inspect and adjust a paused commission's limits and continue without resetting consumed work.

**Architecture:** Runtime remains the authority for cumulative active time and logical model-turn reservations. Desktop validates an explicit budget update command; the existing goal panel shows usage and offers editing while paused. Scene clarity is a separate concurrent change requested by the user.

**Tech Stack:** Existing TypeScript, SQLite snapshots, Electron IPC, React, Vitest and Playwright; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-11-astrisle-system-design.md`, sections 8.3 and 9; continuing the existing approved v0.1 design.

## Global constraints

- Preserve task history, requirements revision, authorization, artifacts and unknown-outcome checks.
- Limits are total commission limits, not extra quota; editing never resumes automatically.
- Model steps include planning and attempted agent turns, reserved before sending; protocol-internal retries remain one logical turn.
- Active wall time counts once per commission, not per parallel agent. Pause/offline time is excluded. Checkpoint every second and at state changes; abrupt termination can lose at most the uncheckpointed interval.
- Budget exhaustion prevents new model turns; already reserved responses may finish their action batch and durable receipts. User pause/cancel retain existing abort behavior.
- Keep the existing feature branch and local user data. No automatic merge or release.

## Review focus

- Concurrent agents competing for the final turn: exactly one reservation succeeds.
- Failed planning still consumes a turn; an empty task graph cannot bypass the cap.
- Pause/resume/restart retains usage; waiting offline does not spend time.
- Stale budget edits and terminal/active commissions cannot silently overwrite limits.
- Editing limits cannot bypass pending plan approval or unknown tool reconciliation.

## Task 1: Runtime accounting and budget command

**Files:** contracts/index.ts, runtime/index.ts, runtime/budget.ts, tests/integration/runtime-budget.test.ts.
**Interfaces:** `updateBudget(id: string, budget: Budget, expectedBudgetRevision: number): Promise<CommandResult>`; optional legacy-compatible Commission fields `activeMilliseconds`, `budgetRevision`.

- [x] Write and run failing SQLite-backed tests for the review focus, validated limits and active-time persistence.
- [x] Implement bounded input validation, cumulative checkpoints, atomic turn reservation and paused-only budget updates.
- [x] Run runtime integration tests and typecheck; preserve failed and pending request states.

## Task 2: Desktop and goal-panel workflow

**Files:** desktop/main.ts, preload.ts, runtime-process.ts; client/App.tsx, BudgetPanel.tsx; tests/e2e/budget.spec.ts.

- [x] Add the validated IPC/preload method and a compact labeled form with total limits and current usage.
- [x] Keep editing separate from Continue, handle stale/errors through the existing notice path and preserve edits across unrelated snapshots.
- [x] Test the real Electron bridge, reject malformed limits and verify persisted values after renderer reload; exercise the UI form.

## Task 3: Integrated verification and handoff

- [x] Run JS, Office, build, UI and formatting checks with scene work integrated. Inspect desktop/mobile visual evidence.
- [x] Obtain an independent code review; fix material findings with regression coverage.
- [x] Record actual results and limits in stage-4 and README, then create a scoped local checkpoint commit. Real-provider acceptance remains pending until a provider is configured.
