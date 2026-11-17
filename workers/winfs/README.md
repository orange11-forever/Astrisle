# Windows original-project writeback

`SafeApply.cs` coordinates accepted create/modify changes on Windows. Build with
`node scripts/build-safe-apply.mjs`; this produces `dist/helpers/safe-apply.exe`
using the system .NET Framework 4 compiler and `System.Web.Extensions`, with no
additional dependencies. This is trusted-host file coordination, not a security
sandbox or a multi-file transaction. The TypeScript service separately binds the
request to accepted artifact versions, persists its operation before invoking
the helper, and obtains user approval.

## Protocol

Send one UTF-8 JSON line on stdin. One final JSON result is emitted on stdout;
structured outcomes, including refusals, use exit code 0. Production has no
fault-injection flags, pauses, or diagnostic stdout.

```json
{
  "version": 1,
  "action": "apply",
  "operationId": "caller-owned-stable-id",
  "operationDirectory": "C:\\AstrisleData\\apply-operations\\operation-id",
  "sourceRoot": "C:\\Projects\\original",
  "files": [
    {
      "path": "src/example.ts",
      "action": "modify",
      "beforeHash": "64 lowercase SHA-256 hex characters",
      "afterHash": "64 lowercase SHA-256 hex characters",
      "candidatePath": "C:\\AstrisleData\\apply-operations\\operation-id\\candidate.bin"
    }
  ]
}
```

