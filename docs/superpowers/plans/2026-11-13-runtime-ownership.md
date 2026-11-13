# Runtime ownership implementation plan

> **For agentic workers:** Use superpowers:executing-plans. This is the next bounded increment of the existing v0.1 plan, not completion of all Task 14 requirements.

**Goal:** Prevent two runtimes from recovering or writing the same data directory, and keep ownership until ongoing commands and runs have stopped.

**Architecture:** Hold an exclusive SQLite transaction in a separate ownership database for the runtime lifetime. Acquire it before opening/migrating/recovering the business store. The business database allocates a durable, increasing runtime epoch and tags new calls; ordinary completion only accepts running calls from the matching epoch. Startup interruption uses a separate recovery operation.

**Tech Stack:** Existing Node 22, TypeScript, node:sqlite, Vitest and esbuild; no new dependencies.

**Spec:** ../specs/2026-11-11-astrisle-system-design.md, sections 4.1, 6.2, 8.3 and 9; continuation of Tasks 6/14 in 2026-11-11-astrisle-v0.1.md.

## Global Constraints

- Same local data directory has one active runtime, including while paused, shutting down or unresponsive. Different data directories remain independent.
- Never take over a live process on a heartbeat timeout. OS releases the SQLite lock after process death; never delete the lock database to recover.
- Preserve existing uncertain-call reconciliation; process death does not prove external child effects stopped.
- No original-project writeback, provider credentials, visual changes or publishing in this increment.
- Continue on the existing clean feat/runtime-continuity development branch as established by the stage handoff.

## Approaches

The existing specification already requires exclusive ownership and epochs. A PID file leaves stale ownership and PID reuse issues; a heartbeat lease can expire while a writer remains alive. A separate SQLite exclusive transaction uses the existing dependency and OS lock lifecycle without holding a write transaction on business data. This implementation choice is made for the resumed development task.

## Review Focus

- Concurrent startups must not migrate or recover the losing process's business data.
- A blocked event loop must retain ownership; crash recovery must preserve unknown effects.
- Startup exceptions and simultaneous close calls must not leak or release ownership early.
- Commands begun before close must settle before ownership release; later commands must have no effects.
- Old, duplicate and reconciled call results must not overwrite a durable receipt.

### Task 1: Runtime ownership, lifecycle and call generations

**Files:** Create packages/runtime/src/ownership.ts, tests/fixtures/runtime-owner-worker.ts, tests/integration/runtime-ownership.test.ts. Modify packages/runtime/src/index.ts, packages/persistence/src/index.ts, apps/desktop/src/runtime-process.ts and tests/e2e/desktop.spec.ts. Document the verified result in README.md and docs/development/stage-5.md.

**Interfaces:** RuntimeOwnership(dataRoot).release(): void; RuntimeStore.beginRuntime(): number; StoredCall.runtimeEpoch: number; endCall(id, data, epoch?) validates epoch and running state; interruptCall(id, reason) is startup-only recovery. RuntimeService gains exportWorkspace(id, destination), prepareApply(id), apply(operationId), moving the existing desktop operations inside its lifecycle. Renderer HostAPI and desktop bridge method names remain unchanged.

- [x] Write tests rejecting same-process and real-process competing startup without changing snapshots; allow independent roots; reacquire after graceful close and forced process death, including an unresponsive owner.
- [x] Write tests for startup failure cleanup, concurrent close, in-flight commands, rejection of post-close commands and stale/duplicate/reconciled completion. Existing crash tests continue proving unknown effects are not replayed.
- [x] Run `pnpm.cmd exec vitest run tests/integration/runtime-ownership.test.ts`; expected failure for missing ownership/epoch/lifecycle behavior.
- [x] Implement ownership before business storage, persistent epoch migration and completion fencing. Keep the lock through pending commands and executing tasks; release on fully completed shutdown or failed startup.
- [x] Run the targeted test and existing runtime suites; expected all pass.
- [x] Run `pnpm.cmd test`, `pnpm.cmd build`, `pnpm.cmd test:ui`, native Windows Office pytest, formatting and diff checks; expected all pass. Record precise limitations and results.
- [x] Obtain independent code review, fix important issues with regression tests, and create a local checkpoint commit. Do not merge, push or publish.
