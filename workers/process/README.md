# Windows process supervisor

`ProcessSupervisor.cs` is a Windows 10+ x64 .NET Framework console helper. Build
with `node scripts/build-process-supervisor.mjs`; tests and desktop builds do this
automatically. The built helper lives in `dist/helpers/`, not in task workspaces.
The Windows .NET Framework 4.x C# compiler is used; no downloaded package or
runtime compilation is needed. A missing helper rejects execution.

The initial UTF-8 JSON line has protocol `version: 1`, executable `command`,
`args`, `cwd`, base64 `input`, `timeoutMs` and `outputLimit`. Later `stop` or EOF
revokes the call. stdout contains only versioned `started`, base64 `output`,
`receipt` or `error` messages; target stdout/stderr share a separate pipe.

CreateProcess receives a job-list attribute and an explicit two-handle stdio
inheritance list. The target is created suspended inside a job before resuming.
The supervisor alone owns the non-inheritable, unnamed job handle, with
KILL_ON_JOB_CLOSE and neither breakaway flag. On cancellation, timeout, output
limit, owner disconnect or root exit, the job is terminated. A receipt confirms
termination only after QueryInformationJobObject reports ActiveProcesses == 0.
This also cleans detached descendants after a successful root exit. Terminating
the supervisor closes the job handle; losing the receipt still means unknown.

This is a lifetime boundary for ordinary child processes, not a security sandbox.
Trusted executables can access host files, network and external services. Work
delegated through external services is not necessarily a descendant. Stopping
processes does not undo writes or external effects. No result implies rollback.
