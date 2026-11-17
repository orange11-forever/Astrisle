// Windows local NTFS write coordination. This helper is a trusted-host tool,
// not a security sandbox or a multi-file transaction. No production fault flags.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal static class SafeApply
{
    const uint Read = 0x80000000, Write = 0x40000000, Delete = 0x10000;
    const uint OpenReparse = 0x00200000, BackupSemantics = 0x02000000;
    const int MaxFile = 32 * 1024 * 1024;
    static bool MutationMayRemain;
    static readonly Dictionary<string, SafeFileHandle> DirectoryPins = new Dictionary<string, SafeFileHandle>(StringComparer.OrdinalIgnoreCase);
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024, RecursionLimit = 32 };
    static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);

    public sealed class Item
    {
        public string path { get; set; }
        public string action { get; set; }
        public string beforeHash { get; set; }
        public string afterHash { get; set; }
        public string candidatePath { get; set; }
    }
    public sealed class Request
    {
        public int version { get; set; }
        public string action { get; set; }
        public string operationId { get; set; }
        public string operationDirectory { get; set; }
        public string sourceRoot { get; set; }
        public Item[] files { get; set; }
        public string inspectionToken { get; set; }
#if TEST_HOOKS
        public string testPauseBeforeNativeOpen { get; set; }
        public bool testPauseCreatedBeforeIdentity { get; set; }
#endif
    }
    public sealed class Record
    {
        public int seq { get; set; }
        public string kind { get; set; }
        public int index { get; set; }
        public string identity { get; set; }
        public string planHash { get; set; }
    }
    public sealed class FileResult
    {
        public string path { get; set; }
        public string action { get; set; }
        public string state { get; set; }
        public string beforeHash { get; set; }
        public string afterHash { get; set; }
        public string currentHash { get; set; }
        public string message { get; set; }
    }
    public sealed class Result
    {
        public bool ok { get; set; }
        public string status { get; set; }
        public string message { get; set; }
        public bool canRollback { get; set; }
        public string inspectionToken { get; set; }
        public List<FileResult> files = new List<FileResult>();
        public List<string> conflicts = new List<string>();
    }
    sealed class Failure : Exception
    {
        public readonly string Status;
        public Failure(string status, string message) : base(message) { Status = status; }
    }
    sealed class OpenFile : IDisposable
    {
        public readonly FileStream Stream;
        public readonly string Identity;
        public OpenFile(string path, uint access, uint disposition)
        {
            var handle = NativeOpen(path, access, 0, disposition, OpenReparse);
            try
            {
                var info = Information(handle);
                Ordinary(info, false);
                VerifyFinal(handle, path);
                Identity = Id(info);
                Stream = new FileStream(handle, access == Read ? FileAccess.Read : FileAccess.ReadWrite, 4096, false);
            }
            catch
            {
                if (disposition == 1 && (access & Delete) != 0)
                {
                    var cleanup = new FileDisposition { DeleteFile = true };
                    if (!SetFileInformationByHandle(handle, 4, ref cleanup, 1)) { handle.Dispose(); throw new Failure("unknown", "Created file requires manual inspection; handle cleanup failed"); }
                }
                handle.Dispose(); throw;
            }
        }
        public byte[] Bytes()
        {
            if (Stream.Length > MaxFile) throw new Failure("unsupported", "File exceeds 32 MiB");
            Stream.Position = 0;
            byte[] bytes = new byte[(int)Stream.Length];
            int read = 0;
            while (read < bytes.Length)
            {
                int count = Stream.Read(bytes, read, bytes.Length - read);
                if (count == 0) throw new IOException("Unexpected end of file");
                read += count;
            }
            return bytes;
        }
        public void Replace(byte[] bytes, int index, bool checkpoint)
        {
            Stream.Position = 0;
#if TEST_HOOKS
            if (checkpoint && bytes.Length > 1)
            {
                int half = bytes.Length / 2;
                Stream.Write(bytes, 0, half); Stream.Flush(true);
                Checkpoint("mid_write:" + index);
                Stream.Write(bytes, half, bytes.Length - half);
            }
            else
#endif
            { Stream.Write(bytes, 0, bytes.Length); }
            Stream.SetLength(bytes.Length);
            Stream.Flush(true);
            Check(FlushFileBuffers(Stream.SafeFileHandle), "Flush original");
        }
        public void Remove()
        {
            var disposition = new FileDisposition { DeleteFile = true };
            Check(SetFileInformationByHandle(Stream.SafeFileHandle, 4, ref disposition, 1), "Remove owned creation");
        }
        public void Dispose() { Stream.Dispose(); }
    }

    sealed class Operation : IDisposable
    {
        public readonly string Directory;
        public readonly List<IDisposable> Handles = new List<IDisposable>();
        readonly HashSet<string> pinned = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        public FileStream Journal;
        public int Sequence;
        public Request Plan;
        public string PlanDigest;
        public readonly Dictionary<int, string> Identities = new Dictionary<int, string>();
        public readonly HashSet<int> Intents = new HashSet<int>();
        public readonly HashSet<int> Rollbacks = new HashSet<int>();
        public readonly HashSet<int> Reservations = new HashSet<int>();
        public bool Applied, RolledBack, Aborted;
        public Operation(string directory)
        {
            Directory = Absolute(directory);
            Pin(Directory, false);
            var lockHandle = NativeOpen(Path.Combine(Directory, "native-lock"), Read | Write, 0, 4, OpenReparse);
            try { Ordinary(Information(lockHandle), false); VerifyFinal(lockHandle, Path.Combine(Directory, "native-lock")); }
            catch { lockHandle.Dispose(); throw; }
            Handles.Add(lockHandle);
        }
        // FILE_READ_ATTRIBUTES alone is insufficient: it does not participate in
        // data/delete sharing. FILE_LIST_DIRECTORY + share READ pins names.
        // Attribute-only reparse writers remain possible; all children therefore
        // use anchored NtCreateFile opens and reparse checks, not path-based I/O.
        public void Pin(string directory, bool create)
        {
            directory = Absolute(directory);
            if (pinned.Contains(directory)) return;
            string root = Path.GetPathRoot(directory);
            string current = root;
            var parts = directory.Substring(root.Length).Split(new char[] { '\\' }, StringSplitOptions.RemoveEmptyEntries);
            PinOne(current, false);
            foreach (string part in parts)
            {
                current = Path.Combine(current, part);
                if (pinned.Contains(current)) continue;
                PinOne(current, create);
            }
        }
        void PinOne(string directory, bool create)
        {
            if (pinned.Contains(directory)) return;
            var handle = NativeOpen(directory, 1, 1, create ? 4u : 3u, OpenReparse | BackupSemantics);
            try { Ordinary(Information(handle), true); VerifyFinal(handle, directory); }
            catch { handle.Dispose(); throw; }
            Handles.Add(handle); pinned.Add(directory); DirectoryPins.Add(directory, handle);
        }
        public void Append(string kind, int index, string identity)
        {
            var record = new Record { seq = Sequence++, kind = kind, index = index, identity = identity };
            byte[] bytes = Utf8.GetBytes(Json.Serialize(record) + "\n");
            Journal.Write(bytes, 0, bytes.Length); Journal.Flush(true);
            Check(FlushFileBuffers(Journal.SafeFileHandle), "Flush journal");
        }
        public void Dispose()
        {
            if (Journal != null) Journal.Dispose();
            for (int index = Handles.Count - 1; index >= 0; index--) Handles[index].Dispose();
        }
    }

    static void Main()
    {
        // Redirected .NET Framework consoles otherwise inherit the Windows OEM
        // code page, which can silently change authorized Unicode path names.
        Console.InputEncoding = Utf8;
        Console.OutputEncoding = new UTF8Encoding(false);
        Result result;
        try
        {
            string line = ReadLine(8 * 1024 * 1024);
            var request = Json.Deserialize<Request>(line);
#if TEST_HOOKS
            PauseBeforeOpen = request == null ? null : request.testPauseBeforeNativeOpen;
#endif
            if (request == null || request.version != 1) throw new Failure("unsupported", "Unsupported protocol");
            if (request.action != "apply" && request.action != "inspect" && request.action != "rollback") throw new Failure("unsupported", "Unsupported action");
            MutationMayRemain = request.action != "apply";
            if (request.action == "rollback" && !IsHash(request.inspectionToken)) throw new Failure("interrupted", "Rollback requires the token from a fresh native inspection");
            using (var operation = new Operation(request.operationDirectory))
            {
                bool exists = File.Exists(Path.Combine(operation.Directory, "native-plan.json"));
                if (!exists && (File.Exists(Path.Combine(operation.Directory, "native-journal.ndjson")) || System.IO.Directory.GetFiles(operation.Directory, "native-backup-*").Length != 0)) throw new Failure("unknown", "Native journal or backups exist without their immutable plan");
                if (exists)
                {
                    MutationMayRemain = true;
                    Load(operation);
                    if (request.action == "apply")
                    {
                        Validate(request, operation.Directory);
                        if (!SamePlan(request, operation.Plan)) throw new Failure("interrupted", "Operation ID or immutable plan differs; inspect existing operation before starting another");
                    }
                    result = Recover(operation, request.action == "rollback", request.inspectionToken);
                }
                else if (request.action != "apply")
                {
                    result = Make("not_started", "No native operation has started");
                }
                else result = Apply(operation, request);
            }
        }
        catch (Failure error) { result = Make(MutationMayRemain && error.Status != "unknown" ? "interrupted" : error.Status, error.Message); }
        catch (Win32Exception error) { result = Make(MutationMayRemain ? "interrupted" : error.NativeErrorCode == 32 || error.NativeErrorCode == 33 ? "busy" : "unsupported", error.Message); }
        catch (Exception error) { result = Make("unknown", error.Message); }
        Console.Out.WriteLine(Json.Serialize(result)); Console.Out.Flush();
    }

    static Result Apply(Operation operation, Request request)
    {
        Validate(request, operation.Directory);
        operation.Plan = request;
        var staged = new List<byte[]>();
        long total = 0;
        // Read candidate bytes while pinned and locked, then hold immutable memory.
        foreach (var item in request.files)
        {
            operation.Pin(Path.GetDirectoryName(item.candidatePath), false);
            using (var candidate = new OpenFile(item.candidatePath, Read, 3))
            {
                byte[] bytes = candidate.Bytes(); total += bytes.Length;
                if (total > 256L * 1024 * 1024) throw new Failure("unsupported", "Candidate set exceeds 256 MiB");
                if (Hash(bytes) != item.afterHash) throw new Failure("conflict", "Candidate hash mismatch: " + item.path);
                staged.Add(bytes);
            }
        }
        operation.Pin(request.sourceRoot, false);
        foreach (var item in request.files) operation.Pin(Path.GetDirectoryName(Target(request, item)), true);
        Checkpoint("prepared");

        var opened = new Dictionary<int, OpenFile>();
        try
        {
            // Acquire every existing file's exclusive lock before any original write.
            long originalTotal = 0;
            var originals = new Dictionary<int, byte[]>();
            for (int i = 0; i < request.files.Length; i++)
            {
                var item = request.files[i];
                if (item.action != "modify") continue;
                OpenFile file;
                try { file = new OpenFile(Target(request, item), Read | Write | Delete, 3); }
                catch (Win32Exception error) { if (error.NativeErrorCode == 2 || error.NativeErrorCode == 3) throw new Failure("conflict", "Original missing: " + item.path); throw; }
                opened.Add(i, file);
                byte[] original = file.Bytes(); originalTotal += original.Length;
                if (originalTotal > 256L * 1024 * 1024) throw new Failure("unsupported", "Original set exceeds 256 MiB");
                if (Hash(original) != item.beforeHash) throw new Failure("conflict", "Original changed: " + item.path);
                originals.Add(i, original);
            }
            // Plan + journal are CREATE_NEW and flushed before any reservation/write.
            byte[] plan = Utf8.GetBytes(Json.Serialize(request));
            DurableNew(Path.Combine(operation.Directory, "native-plan.json"), plan);
            operation.Journal = NewStream(Path.Combine(operation.Directory, "native-journal.ndjson"));
            byte[] header = Utf8.GetBytes(Json.Serialize(new Record { seq = 0, kind = "header", index = -1, planHash = Hash(plan) }) + "\n");
            operation.Journal.Write(header, 0, header.Length); operation.Journal.Flush(true); operation.Sequence = 1;
            foreach (var pair in opened) operation.Append("locked", pair.Key, pair.Value.Identity);
            foreach (var pair in originals) DurableNew(Backup(operation, pair.Key), pair.Value);
            Checkpoint("locked");

            try
            {
                for (int i = 0; i < request.files.Length; i++)
                {
                    var item = request.files[i];
                    if (item.action != "create") continue;
                    operation.Append("reserve_intent", i, null);
                    MutationMayRemain = true;
                    OpenFile file;
                    try { file = new OpenFile(Target(request, item), Read | Write | Delete, 1); }
                    catch (Win32Exception error) { if (error.NativeErrorCode == 80 || error.NativeErrorCode == 183) throw new Failure("conflict", "New destination already exists: " + item.path); throw; }
                    opened.Add(i, file);
#if TEST_HOOKS
                    if (request.testPauseCreatedBeforeIdentity) Checkpoint("created_unrecorded:" + i);
#endif
                    operation.Append("reserved", i, file.Identity);
                    Checkpoint("reserved:" + i);
                }
                foreach (var pin in DirectoryPins.Values) Ordinary(Information(pin), true);
            }
            catch (Exception error)
            {
                // No original data write yet. Delete only creations still held by
                // our CREATE_NEW handles; never perform path-based cleanup.
                foreach (var pair in opened) if (request.files[pair.Key].action == "create") { pair.Value.Remove(); operation.Append("removed", pair.Key, pair.Value.Identity); }
                var failure = error as Failure;
                if (failure != null && failure.Status == "unknown") throw;
                operation.Append("aborted", -1, null); MutationMayRemain = false; throw;
            }

            for (int i = 0; i < request.files.Length; i++)
            {
                MutationMayRemain = true;
                operation.Append("write_intent", i, opened[i].Identity);
                opened[i].Replace(staged[i], i, true);
                operation.Append("written", i, opened[i].Identity);
                Checkpoint("after_write:" + i);
            }
            operation.Append("applied", -1, null);
            var result = Make("applied", "All requested files flushed; durable backups retained");
            result.canRollback = true;
            foreach (var item in request.files) result.files.Add(State(item, "after", item.afterHash, null));
            return result;
        }
        finally { foreach (var file in opened.Values) file.Dispose(); }
    }

    static void Load(Operation operation)
    {
        try
        {
            byte[] planBytes;
            using (var file = new OpenFile(Path.Combine(operation.Directory, "native-plan.json"), Read, 3)) { planBytes = file.Bytes(); }
            operation.PlanDigest = Hash(planBytes);
            operation.Plan = Json.Deserialize<Request>(Utf8.GetString(planBytes));
            Validate(operation.Plan, operation.Directory);
            operation.Journal = new FileStream(NativeOpen(Path.Combine(operation.Directory, "native-journal.ndjson"), Read | Write, 0, 3, OpenReparse), FileAccess.ReadWrite);
            Ordinary(Information(operation.Journal.SafeFileHandle), false);
            VerifyFinal(operation.Journal.SafeFileHandle, Path.Combine(operation.Directory, "native-journal.ndjson"));
            if (operation.Journal.Length > 4 * 1024 * 1024) throw new InvalidDataException("Journal too large");
            byte[] bytes = new byte[(int)operation.Journal.Length]; int offset = 0;
            while (offset < bytes.Length) { int count = operation.Journal.Read(bytes, offset, bytes.Length - offset); if (count == 0) throw new InvalidDataException("Journal truncated"); offset += count; }
            string text = Utf8.GetString(bytes);
            if (!text.EndsWith("\n", StringComparison.Ordinal)) throw new InvalidDataException("Incomplete journal record");
            string[] lines = text.Split('\n');
            var written = new HashSet<int>();
            var removed = new HashSet<int>();
            var reserveIntents = new HashSet<int>();
            for (int n = 0; n < lines.Length - 1; n++)
            {
                var record = Json.Deserialize<Record>(lines[n]);
                if (record == null || record.seq != n) throw new InvalidDataException("Journal sequence invalid");
                if (n == 0)
                {
                    if (record.kind != "header" || record.index != -1 || record.planHash != Hash(planBytes)) throw new InvalidDataException("Plan or journal header differs");
                    continue;
                }
                bool global = record.kind == "applied" || record.kind == "rollback_complete" || record.kind == "aborted";
                if (global)
                {
                    if (record.index != -1) throw new InvalidDataException("Invalid global journal record");
                    if (record.kind == "applied") { if (written.Count != operation.Plan.files.Length || operation.Applied || operation.Aborted) throw new InvalidDataException("Incomplete apply receipt"); operation.Applied = true; }
                    if (record.kind == "aborted") { if (operation.Intents.Count != 0 || removed.Count != operation.Reservations.Count) throw new InvalidDataException("Aborted with writes or uncleaned reservations"); operation.Aborted = true; }
                    if (record.kind == "rollback_complete") operation.RolledBack = true;
                    continue;
                }
                int index = record.index;
                if (index < 0 || index >= operation.Plan.files.Length) throw new InvalidDataException("Journal file index invalid");
                var item = operation.Plan.files[index];
                if (record.kind == "reserve_intent") { if (item.action != "create" || !reserveIntents.Add(index)) throw new InvalidDataException("Invalid reserve intent"); continue; }
                if (record.kind == "locked" || record.kind == "reserved")
                {
                    if (record.kind == "locked" && item.action != "modify" || record.kind == "reserved" && (item.action != "create" || !reserveIntents.Contains(index))) throw new InvalidDataException("Invalid identity record");
                    if (String.IsNullOrEmpty(record.identity) || operation.Identities.ContainsKey(index)) throw new InvalidDataException("Invalid or duplicate identity");
                    operation.Identities.Add(index, record.identity);
                    if (record.kind == "reserved") operation.Reservations.Add(index);
                    continue;
                }
                string identity;
                if (!operation.Identities.TryGetValue(index, out identity) || identity != record.identity) throw new InvalidDataException("Journal identity differs");
                if (record.kind == "write_intent") { if (!operation.Intents.Add(index)) throw new InvalidDataException("Duplicate write intent"); }
                else if (record.kind == "written") { if (!operation.Intents.Contains(index) || !written.Add(index)) throw new InvalidDataException("Invalid written record"); }
                else if (record.kind == "rollback_intent") { operation.Rollbacks.Add(index); }
                else if (record.kind == "rolledback") { if (!operation.Rollbacks.Contains(index)) throw new InvalidDataException("Rollback lacks intent"); }
                else if (record.kind == "removed") { if (item.action != "create" || !operation.Reservations.Contains(index) || operation.Intents.Contains(index) || !removed.Add(index)) throw new InvalidDataException("Invalid removal record"); }
                else throw new InvalidDataException("Unknown journal record");
            }
            if (lines.Length < 2) throw new InvalidDataException("Missing journal header");
            operation.Sequence = lines.Length - 1;
            operation.Journal.Position = operation.Journal.Length;
        }
        catch (Exception error) { throw new Failure("unknown", "Native journal cannot be trusted: " + error.Message); }
    }

    static Result Recover(Operation operation, bool rollback, string inspectionToken)
    {
        if (operation.Aborted) { MutationMayRemain = false; return Make("not_started", "Preflight refused; all owned file reservations were cleaned; any empty parent directories retained"); }
        var request = operation.Plan;
        operation.Pin(request.sourceRoot, false);
        var opened = new Dictionary<int, OpenFile>();
        var backups = new Dictionary<int, byte[]>();
        var result = Make("not_started", "No data writes were recorded");
        bool changed = false, unsafeState = false;
        try
        {
            for (int i = 0; i < request.files.Length; i++)
            {
                var item = request.files[i]; string path = Target(request, item);
                FileResult state;
                try
                {
                    operation.Pin(Path.GetDirectoryName(path), false);
                    OpenFile file;
                    try { file = new OpenFile(path, Read | Write | Delete, 3); }
                    catch (Win32Exception error) { if (error.NativeErrorCode != 2 && error.NativeErrorCode != 3) throw; file = null; }
                    if (file == null)
                    {
                        bool expectedMissing = item.action == "create" && (!operation.Intents.Contains(i) || operation.Rollbacks.Contains(i) || operation.RolledBack || operation.Aborted);
                        state = State(item, expectedMissing ? "before" : "missing", null, expectedMissing ? null : "Original is missing");
                    }
                    else
                    {
                        opened.Add(i, file);
                        string current = Hash(file.Bytes()); string identity;
                        bool known = operation.Identities.TryGetValue(i, out identity) && identity == file.Identity;
                        if (!known)
                        {
                            // Before an identity record exists, an unmodified
                            // baseline can be inspected but is never overwritten.
                            bool baseline = item.action == "modify" && !operation.Intents.Contains(i) && current == item.beforeHash;
                            state = State(item, baseline ? "before" : "diverged", current, baseline ? null : "File identity differs or reservation ownership is unknown");
                        }
                        else if (item.action == "modify" && current == item.beforeHash) state = State(item, "before", current, null);
                        else if (current == item.afterHash && operation.Intents.Contains(i) && !operation.RolledBack && !operation.Aborted) state = State(item, "after", current, null);
                        else if (item.action == "create" && current == Hash(new byte[0]) && operation.Reservations.Contains(i) && !operation.Intents.Contains(i)) state = State(item, "reserved", current, null);
                        else state = State(item, "diverged", current, "Current bytes differ; backup retained and file preserved");
                    }
                    if (state.state == "after" || state.state == "reserved")
                    {
                        changed = true;
                        if (item.action == "modify")
                        {
                            using (var backup = new OpenFile(Backup(operation, i), Read, 3))
                            {
                                byte[] bytes = backup.Bytes();
                                if (Hash(bytes) != item.beforeHash) throw new Failure("unknown", "Durable backup hash differs");
                                backups.Add(i, bytes);
                            }
                        }
                    }
                }
                catch (Failure error) { state = State(item, "unknown", null, error.Message); }
                catch (Win32Exception error) { state = State(item, "unknown", null, error.Message); }
                if (state.state == "diverged" || state.state == "missing" || state.state == "unknown") { unsafeState = true; result.conflicts.Add(item.path); }
                result.files.Add(state);
            }
            result.canRollback = changed && !unsafeState;
            if (unsafeState)
            {
                result.ok = false; result.status = "interrupted";
                result.message = "Files changed or ownership is uncertain; no rollback writes performed; backups retained";
                return result;
            }
            if (rollback)
            {
                if (!result.canRollback || !String.Equals(InspectionToken(operation, result.files, opened), inspectionToken, StringComparison.Ordinal))
                {
                    result.ok = false; result.status = "interrupted"; result.canRollback = false;
                    result.message = "Inspected rollback scope changed; no files restored. Inspect again before confirming";
                    foreach (var item in request.files) result.conflicts.Add(item.path);
                    return result;
                }
                // All current identities, hashes and backups checked while all
                // target handles remain exclusive. Never roll back a subset if
                // the preflight detects a later user edit in any target.
                for (int i = 0; i < result.files.Count; i++)
                {
                    var state = result.files[i];
                    if (state.state != "after" && state.state != "reserved") continue;
                    var file = opened[i];
                    operation.Append("rollback_intent", i, file.Identity);
                    if (request.files[i].action == "create") file.Remove();
                    else file.Replace(backups[i], i, false);
                    operation.Append("rolledback", i, file.Identity);
                    state.state = "before"; state.currentHash = request.files[i].beforeHash;
                }
                operation.Append("rollback_complete", -1, null);
                result.status = "rolled_back"; result.ok = true; result.canRollback = false;
                result.message = "Owned changes rolled back; backups and any created parent directories retained";
            }
            else if (operation.RolledBack) { result.status = "rolled_back"; result.ok = true; result.canRollback = false; result.message = "Rollback already complete"; }
            else if (operation.Applied) { result.status = "applied"; result.ok = true; result.message = "Recorded application verified against identities and hashes"; }
            else if (operation.Intents.Count != 0 || changed) { result.status = "interrupted"; result.ok = false; result.message = "Interrupted operation; inspect or rollback, never silently resumed"; }
            if (!rollback && result.canRollback) result.inspectionToken = InspectionToken(operation, result.files, opened);
            return result;
        }
        finally { foreach (var file in opened.Values) file.Dispose(); }
    }

    static Result Make(string status, string message) { return new Result { ok = status == "applied" || status == "rolled_back" || status == "not_started", status = status, message = message }; }
    static string InspectionToken(Operation operation, List<FileResult> states, Dictionary<int, OpenFile> opened)
    {
        // BinaryWriter length-prefixes every string, avoiding separator ambiguity
        // or serializer property-order differences. Bind even non-restorable
        // baseline files so a later before -> after transition cannot add scope.
        using (var stream = new MemoryStream())
        using (var writer = new BinaryWriter(stream, Utf8))
        {
            writer.Write("Astrisle rollback inspection v1");
            writer.Write(operation.Directory.ToUpperInvariant());
            writer.Write(operation.Plan.operationId);
            writer.Write(operation.PlanDigest);
            writer.Write(operation.Sequence);
            writer.Write(states.Count);
            for (int index = 0; index < states.Count; index++)
            {
                var state = states[index]; OpenFile file;
                writer.Write(index);
                writer.Write(state.path.Replace('/', '\\'));
                writer.Write(state.action);
                writer.Write(state.beforeHash ?? "");
                writer.Write(state.afterHash ?? "");
                writer.Write(state.state);
                writer.Write(state.currentHash ?? "");
                writer.Write(opened.TryGetValue(index, out file) ? file.Identity : "");
                writer.Write(state.state == "after" || state.state == "reserved");
            }
            writer.Flush(); return Hash(stream.ToArray());
        }
    }
    static FileResult State(Item item, string state, string current, string message) { return new FileResult { path = item.path, action = item.action, state = state, beforeHash = item.beforeHash, afterHash = item.afterHash, currentHash = current, message = message }; }
    static string Target(Request request, Item item) { return Path.Combine(request.sourceRoot, item.path.Replace('/', '\\')); }
    static string Backup(Operation operation, int index) { return Path.Combine(operation.Directory, "native-backup-" + index + ".bin"); }
    static string Hash(byte[] bytes) { using (var algorithm = SHA256.Create()) return BitConverter.ToString(algorithm.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(); }
    static bool IsHash(string hash) { return hash != null && Regex.IsMatch(hash, "^[a-f0-9]{64}$"); }
    static bool SamePlan(Request first, Request second)
    {
        if (first.operationId != second.operationId || !String.Equals(first.sourceRoot, second.sourceRoot, StringComparison.OrdinalIgnoreCase) || first.files.Length != second.files.Length) return false;
        for (int i = 0; i < first.files.Length; i++)
        {
            var a = first.files[i]; var b = second.files[i];
            if (!String.Equals(a.path.Replace('/', '\\'), b.path.Replace('/', '\\'), StringComparison.OrdinalIgnoreCase) || a.action != b.action || a.beforeHash != b.beforeHash || a.afterHash != b.afterHash || !String.Equals(a.candidatePath, b.candidatePath, StringComparison.OrdinalIgnoreCase)) return false;
        }
        return true;
    }
    static void Validate(Request request, string directory)
    {
        if (request == null || request.version != 1 || request.action != "apply" || String.IsNullOrWhiteSpace(request.operationId) || request.operationId.Length > 128) throw new Failure("unsupported", "Invalid immutable operation plan");
        if (!String.Equals(Absolute(request.operationDirectory), directory, StringComparison.OrdinalIgnoreCase)) throw new Failure("unsupported", "Operation directory differs");
        request.operationDirectory = directory; request.sourceRoot = Absolute(request.sourceRoot);
        if (Within(request.sourceRoot, directory) || Within(directory, request.sourceRoot)) throw new Failure("unsupported", "Operation directory and original project must be separate");
        if (request.files == null || request.files.Length == 0 || request.files.Length > 512) throw new Failure("unsupported", "Operation requires 1 to 512 files");
        var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in request.files)
        {
            if (item == null || String.IsNullOrEmpty(item.path) || Path.IsPathRooted(item.path)) throw new Failure("unsupported", "Invalid relative path");
            string normalized = item.path.Replace('/', '\\');
            foreach (string part in normalized.Split('\\')) Segment(part);
            Absolute(Target(request, item));
            if (!paths.Add(normalized)) throw new Failure("unsupported", "Case-colliding paths");
            if (item.action != "create" && item.action != "modify") throw new Failure("unsupported", "Only create and modify are supported");
            if (!IsHash(item.afterHash) || (item.action == "modify" ? !IsHash(item.beforeHash) : item.beforeHash != null)) throw new Failure("unsupported", "Invalid baseline or candidate hash");
            item.candidatePath = Absolute(item.candidatePath);
            if (!Within(item.candidatePath, directory) || String.Equals(item.candidatePath, directory, StringComparison.OrdinalIgnoreCase)) throw new Failure("unsupported", "Candidate must be inside operation directory");
            if (Path.GetFileName(item.candidatePath).StartsWith("native-", StringComparison.OrdinalIgnoreCase)) throw new Failure("unsupported", "Reserved native filename");
        }
        foreach (string first in paths) foreach (string second in paths) if (first != second && second.StartsWith(first + "\\", StringComparison.OrdinalIgnoreCase)) throw new Failure("unsupported", "File path is another file's ancestor");
    }
    static void Segment(string part)
    {
        if (String.IsNullOrEmpty(part) || part == "." || part == ".." || part.EndsWith(".", StringComparison.Ordinal) || part.EndsWith(" ", StringComparison.Ordinal) || part.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) throw new Failure("unsupported", "Unsafe path component");
        string stem = part.Split('.')[0];
        stem = stem.Replace('\u00b9', '1').Replace('\u00b2', '2').Replace('\u00b3', '3');
        if (Regex.IsMatch(stem, @"^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|CLOCK\$|COM[0-9]|LPT[0-9])$", RegexOptions.IgnoreCase) || part.Equals(".git", StringComparison.OrdinalIgnoreCase) || part.StartsWith(".astrisle", StringComparison.OrdinalIgnoreCase)) throw new Failure("unsupported", "Reserved path component");
    }
    static string Absolute(string value)
    {
        if (String.IsNullOrEmpty(value) || !Regex.IsMatch(value, "^[A-Za-z]:[\\\\/]") || value.StartsWith("\\", StringComparison.Ordinal)) throw new Failure("unsupported", "Only absolute local drive paths are supported");
        if (value.Length >= 240) throw new Failure("unsupported", "Paths of 240 characters or more are unsupported");
        string full = Path.GetFullPath(value).TrimEnd('\\');
        if (full.Length == 2) full += "\\";
        if (full.Length >= 240 || value.Substring(2).Contains(":")) throw new Failure("unsupported", "Long paths, devices and alternate streams are unsupported");
        string root = Path.GetPathRoot(full);
        if (GetDriveTypeW(root) != 3 || !String.Equals(new DriveInfo(root).DriveFormat, "NTFS", StringComparison.OrdinalIgnoreCase)) throw new Failure("unsupported", "Only local fixed NTFS volumes are supported");
        foreach (string part in full.Substring(root.Length).Split(new char[] { '\\' }, StringSplitOptions.RemoveEmptyEntries))
        {
            if (part.EndsWith(".", StringComparison.Ordinal) || part.EndsWith(" ", StringComparison.Ordinal) || part.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) throw new Failure("unsupported", "Unsafe absolute path component");
        }
        return full;
    }
    static bool Within(string path, string root) { return path.Equals(root, StringComparison.OrdinalIgnoreCase) || path.StartsWith(root.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase); }
    static void VerifyFinal(SafeFileHandle handle, string expected)
    {
        var buffer = new StringBuilder(1024);
        uint length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
        if (length == 0 || length >= buffer.Capacity) throw new Failure("unsupported", "Cannot verify final handle path");
        string final = buffer.ToString(); if (final.StartsWith("\\\\?\\", StringComparison.Ordinal)) final = final.Substring(4);
        if (!String.Equals(final.TrimEnd('\\'), expected.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) throw new Failure("unsupported", "Final handle path differs (alias, reparse or race)");
    }
    static void Ordinary(FileInformation info, bool directory)
    {
        if ((info.Attributes & 0x400) != 0 || ((info.Attributes & 0x10) != 0) != directory || (!directory && (info.NumberOfLinks != 1 || (info.Attributes & (0x40 | 0x1000 | 0x4000)) != 0))) throw new Failure("unsupported", "Reparse points, hardlinks and nonordinary files are unsupported");
    }
    static string Id(FileInformation info) { return info.VolumeSerialNumber.ToString("x8") + ":" + info.FileIndexHigh.ToString("x8") + info.FileIndexLow.ToString("x8"); }
    static FileInformation Information(SafeFileHandle handle) { FileInformation info; Check(GetFileInformationByHandle(handle, out info), "Read handle identity"); return info; }
    // Every non-volume-root open is relative to an already-open directory. A
    // share lock alone does not prevent attribute-only reparse setters. NT root
    // handles anchor the lookup even if an ancestor name changes into a junction.
    static SafeFileHandle NativeOpen(string path, uint access, uint share, uint disposition, uint flags)
    {
        if (path.Length >= 240) throw new Failure("unsupported", "Paths of 240 characters or more are unsupported");
        string root = Path.GetPathRoot(path);
        if (String.Equals(path.TrimEnd('\\'), root.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
        {
            var rootHandle = CreateFileW(root, access, share, IntPtr.Zero, disposition, flags, IntPtr.Zero);
            if (rootHandle.IsInvalid) { int error = Marshal.GetLastWin32Error(); rootHandle.Dispose(); throw new Win32Exception(error, "Open volume root"); }
            return rootHandle;
        }
        string parent = Path.GetDirectoryName(path);
        SafeFileHandle parentHandle;
        if (!DirectoryPins.TryGetValue(parent, out parentHandle)) throw new Failure("unsupported", "Parent directory is not anchored: " + parent);
        Ordinary(Information(parentHandle), true);
        string leaf = Path.GetFileName(path);
        IntPtr nameBuffer = Marshal.StringToHGlobalUni(leaf);
        IntPtr namePointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString)));
        try
        {
            var name = new UnicodeString { Length = checked((ushort)(leaf.Length * 2)), MaximumLength = checked((ushort)((leaf.Length + 1) * 2)), Buffer = nameBuffer };
            Marshal.StructureToPtr(name, namePointer, false);
            var attributes = new ObjectAttributes { Length = Marshal.SizeOf(typeof(ObjectAttributes)), RootDirectory = parentHandle.DangerousGetHandle(), ObjectName = namePointer, Attributes = 0x1040 };
            IoStatus io; IntPtr raw;
            uint options = 0x00200020; // OPEN_REPARSE_POINT | SYNCHRONOUS_IO_NONALERT
            if ((flags & BackupSemantics) != 0) options |= 1; // DIRECTORY_FILE
            else options |= 0x40; // NON_DIRECTORY_FILE
            uint creation = disposition == 1 ? 2u : disposition == 4 ? 3u : 1u;
#if TEST_HOOKS
            if (String.Equals(path, PauseBeforeOpen, StringComparison.OrdinalIgnoreCase)) { PauseBeforeOpen = null; Checkpoint("before_native_open"); }
#endif
            int status = NtCreateFile(out raw, access | 0x00100080, ref attributes, out io, IntPtr.Zero, 0x80, share, creation, options, IntPtr.Zero, 0);
            if (status < 0) throw new Win32Exception((int)RtlNtStatusToDosError(status), "Anchored open " + path);
            return new SafeFileHandle(raw, true);
        }
        finally { Marshal.FreeHGlobal(namePointer); Marshal.FreeHGlobal(nameBuffer); }
    }
    static FileStream NewStream(string path)
    {
        var handle = NativeOpen(path, Read | Write, 0, 1, OpenReparse);
        try { Ordinary(Information(handle), false); VerifyFinal(handle, path); return new FileStream(handle, FileAccess.ReadWrite); }
        catch { handle.Dispose(); throw; }
    }
    static void DurableNew(string path, byte[] bytes) { using (var stream = NewStream(path)) { stream.Write(bytes, 0, bytes.Length); stream.Flush(true); Check(FlushFileBuffers(stream.SafeFileHandle), "Flush native state"); } }
    static void Check(bool success, string operation) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), operation); }
    static string ReadLine(int maximum)
    {
        var line = new StringBuilder(); int ch;
        while ((ch = Console.In.Read()) != -1 && ch != '\n') { if (line.Length >= maximum) throw new Failure("unsupported", "Control line too large"); line.Append((char)ch); }
        return line.ToString();
    }
    static void Checkpoint(string name)
    {
#if TEST_HOOKS
        Console.Error.Write("checkpoint:" + name + "\n"); Console.Error.Flush(); Console.In.ReadLine();
#endif
    }