For `create`, `beforeHash` must be `null`. The private operation directory must
already exist, be separate from the original tree, and contain the candidates.
Relative file paths accept `/` or `\`. Original parent directories may be
created safely. Original deletion is unsupported.

Inspect uses the native immutable plan, accepting only its directory:

```json
{
  "version": 1,
  "action": "inspect",
  "operationDirectory": "C:\\AstrisleData\\apply-operations\\operation-id"
}
```

Inspect returns an opaque `inspectionToken` only when `canRollback` is true.
Rollback requires that exact token from the previewed inspection; there is no
tokenless fallback:

```json
{
  "version": 1,
  "action": "rollback",
  "operationDirectory": "C:\\AstrisleData\\apply-operations\\operation-id",
  "inspectionToken": "64 lowercase SHA-256 hex characters from inspect"
}
```

Results contain:

```text
{ ok, status, message, canRollback, inspectionToken, files, conflicts }
files[] = { path, action, state, beforeHash, afterHash, currentHash, message }
```

Per-file hashes/messages can be explicit JSON `null`: ordinary files have
`message:null`, creates have `beforeHash:null`, and unverified/missing bytes have
`currentHash:null`. File states are `before`, `after`, `reserved`, `diverged`,
`missing`, and `unknown`. `conflicts` lists paths needing attention; an early
refusal can have an empty file list. `inspectionToken` is explicit JSON `null`
when unavailable, including after successful rollback and stale-token refusal.

| Status        | Meaning                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `applied`     | All writes flushed, or a completed application rechecked.                                                              |
| `not_started` | No native plan/data write, or a preflight abort with owned reservations cleaned. Empty created directories may remain. |
| `rolled_back` | Verified originals restored and owned created files removed.                                                           |
| `conflict`    | Baseline/candidate mismatch or CREATE_NEW collision; no owned source file changes/reservations remain.                 |
| `busy`        | Required sharing conditions/operation lock unavailable; no new source data write started.                              |
| `unsupported` | Request/path/file cannot meet safety conditions; no owned source file changes/reservations remain.                     |
| `interrupted` | Own changes may remain, files diverge, or recovery paths cannot be verified. Do not replay apply.                      |
| `unknown`     | Native state/result is incomplete, malformed, or cannot be trusted. Preserve originals and backups for inspection.     |

`ok` is true only for `applied`, `not_started`, and `rolled_back`. `canRollback`
means inspected current changes can be restored without overwriting later edits.
The token SHA-256 binds the immutable native plan, operation ID/private directory,
journal sequence, every file's observed state/hash/actual identity, and the exact
implied restore subset. It includes baseline files omitted from a restore preview,
so a later baseline-to-candidate transition cannot silently add files to rollback.
All values are recomputed under final exclusive target handles before any rollback
journal append or source mutation. Missing/mismatched tokens return `interrupted`;
a mismatch lists the operation paths, clears `canRollback` and the token, and
requires a new inspection and confirmation. This is snapshot binding, not a
secret authentication credential; the caller still owns the user approval flow.
Busy/interrupted/unknown must not release the caller's unresolved-operation gate.
Repeating apply compares the immutable request and inspects; it never resumes
source data writes.

## Filesystem guarantees

Directory handles request `FILE_LIST_DIRECTORY`, share READ, omit DELETE sharing,
and remain open until completion. This blocks rename replacement; attribute-only
handles do not. Sharing alone does **not** stop attribute-only
`FSCTL_SET_REPARSE_POINT` writers on empty directories, as the real fixture proves.

Every non-volume-root child open therefore uses `NtCreateFile` with the immediate
already-open parent as `OBJECT_ATTRIBUTES.RootDirectory`, a single child name,
`OBJ_DONT_REPARSE`, and `FILE_OPEN_REPARSE_POINT`. New directories use
`FILE_OPEN_IF` plus `FILE_DIRECTORY_FILE`. Final handle paths, identities, and
ordinary-file/reparse attributes are verified. Checks never substitute for
anchoring the subsequent lookup. Private state, candidates, backups, journal,
source files, and new parents all use this mechanism.

Candidates are SHA-256 checked into immutable memory before source changes.
Every existing target is opened with read/write/delete access and share mode 0,
rehashed while held, and kept open across backup, write, and flush. New files use
`FILE_CREATE` (`CREATE_NEW` semantics); a foreign file appearing after preparation
cannot be overwritten. All existing target locks are acquired before source data
writes. Failed creation preflight removes only owned reservations by their still
held creating handles.

The private directory contains `native-plan.json`, `native-journal.ndjson`,
`native-lock`, and `native-backup-N.bin`. Plan/backups use exclusive creation;
backups are flushed before source mutation. The append-only journal binds the
plan by SHA-256, checks sequences/record structure, and flushes each
identity/intent/receipt. Contents and journal records use
`Flush(true)`/`FlushFileBuffers`; durability depends on the device honoring
flushes. No atomicity across files or hardware-failure guarantee is claimed.

Recovery compares volume serial number plus 64-bit file index and full SHA-256
hashes while holding all current target handles. Rollback preflights the whole
set before changing any file. It restores only recorded identities with exact
candidate bytes, and removes only owned matching creations by handle. Later user
edits, replacement identities, missing originals, uncertain ownership, or
ambiguous partial bytes cause refusal with backups retained. In-place writing
can leave divergent bytes after a crash; the helper reports them instead of
guessing. A crash between CREATE_NEW and its durable identity receipt can leave
an empty file whose ownership cannot be proven; it is retained for inspection.
Created directories are intentionally retained, including empty directories after
rollback or preflight refusal.

Only local fixed NTFS volumes and ordinary files are supported. Reparse points,
hardlinks, UNC/device/alternate-stream paths, aliases, traversal, case collisions,
reserved Windows names, `.git`, and `.astrisle*` components are rejected. Paths
must be shorter than 240 characters. Limits are 512 files, 32 MiB per file, and
256 MiB each for candidate/original byte sets. ACL/sharing failures cause refusal;
an actual external writable mapping is tested as a sharing conflict. This helper
does not defend against a malicious process with the same user privileges
forging trusted operation records.

## Verification

`tests/integration/winfs-apply.test.ts` uses real NTFS files and independent
processes. A separate `TEST_HOOKS` build plus real junction/writable-mapping
fixtures are compiled into canonical temporary directories and removed after
tests. Checkpoints are absent from production. Tests install a real junction
immediately after the last parent reparse check and before the native child open,
verify candidate/private-state boundaries, attempt external writes/renames, kill
the actual helper during/after writes, and recover against later edits and
replacement identities.

References: [NtCreateFile](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile),
[OBJECT_ATTRIBUTES](https://learn.microsoft.com/en-us/windows/win32/api/ntdef/ns-ntdef-_object_attributes),
[CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew),
[GetFileInformationByHandle](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfileinformationbyhandle),
[FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers),
[SetFileInformationByHandle](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle).
