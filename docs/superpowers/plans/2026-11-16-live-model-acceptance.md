# Live Model Acceptance Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline; request one fresh whole-branch review. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add repeatable real-runtime acceptance with independent artifact checks and honest reports.
**Architecture:** A test-only scenario schema and runner drive the public Runtime API. Real executor checks run against isolated exports; a CLI supplies configuration and unique report directories.
**Tech Stack:** Existing TypeScript, esbuild, Vitest, Node, Python Office worker.
**Spec:** `docs/superpowers/specs/2026-11-16-live-model-acceptance-design.md`

## Global Constraints

- Preserve user data and imported characters; no new dependencies or production scenario branches.
- User supplied DeepSeek credentials for live validation. Never persist credentials in reports or CLI arguments.
- Explicit host-process opt-in; no automatic approvals. Default 40 steps / 5 minutes / 2 reworks per commission.
- Unique samples, current-version hashes, independent checks, explicit live/scripted distinction.

## Review Focus

- Missing configuration or capabilities must not produce a success result or start a provider call.
- Timeouts, aborts and user requests must stop work and retain the final snapshot.
- Late file mutation, source mutation, missing artifacts and stale versions must prevent passing.
- Paths and custom manifests must not let checks escape their isolated workspace.
- Logs and reports must not disclose the API key, including model/error echoes.

## Task 1: Runner and independent evidence

**Files:** `tests/acceptance/{schema,checks,report,runner}.ts`; `tests/integration/acceptance-runner.test.ts`.
**Interfaces:** `runAcceptanceScenario(options): Promise<AcceptanceReport>` consumes a validated scenario, provider, executor paths, output root and abort signal. `checkDeliverables(...)` returns bounded check records. Report status is passed/failed/blocked/cancelled/not_run.

- [x] Write regression cases for no provider, actual file delivery and export, wrong content, input request, timeout, key redaction, path escape and source preservation.
- [x] Run targeted Vitest and observe missing runner/check behavior fail.
- [x] Implement schema, independent text/JSON/Node/Office checks, bounded lifecycle and persisted reports using the real Runtime.
- [x] Run targeted tests and typecheck; inspect a generated report and retained data.
- [x] Prepare the tested runner for the final stage commit together with live-discovered runtime fixes.

## Task 2: Scenarios and runnable CLI

**Files:** `tests/acceptance/{scenarios,cli,config}.ts`; `scripts/run-acceptance.mjs`; `tests/integration/acceptance-cli.test.ts`; `package.json`; README and stage-9 record.
**Interfaces:** `pnpm.cmd acceptance --list`; `--scenario <id>|--scenario-file <json>`, `--repeat <1..10>`, `--check`, `--key-stdin`, `--allow-process`. Environment fields: `ASTRISLE_PROVIDER_KIND`, `ASTRISLE_PROVIDER_URL`, `ASTRISLE_PROVIDER_MODEL`, `ASTRISLE_PROVIDER_API_KEY`. Reports live in `.astrisle-acceptance/`.

- [x] Write CLI tests for list, invalid inputs, missing configuration, repeats and honest exit codes; exercise Node and Office checks against real fixture files.
- [x] Observe failures; implement four scenario groups, custom JSON input and secret-safe configuration loading.
- [x] Run CLI preflight and configured DeepSeek live samples; execute full JS, Office, build and formatting checks.
- [x] Obtain a fresh whole-branch review; address material findings with reproducing tests.
- [x] Update README/stage-9 with actual verification and remaining live-validation limits; prepare final stage commit.

## Completion evidence

See `docs/development/stage-9.md` and `docs/validation/stage-9-live-model-summary.json`: 287 automated checks and nine final same-build live samples passed. The user-added model-import scope is documented in `docs/development/character-model-import.md`. Native worktree creation was unavailable because of repository ownership, so implementation used a new branch in the original clean checkout. Review corrections and the final runtime fixes were verified with reproducing tests; no user data or credentials were committed.