#if TEST_HOOKS
    static string PauseBeforeOpen;
#endif
    [StructLayout(LayoutKind.Sequential)] struct FileInformation { public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime, LastAccessTime, LastWriteTime; public uint VolumeSerialNumber, FileSizeHigh, FileSizeLow, NumberOfLinks, FileIndexHigh, FileIndexLow; }
    [StructLayout(LayoutKind.Sequential)] struct FileDisposition { [MarshalAs(UnmanagedType.U1)] public bool DeleteFile; }
    [StructLayout(LayoutKind.Sequential)] struct UnicodeString { public ushort Length, MaximumLength; public IntPtr Buffer; }
    [StructLayout(LayoutKind.Sequential)] struct ObjectAttributes { public int Length; public IntPtr RootDirectory, ObjectName; public uint Attributes; public IntPtr SecurityDescriptor, SecurityQualityOfService; }
    [StructLayout(LayoutKind.Sequential)] struct IoStatus { public IntPtr Status; public UIntPtr Information; }
    [DllImport("ntdll.dll")] static extern int NtCreateFile(out IntPtr handle, uint access, ref ObjectAttributes attributes, out IoStatus io, IntPtr allocation, uint fileAttributes, uint share, uint disposition, uint options, IntPtr ea, uint eaLength);
    [DllImport("ntdll.dll")] static extern uint RtlNtStatusToDosError(int status);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation info);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern uint GetDriveTypeW(string root);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool FlushFileBuffers(SafeFileHandle handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetFileInformationByHandle(SafeFileHandle handle, int informationClass, ref FileDisposition info, uint size);
}
