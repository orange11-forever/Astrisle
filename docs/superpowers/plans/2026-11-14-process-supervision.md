# Executor Process Supervision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Windows executor process trees with independently queryable Job Object receipts, retaining unknown outcomes when confirmation is lost.

**Architecture:** A small C# supervisor creates the executable suspended inside a non-breakaway, kill-on-close Windows Job Object using a creation-time job attribute, and only then resumes it. The TypeScript executor exchanges bounded control/output messages with the supervisor and accepts a stopped receipt only after the job reports zero active processes. Process tools and Office workers share this path; existing runtime receipts and reconciliation persist the result.

**Tech Stack:** Existing Node.js 22.13+, TypeScript, Vitest, Windows .NET Framework C# compiler and Win32 Job APIs; no new npm or Python dependencies.

**Spec:** `docs/superpowers/specs/2026-11-11-astrisle-system-design.md`, original v0.1 plan Tasks 3/14, and `docs/development/stage-5.md` next-step handoff. This narrows the existing authorized work; it does not enable original-project writeback.

## Global Constraints

- Windows remains the supported desktop target; trusted host execution is not a security sandbox.
- The original executable receives a minimal environment, direct arguments, redirected streams and its granted working directory; no shell interpolation.
- Cancellation, timeout and output-limit completion must not claim success or rollback. Stopping a process does not undo file or external side effects.
- No breakaway flags or inheritable job handles; unavailable supervision fails before running the target.
- Lost, malformed or unconfirmed supervisor receipts remain `OUTCOME_UNKNOWN` and cannot trigger automatic replay.
- Preserve `.astrisle-dev/` and user assets. Keep development on a feature branch; no automatic push, merge or release.

## Review Focus

1. A target creates grandchildren, detaches, or exits while descendants remain: all ordinary descendants must stop before completion.
2. Runtime or supervisor dies: kill-on-close/parent-pipe EOF must stop the job; a missing receipt stays unknown.
3. Cancellation races launch or normal completion: never resume an uncontained target or downgrade an unknown result to success.
4. Large stdout/stderr or blocked stdin: output stays bounded and control/termination still works.
5. Unicode, quotes, empty arguments, environment isolation and helper availability: preserve invocation semantics and fail closed before target execution.

## Decisions

- Compile the checked-in C# source into `dist/helpers/process-supervisor.exe` before tests and desktop builds using the Windows .NET Framework compiler. Do not compile or install tools at invocation time.
- Use a versioned line protocol over the supervisor's stdin/stdout; target output is base64 payload, so target text cannot impersonate receipts. Control stdin remains open until the final receipt; EOF terminates the job.
- On root process exit, terminate remaining job members and confirm zero active processes. Background services cannot outlive a tool call.
- Keep non-Windows execution as the existing process-group implementation and clearly scope new guarantees to Windows.
- A confirmed stop records process termination only, not rollback or successful task completion. Reconciliation remains required when the supervisor cannot supply a valid final receipt.

## Task 1: Contained Windows process lifecycle

**Files:**
- Create: `workers/process/ProcessSupervisor.cs`, `workers/process/README.md`
- Create: `scripts/build-process-supervisor.mjs`
- Create: `packages/executor/src/windows-process.ts`
- Modify: `packages/executor/src/process.ts`, `packages/executor/src/index.ts`
- Modify: `package.json`, `scripts/build-desktop.mjs`
- Test: `tests/integration/process-stop.test.ts`, `tests/integration/executor-process-web.test.ts`

**Interfaces:**
- `runProcess(command, args, options): Promise<ProcessResult>` gains `supervisorPath?: string` in options and optional typed `termination` evidence in the result.
- `runWindowsProcess(command, args, options): Promise<ProcessResult>` supervises Windows only; receipt includes mechanism, supervisor PID, root PID, active process count and confirmation timestamp when known.
- `createExecutor({ projectRoot, pythonPath? })` locates the built helper in its project root for both process and Office tools.

- [x] Write failing real-process tests: cancellation kills parent/child/grandchild, root exit cleans descendants, timeout and output limit stop the job, stdin and tricky arguments survive, pre-abort/missing executable never creates output, missing supervisor fails closed.
- [x] Run `pnpm.cmd exec vitest run tests/integration/process-stop.test.ts tests/integration/executor-process-web.test.ts`; capture the expected missing-containment/receipt failures (6 failed, 5 passed).
- [x] Implement the supervisor, build step and TypeScript adapter, preserving minimal environment and bounded/redacted logs. Check each Win32 return value; bound drain and protocol buffers; close handles in all failure paths.
- [x] Run the focused tests (11 passed), `pnpm.cmd typecheck` and formatting; full JS suite 143 passed. Commit the independently working lifecycle.

## Task 2: Failure receipts and durable cancellation

**Files:**
- Create: `tests/fixtures/process-tree.cjs`, `tests/fixtures/process-supervisor-host.ts` as needed for real process trees and host-crash tests.
- Modify: `tests/integration/process-stop.test.ts`, `tests/integration/runtime-execution.test.ts`, `tests/integration/executor-office.test.ts`
- Modify: `packages/executor/src/windows-process.ts`, `packages/executor/src/index.ts` where tests identify receipt gaps.

**Interfaces:**
- Existing runtime `StoredCall.result` and tool evidence retain the complete `metadata.termination` receipt.
- Office stopped results propagate the same termination evidence and distinguish aborted, timeout and output-limit reasons.

- [x] Exercise supervisor loss, owner-process death, malformed receipts and real runtime cancel-to-persisted-receipt. Office evidence/capability gaps first failed 3 tests; invalid Office exit/response handling failed another 3 tests. Unknown outcomes survive restart and block dispatch.
- [x] Preserve Office termination evidence and reject nonzero exits or malformed responses. Keep existing unknown-outcome reconciliation and generation checks unchanged.
- [x] Run the focused executor/runtime/Office integration tests, full JS suite and blocked-input/forged-output cases; commit. Final counts are recorded in `docs/development/stage-6.md`.

## Task 3: Delivery verification and handoff

**Files:** `README.md`, `docs/development/stage-6.md`, this plan.

- [x] Update capabilities, setup/build requirements, verified boundaries and next steps in README/stage record.
- [x] Run JS/Office/build/UI/type/format/diff checks. Restore only the screenshot regenerated by tests; scene changes follow as separately requested work.
- [x] Obtain one independent whole-branch review; fix inconsistent confirmed receipts with two RED-to-GREEN regressions; full JS 160 passed.
- [x] Commit the verified stage checkpoint; retain the feature branch for user review. Continue the user's additional island-life plan in this same session.

## API references

- [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [ActiveProcesses accounting](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information)
- [AssignProcessToJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject)
