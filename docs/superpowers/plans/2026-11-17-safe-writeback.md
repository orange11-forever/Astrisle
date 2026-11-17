# Safe Writeback Implementation Plan

> **For agentic workers:** Use inline implementation with an isolated native-helper worker and one fresh whole-branch review. Track steps with checkboxes.

**Goal:** Apply accepted versions to original projects with verified Windows exclusion and recoverable per-file evidence.
**Architecture:** Native helper owns file handles/backups/journal. Workspace service snapshots immutable candidates and persists operation state in RuntimeStore. Runtime holds a workspace lease; desktop confirms each apply/rollback and displays history.
**Tech Stack:** Existing TypeScript, SQLite, Electron, .NET Framework C#, Vitest, Playwright.
**Spec:** `docs/superpowers/specs/2026-11-17-safe-writeback-design.md`.

## Global Constraints

- No .astrisle-dev mutations during development; all writeback tests use synthetic temporary projects.
- Accepted/current versions only, no source Git metadata writes, no silent replay after interruption.
- Existing runtime deletion-evidence restriction remains; new/modified files and removal of own creates during rollback are supported.
- No new dependencies; Windows local NTFS only; source/file identity and hash are rechecked under handles.

## Review Focus

- Candidate or source mutation after preview; original user edits must survive.
- Handle-sharing races, reparse/rename/hardlink substitutions and foreign new files.
- Crash after a write but before receipt; unknown state must remain gated after restart.
- Stale revisions, unaccepted/unpublished changes and concurrent submit/resume/revise.
- Rollback over later external changes, missing/corrupt journal or backups, duplicate commands.

### Task 1: Native coordination

- [x] Real NTFS RED tests for locks, exclusive creation, later edits, crashes, rollback, replay and path substitution.
- [x] Implement bounded SafeApply.cs and reproducible build-safe-apply.mjs.
- [x] Verify all native tests, production and TEST_HOOKS separation.

### Task 2: Persisted orchestration

- [x] Add operation schema/store and tests for accepted-version binding, snapshots, recovery and stale/extra changes.
- [x] Add supervised native driver and workspace apply service; persist applying before side effects.
- [x] Connect runtime leases, recovery discovery and post-apply baseline updates; verify restart and concurrent mutation gates.

### Task 3: Desktop integration and verification

- [x] Add native confirmation for rollback and operation history/diffs in existing delivery panel.
- [x] Build helper in test/desktop workflows; update capabilities and docs.
- [x] Run actual Electron apply/cancel/rollback tests, full JS/Office/UI checks and bounded visual inspection.
- [x] Obtain fresh review, fix material findings and record actual limits; prepare verified stage commit and remote PR as requested.
